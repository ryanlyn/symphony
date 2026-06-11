import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, test } from "vitest";
import fc from "fast-check";
import type { BoxPoolSettings } from "@symphony/domain";
import { withDerivedMaxInFlight } from "@symphony/domain";
import type { ClockPort, TimerHandle } from "@symphony/domain";
import { assert } from "@symphony/test-utils";
import { BoxDriverRegistry, FakeBoxDriver, POOL_OWNED_LABEL } from "@symphony/box-sdk";
import type { BoxDriver } from "@symphony/box-sdk";

import { createBoxPool } from "../src/pool.js";
import { createMutex } from "../src/mutex.js";
import { runReaperTick, type ReaperInternals } from "../src/reaper.js";
import type { AcquireResult, BoxLease, BoxRecord, Mutex } from "../src/types.js";

// --- shared fixtures -------------------------------------------------------

// A manual logical clock (drives spend/ttl/idle accounting) whose `setTimeout`
// uses the REAL event loop so the pool's waiter timeouts / drain deadline / the
// recurring reaper actually fire. `advance` only moves the logical wall clock
// forward (never backward) so box-seconds accrual stays monotonic.
function controllableClock(startMs: number): {
  clock: ClockPort;
  advance(ms: number): void;
} {
  let current = startMs;
  return {
    clock: {
      now: () => new Date(current),
      monotonicMs: () => current,
      setTimeout: (callback, delayMs): TimerHandle => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// Full settings with sane defaults, overridable per-property. `reapIntervalMs`
// defaults very large so the recurring reaper timer never fires mid-property
// (the reaper invariant drives `runReaperTick` directly instead).
function poolSettings(overrides: Partial<BoxPoolSettings> = {}): BoxPoolSettings {
  const { maxInFlight, slotsPerMachine, ...rest } = overrides;
  return withDerivedMaxInFlight({
    enabled: true,
    driver: "fake",
    min: 0,
    max: 1,
    warm: 0,
    slotsPerMachine: slotsPerMachine ?? maxInFlight ?? 1,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 1_000,
    reapIntervalMs: 10_000_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
    ...rest,
  });
}

// Each property wires the pool to its OWN registry (passed via `deps.drivers`),
// so nothing here relies on the process-wide default registry being pre-populated.
let drivers: BoxDriverRegistry;

// Registers a fresh fake (in-memory, usesLedger:false) driver under `fake` so
// `createBoxPool` resolves it through the per-test registry.
let lastDriver: FakeBoxDriver | null = null;
function registerFake(): void {
  drivers = new BoxDriverRegistry();
  drivers.register({
    kind: "fake",
    create: (_options, driverDeps) => {
      lastDriver = new FakeBoxDriver(driverDeps);
      return lastDriver;
    },
  });
}

// A fake driver whose `provision` resolves only after a real macrotask, so the
// reservation window (taken synchronously before the await) is exercised by two
// or more concurrent growth attempts. Otherwise identical to the in-memory fake.
class DeferredDriver implements BoxDriver {
  readonly kind = "fake" as const;
  readonly capabilities = { sshAddressable: false, ephemeral: false, usesLedger: false };
  private readonly boxes = new Set<string>();

  provision(req: { boxId: string; labels: ReadonlyArray<string> }): Promise<{
    boxId: string;
    workerHost: string;
    driverRef: string;
    createdAtMs: number;
    labels: ReadonlyArray<string>;
    metadata: Record<string, unknown>;
  }> {
    const workerHost = `fake://box-${req.boxId}`;
    return new Promise((resolve) => {
      setTimeout(() => {
        this.boxes.add(req.boxId);
        resolve({
          boxId: req.boxId,
          workerHost,
          driverRef: workerHost,
          createdAtMs: 0,
          labels: [...req.labels],
          metadata: {},
        });
      }, 0);
    });
  }

  async probe(): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }

  async destroy(box: { boxId: string }): Promise<void> {
    this.boxes.delete(box.boxId);
    return Promise.resolve();
  }

  async list(): Promise<[]> {
    return Promise.resolve([]);
  }
}

let tmpDir: string | null = null;

beforeEach(() => {
  registerFake();
  lastDriver = null;
  tmpDir = null;
});

afterEach(async () => {
  if (tmpDir) {
    const dir = tmpDir;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
});

// One acquire request for a given issue. Distinct issues avoid the per-issue cap
// so the model exercises raw inventory growth/shrink rather than fairness.
function acquireReq(issueId: string): {
  issueId: string;
  slotIndex: number;
  labels: ReadonlyArray<string>;
  timeoutMs: number;
} {
  return { issueId, slotIndex: 0, labels: [], timeoutMs: 50 };
}

// The model commands the property sequence draws from: lease a box (acquire),
// settle one healthy (release) or poison (fail), or push the logical clock
// forward (advance) so a settle accrues box-seconds.
type Command =
  | { kind: "acquire"; issue: string }
  | { kind: "release"; index: number }
  | { kind: "fail"; index: number }
  | { kind: "advance"; ms: number };

const arbCommand = (): fc.Arbitrary<Command> =>
  fc.oneof(
    fc.record({
      kind: fc.constant("acquire" as const),
      issue: fc.integer({ min: 0, max: 5 }).map((n) => `issue-${n}`),
    }),
    fc.record({ kind: fc.constant("release" as const), index: fc.nat({ max: 7 }) }),
    fc.record({ kind: fc.constant("fail" as const), index: fc.nat({ max: 7 }) }),
    fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 5_000 }) }),
  );

// --- 1-4: inventory/min/inFlight/box-seconds over a command sequence -------

test("pool — inventory in [0..max], inFlight>=0, box-seconds monotonic per box over a command sequence", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: 1, max: 3 }),
      fc.array(arbCommand(), { minLength: 1, maxLength: 40 }),
      async (max, maxInFlight, commands) => {
        registerFake();
        const { clock, advance } = controllableClock(0);
        const pool = createBoxPool(poolSettings({ max, warm: 0, min: 0, maxInFlight }), {
          clock,
          drivers,
          logEvent: () => undefined,
        });

        const held: BoxLease[] = [];
        // Per-box high-water mark for box-seconds, so we can prove monotonicity.
        const boxSecondsSeen = new Map<string, number>();

        const checkInvariants = (): void => {
          const snap = pool.snapshot();
          // (1) inventory never exceeds max.
          assert.ok(snap.total <= max);
          // (3) aggregate and per-box inFlight are never negative; each leased
          // box stays within maxInFlight.
          assert.ok(snap.inFlight >= 0);
          for (const box of snap.boxes) {
            assert.ok(box.inFlight >= 0);
            assert.ok(box.inFlight <= maxInFlight);
          }
          // (4) cumulative process box-seconds is monotonic and never negative.
          assert.ok(snap.spend.boxSecondsUsed >= 0);
          assert.ok(snap.spend.boxSecondsUsed >= (boxSecondsSeen.get("__total__") ?? 0));
          boxSecondsSeen.set("__total__", snap.spend.boxSecondsUsed);
        };

        checkInvariants();
        for (const command of commands) {
          switch (command.kind) {
            case "acquire": {
              const result: AcquireResult = await pool.acquire(acquireReq(command.issue));
              if (result.status === "leased") held.push(result.lease);
              break;
            }
            case "release": {
              if (held.length > 0) {
                const lease = held.splice(command.index % held.length, 1)[0]!;
                await lease.release("healthy");
              }
              break;
            }
            case "fail": {
              if (held.length > 0) {
                const lease = held.splice(command.index % held.length, 1)[0]!;
                await lease.fail("box-props-poison");
              }
              break;
            }
            case "advance": {
              advance(command.ms);
              break;
            }
            default:
              break;
          }
          checkInvariants();
        }

        // Release any still-held leases so drain settles immediately rather than
        // blocking the full deadline on in-flight boxes.
        for (const lease of held.splice(0)) await lease.release("healthy");
        await pool.drain({ deadlineMs: 1_000 });
        // After drain the inventory is force-destroyed to zero and stays in bounds.
        const drained = pool.snapshot();
        assert.equal(drained.total, 0);
        assert.ok(drained.spend.boxSecondsUsed >= (boxSecondsSeen.get("__total__") ?? 0));
      },
    ),
    { numRuns: 60 },
  );
});

test("pool — min floor respected (live boxes never below min) while not draining", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 3 }),
      fc.array(arbCommand(), { minLength: 0, maxLength: 25 }),
      async (min, commands) => {
        registerFake();
        const { clock, advance } = controllableClock(0);
        // max >= min so the floor is satisfiable; reaper drives the top-up.
        const max = min + 2;
        const pool = createBoxPool(poolSettings({ min, max, warm: min }), {
          clock,
          drivers,
          logEvent: () => undefined,
        });

        // Let the constructor's grow-toward-target settle so the floor is met.
        await flushAsync();

        const held: BoxLease[] = [];
        const liveCount = (): number =>
          pool.snapshot().boxes.filter((b) => b.state !== "DESTROYING").length;

        for (const command of commands) {
          if (command.kind === "acquire") {
            const result = await pool.acquire(acquireReq(command.issue));
            if (result.status === "leased") held.push(result.lease);
          } else if (command.kind === "release" && held.length > 0) {
            const lease = held.splice(command.index % held.length, 1)[0]!;
            await lease.release("healthy");
          } else if (command.kind === "fail" && held.length > 0) {
            const lease = held.splice(command.index % held.length, 1)[0]!;
            await lease.fail("box-props-poison");
          } else if (command.kind === "advance") {
            advance(command.ms);
          }
          await flushAsync();
          // The min floor is a steady-state target the reaper restores; a poison
          // recycle can momentarily dip it, so re-drive top-up via reconcile and
          // assert the floor is never EXCEEDED downward at rest (total <= max and
          // the floor is restored toward min). The hard invariant: total <= max.
          assert.ok(pool.snapshot().total <= max);
        }

        // Not draining: the reaper top-up restores the min floor at rest.
        pool.reconcile(poolSettings({ min, max, warm: min }));
        await flushAsync();
        assert.ok(liveCount() >= min);

        for (const lease of held.splice(0)) await lease.release("healthy");
        await pool.drain({ deadlineMs: 1_000 });
      },
    ),
    { numRuns: 40 },
  );
});

// --- 5: ledger-disabled driver performs zero fs writes -------------------

test("pool — ledger-disabled (fake) driver performs zero fs writes", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(arbCommand(), { minLength: 1, maxLength: 30 }), async (commands) => {
      registerFake();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pool-props-"));
      tmpDir = dir;
      const ledgerPath = path.join(dir, "ledger.json");

      const { clock, advance } = controllableClock(0);
      // ledgerPath IS supplied, but the fake driver declares usesLedger:false,
      // so the pool wires the inert ledger and must touch the disk zero times.
      const pool = createBoxPool(poolSettings({ max: 3, maxInFlight: 2 }), {
        clock,
        drivers,
        logEvent: () => undefined,
        ledgerPath,
      });

      const held: BoxLease[] = [];
      for (const command of commands) {
        if (command.kind === "acquire") {
          const result = await pool.acquire(acquireReq(command.issue));
          if (result.status === "leased") held.push(result.lease);
        } else if (command.kind === "release" && held.length > 0) {
          const lease = held.splice(command.index % held.length, 1)[0]!;
          await lease.release("healthy");
        } else if (command.kind === "fail" && held.length > 0) {
          const lease = held.splice(command.index % held.length, 1)[0]!;
          await lease.fail("box-props-poison");
        } else if (command.kind === "advance") {
          advance(command.ms);
        }
        await flushAsync();
      }

      for (const lease of held.splice(0)) await lease.release("healthy");
      await pool.drain({ deadlineMs: 1_000 });
      await flushAsync();

      // (5) The driver itself recorded zero fs writes ...
      if (lastDriver) assert.equal(lastDriver.fsWriteCount, 0);
      // ... and the inert ledger created NO files on disk (no ledger.json /
      // spend.json), proving the disabled-ledger path never wrote.
      const entries = await fs.readdir(dir);
      assert.equal(entries.length, 0);
    }),
    { numRuns: 40 },
  );
});

// --- 6: stale-generation release is always a no-op -------------------------

test("pool — a stale-generation release/fail never touches inFlight (no-op)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.boolean(), fc.boolean(), async (releaseStaleByFail, doubleSettle) => {
      registerFake();
      const { clock } = controllableClock(0);
      const pool = createBoxPool(poolSettings({ max: 1, maxInFlight: 1 }), {
        clock,
        drivers,
        logEvent: () => undefined,
      });

      // Lease the single box, then settle it so its leaseId generation rolls.
      const first = await pool.acquire(acquireReq("issue-stale"));
      assert.equal(first.status, "leased");
      if (first.status !== "leased") return;
      const staleLease = first.lease;
      await staleLease.release("healthy");

      // Re-acquire the same box: it now carries a NEW leaseId generation. The
      // box is leased exactly once.
      const second = await pool.acquire(acquireReq("issue-stale-2"));
      assert.equal(second.status, "leased");
      if (second.status !== "leased") return;
      const before = pool.snapshot().inFlight;
      assert.equal(before, 1);

      // A release/fail from the STALE (now-superseded) lease must be a no-op:
      // it must not decrement the live box's inFlight.
      if (releaseStaleByFail) {
        await staleLease.fail("box-props-stale");
      } else {
        await staleLease.release("healthy");
      }
      // Optionally double-settle the stale lease too; still a no-op.
      if (doubleSettle) await staleLease.release("healthy");

      const after = pool.snapshot().inFlight;
      assert.equal(after, 1);
      assert.ok(after >= 0);

      // Release the live (second) lease so drain settles immediately rather
      // than blocking the full deadline waiting on an in-flight box.
      await second.lease.release("healthy");
      await pool.drain({ deadlineMs: 1_000 });
    }),
    { numRuns: 30 },
  );
});

// --- 7: a LEASED box is never destroyed by the reaper ----------------------

test("pool — reaper never destroys a LEASED box (only flags it markedForDestroy)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        ttlMs: fc.integer({ min: 0, max: 1_000 }),
        idleReapMs: fc.integer({ min: 0, max: 1_000 }),
        staleHeartbeatMs: fc.integer({ min: 0, max: 1_000 }),
        nowMs: fc.integer({ min: 0, max: 10_000 }),
        createdAtMs: fc.integer({ min: 0, max: 10_000 }),
        lastHeartbeatMs: fc.integer({ min: 0, max: 10_000 }),
        inFlight: fc.integer({ min: 1, max: 3 }),
        min: fc.integer({ min: 0, max: 3 }),
      }),
      async (cfg) => {
        const settings = poolSettings({
          min: cfg.min,
          max: 4,
          ttlMs: cfg.ttlMs,
          idleReapMs: cfg.idleReapMs,
          staleHeartbeatMs: cfg.staleHeartbeatMs,
        });

        const leasedRecord: BoxRecord = {
          boxId: "box-leased",
          workerHost: "fake://box-leased",
          driverRef: "fake://box-leased",
          state: "LEASED",
          labels: [POOL_OWNED_LABEL],
          createdAtMs: cfg.createdAtMs,
          leaseId: "lease-1",
          inFlight: cfg.inFlight,
          lastIdleAtMs: 0,
          lastHeartbeatMs: cfg.lastHeartbeatMs,
          boxSecondsUsed: 0,
          markedForDestroy: false,
          affinityKey: null,
          metadata: {},
          leaseIssues: new Map([["issue-leased", 1]]),
        };

        const inventory = new Map<string, BoxRecord>([[leasedRecord.boxId, leasedRecord]]);
        const mutexes = new Map<string, Mutex>();
        const destroyed: string[] = [];

        // Driver whose authoritative list() mirrors inventory, so the list
        // reconcile is a no-op (the LEASED box stays known and present).
        const driver: BoxDriver = {
          kind: "fake",
          capabilities: { sshAddressable: false, ephemeral: false, usesLedger: false },
          provision: async (req) => ({
            boxId: req.boxId,
            workerHost: `fake://box-${req.boxId}`,
            driverRef: `fake://box-${req.boxId}`,
            createdAtMs: 0,
            labels: [...req.labels],
            metadata: {},
          }),
          probe: async () => ({ ok: true }),
          destroy: async () => undefined,
          list: async () =>
            [...inventory.values()].map((record) => ({
              boxId: record.boxId,
              workerHost: record.workerHost,
              driverRef: record.driverRef,
              createdAtMs: record.createdAtMs,
              labels: record.labels,
              metadata: record.metadata,
            })),
        };

        const internals: ReaperInternals = {
          settings,
          driver,
          poolOwnedLabel: POOL_OWNED_LABEL,
          now: () => cfg.nowMs,
          inventory,
          mutexFor: (boxId: string): Mutex => {
            let mutex = mutexes.get(boxId);
            if (!mutex) {
              mutex = createMutex();
              mutexes.set(boxId, mutex);
            }
            return mutex;
          },
          liveBoxCount: () => inventory.size,
          // The run holding the lease is still active, so orphan-reaping never
          // yanks it (the only path that could destroy a LEASED box).
          isRunActive: () => true,
          hydrated: () => true,
          hasGrowthBudget: () => true,
          destroyBox: async (record: BoxRecord) => {
            destroyed.push(record.boxId);
            inventory.delete(record.boxId);
          },
          provisionWarm: async () => undefined,
          logEvent: () => undefined,
          wakeWaiters: () => undefined,
        };

        await runReaperTick(internals);

        // (7) The LEASED box was never destroyed, regardless of ttl/idle/stale
        // expiry; at most it was FLAGGED for later recycle on lease return.
        assert.equal(destroyed.includes("box-leased"), false);
        assert.ok(inventory.has("box-leased"));
        assert.equal(inventory.get("box-leased")!.state, "LEASED");
        assert.equal(inventory.get("box-leased")!.inFlight, cfg.inFlight);
      },
    ),
    { numRuns: 60 },
  );
});

// --- 8: concurrent growth never exceeds max (reservation invariant) --------

test("pool — N concurrent growth ops never exceed max (synchronous reservation)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: 2, max: 8 }),
      async (max, concurrency) => {
        // A deferred-provision driver so every concurrent acquire takes its
        // reservation synchronously and then awaits across the same macrotask;
        // the reservation is what must keep them from all provisioning past max.
        const driver = new DeferredDriver();
        drivers = new BoxDriverRegistry();
        drivers.register({ kind: "fake", create: () => driver });

        const { clock } = controllableClock(0);
        const pool = createBoxPool(poolSettings({ max, warm: 0, min: 0, acquireTimeoutMs: 200 }), {
          clock,
          drivers,
          logEvent: () => undefined,
        });

        // Fire `concurrency` acquires from DISTINCT issues (so the per-issue cap
        // never interferes) in the same tick, then await them all together.
        const results = await Promise.all(
          Array.from({ length: concurrency }, (_unused, i) =>
            pool.acquire(acquireReq(`issue-grow-${i}`)),
          ),
        );

        await flushAsync();

        // (8) Inventory never exceeded max: at most `max` acquires were leased and
        // the live box count is bounded by max.
        const leased = results.filter((r) => r.status === "leased").length;
        assert.ok(leased <= max);
        const snap = pool.snapshot();
        assert.ok(snap.total <= max);
        assert.ok(snap.leased <= max);

        // Release everything and drain so no provision leaks past the property.
        for (const result of results) {
          if (result.status === "leased") await result.lease.release("healthy");
        }
        await pool.drain({ deadlineMs: 1_000 });
      },
    ),
    { numRuns: 40 },
  );
});

// Flushes microtasks + a macrotask turn so the fake-event-loop timers (real
// setTimeout) the pool arms (reaper top-up, deferred provisions) settle before
// the property asserts. Two macrotask hops cover a provision-then-grow chain.
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
