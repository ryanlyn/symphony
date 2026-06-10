import { afterEach, beforeEach, test } from "vitest";
import type { BoxPoolSettings } from "@symphony/domain";
import type { ClockPort, TimerHandle } from "@symphony/ports";

import { assert } from "../../../test/assert.js";
import { createBoxPool } from "../src/pool.js";
import { FakeBoxProvider } from "../src/providers/fake.js";
import { runReaperTick, type ReaperInternals } from "../src/reaper.js";
import { clearBoxProviderRegistry, registerBoxProvider } from "../src/registry.js";
import { createMutex } from "../src/mutex.js";
import type { BoxProvider, BoxRecord, Mutex } from "../src/types.js";

// --- shared fixtures -------------------------------------------------------

function controllableClock(startMs: number): {
  clock: ClockPort;
  advance(ms: number): void;
} {
  let current = startMs;
  return {
    clock: {
      now: () => new Date(current),
      setTimeout: (callback, delayMs): TimerHandle => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

function poolSettings(overrides: Partial<BoxPoolSettings> = {}): BoxPoolSettings {
  return {
    enabled: true,
    provider: "fake",
    min: 0,
    max: 4,
    warm: 0,
    maxInFlight: 1,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 1_000,
    reapIntervalMs: 15_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
    ...overrides,
  };
}

let lastProvider: FakeBoxProvider | null = null;
function registerFake(): void {
  registerBoxProvider("fake", (_settings, deps) => {
    lastProvider = new FakeBoxProvider(deps);
    return lastProvider;
  });
}

beforeEach(() => {
  clearBoxProviderRegistry();
  registerFake();
  lastProvider = null;
});

afterEach(() => {
  clearBoxProviderRegistry();
});

// Builds a BoxRecord seeded into a hand-rolled inventory for the unit-level
// reaper tests (so a test controls state/heartbeats/inFlight precisely without
// driving the whole acquire path).
function makeRecord(overrides: Partial<BoxRecord> = {}): BoxRecord {
  const boxId = overrides.boxId ?? "box-0";
  const workerHost = overrides.workerHost ?? `fake://box-${boxId}`;
  return {
    boxId,
    workerHost,
    providerRef: workerHost,
    state: "WARM_IDLE",
    labels: ["symphony.pool=worker-box-pool"],
    createdAtMs: 0,
    leaseId: null,
    inFlight: 0,
    lastIdleAtMs: 0,
    lastHeartbeatMs: 0,
    boxSecondsUsed: 0,
    markedForDestroy: false,
    affinityKey: null,
    metadata: {},
    leaseIssues: new Map<string, number>(),
    ...overrides,
  };
}

// A minimal ReaperInternals over a hand-rolled inventory + the fake provider, so
// the reaper logic is exercised in isolation. Tracks destroy calls and provisions
// so a test can assert exactly which boxes were torn down or topped up.
function makeInternals(
  settings: BoxPoolSettings,
  records: BoxRecord[],
  options: {
    provider?: BoxProvider;
    isRunActive?: (record: BoxRecord) => boolean;
    poolOwnedLabel?: string;
    liveBoxCount?: () => number;
  } = {},
): {
  internals: ReaperInternals;
  inventory: Map<string, BoxRecord>;
  mutexes: Map<string, Mutex>;
  destroyed: string[];
  provisioned: string[];
} {
  const inventory = new Map<string, BoxRecord>();
  for (const record of records) inventory.set(record.boxId, record);
  const mutexes = new Map<string, Mutex>();
  const destroyed: string[] = [];
  const provisioned: string[] = [];

  // Default provider whose authoritative `list()` mirrors the live inventory, so
  // the list() reconcile is a no-op for the ttl/idle/orphan/top-up unit tests
  // (which only want to exercise those paths). Tests that need provider-vs-pool
  // DIVERGENCE pass their own provider via `options.provider`.
  const inventoryMirrorProvider: BoxProvider = {
    kind: "fake",
    capabilities: { sshAddressable: false, ephemeral: false, usesLedger: false },
    provision: async (req) => ({
      boxId: req.boxId,
      workerHost: `fake://box-${req.boxId}`,
      providerRef: `fake://box-${req.boxId}`,
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
        providerRef: record.providerRef,
        createdAtMs: record.createdAtMs,
        labels: record.labels,
        metadata: record.metadata,
      })),
  };
  const provider = options.provider ?? inventoryMirrorProvider;

  const internals: ReaperInternals = {
    settings,
    provider,
    poolOwnedLabel: options.poolOwnedLabel ?? "symphony.pool=worker-box-pool",
    now: () => 0,
    inventory,
    mutexFor: (boxId: string): Mutex => {
      let mutex = mutexes.get(boxId);
      if (!mutex) {
        mutex = createMutex();
        mutexes.set(boxId, mutex);
      }
      return mutex;
    },
    liveBoxCount: options.liveBoxCount ?? (() => inventory.size),
    isRunActive: options.isRunActive ?? (() => true),
    hydrated: () => true,
    hasGrowthBudget: () => true,
    destroyBox: async (record: BoxRecord) => {
      destroyed.push(record.boxId);
      inventory.delete(record.boxId);
      mutexes.delete(record.boxId);
    },
    provisionWarm: async () => {
      const id = `warm-${provisioned.length}`;
      provisioned.push(id);
      inventory.set(id, makeRecord({ boxId: id }));
    },
    logEvent: () => undefined,
    wakeWaiters: () => undefined,
  };
  return { internals, inventory, mutexes, destroyed, provisioned };
}

// --- ttl / idle reaping ----------------------------------------------------

test("ttl-exceeded WARM_IDLE above min is destroyed", async () => {
  const settings = poolSettings({ min: 0, ttlMs: 1_000 });
  const record = makeRecord({ state: "WARM_IDLE", createdAtMs: 0, lastIdleAtMs: 0 });
  const { internals, inventory, destroyed } = makeInternals(settings, [record]);
  internals.now = () => 2_000; // 2s past createdAt, ttl is 1s

  await runReaperTick(internals);

  assert.deepEqual(destroyed, ["box-0"]);
  assert.equal(inventory.size, 0);
});

test("idle-exceeded above min destroyed; min floor respected", async () => {
  const settings = poolSettings({ min: 1, idleReapMs: 1_000, ttlMs: 1_000_000 });
  // Two idle boxes both past idle window, but min=1 so exactly one survives.
  const a = makeRecord({ boxId: "box-0", state: "WARM_IDLE", lastIdleAtMs: 0 });
  const b = makeRecord({ boxId: "box-1", state: "WARM_IDLE", lastIdleAtMs: 0 });
  const { internals, inventory, destroyed } = makeInternals(settings, [a, b]);
  internals.now = () => 5_000; // both well past the 1s idle window

  await runReaperTick(internals);

  // Only one box reaped; the min=1 floor keeps the other alive.
  assert.equal(destroyed.length, 1);
  assert.equal(inventory.size, 1);
});

test("LEASED past ttl is flagged markedForDestroy, NOT yanked, recycled when inFlight->0 inside mutex", async () => {
  // Drive the real pool so the flag-then-recycle-on-settle path (including the
  // per-box mutex coordination) is exercised end to end. The reaper flags a
  // LEASED box past ttl but never yanks it mid-run; the pool's lease-settle
  // recycles it the instant the last lease returns.
  const { clock, advance } = controllableClock(0);
  const pool = createBoxPool(
    poolSettings({
      min: 0,
      warm: 0,
      max: 1,
      ttlMs: 1_000,
      idleReapMs: 1_000_000,
      reapIntervalMs: 10,
    }),
    { clock, logEvent: () => undefined },
  );

  const leased = await pool.acquire({
    issueId: "issue-1",
    slotIndex: 0,
    labels: [],
    timeoutMs: 1_000,
  });
  assert.equal(leased.status, "leased");
  if (leased.status !== "leased") return;

  // Advance past ttl and let a reaper tick fire. The box is LEASED so it is only
  // flagged, never destroyed mid-run.
  advance(2_000);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  let snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.leased, 1);
  const flagged = snap.boxes.find((b) => b.boxId === leased.lease.boxId);
  assert.ok(flagged);
  assert.equal(flagged?.markedForDestroy, true);

  // The lease returns: the flagged box is recycled exactly once (inFlight->0
  // inside the per-box mutex), so it never underflows and is fully gone.
  await leased.lease.release("healthy");
  snap = pool.snapshot();
  assert.equal(snap.total, 0);
  assert.equal(snap.inFlight, 0);
  await pool.drain({ deadlineMs: 100 });
});

// --- probe / DEGRADED ------------------------------------------------------

test("probe failure on long-idle demotes to DEGRADED then DESTROYING", async () => {
  const { clock } = controllableClock(0);
  const provider = new FakeBoxProvider({ clock, logEvent: () => undefined });
  // Provision a box into the provider so probe has something to flip to failing.
  await provider.provision({ boxId: "box-0", labels: [], timeoutMs: 1_000 });
  provider.injectProbeFailure("box-0", "unreachable");

  const settings = poolSettings({ min: 0, idleReapMs: 1_000, ttlMs: 1_000_000 });
  const record = makeRecord({ state: "WARM_IDLE", lastIdleAtMs: 0, lastHeartbeatMs: 0 });
  const { internals, inventory, destroyed } = makeInternals(settings, [record], { provider });
  // Within idle window so idle-reap does NOT fire; the demotion path runs.
  internals.now = () => 500;

  await runReaperTick(internals);

  // A probe-failed box is demoted and then torn down (no point keeping a dead box).
  assert.deepEqual(destroyed, ["box-0"]);
  assert.equal(inventory.size, 0);
});

// --- orphan vs alive -------------------------------------------------------

test("ORPHAN: stale-heartbeat lease whose run is gone is force-returned, clearing lease table AND decrementing inFlight", async () => {
  const settings = poolSettings({ min: 0, staleHeartbeatMs: 1_000, ttlMs: 1_000_000 });
  const record = makeRecord({
    state: "LEASED",
    inFlight: 1,
    leaseId: "lease-1",
    lastHeartbeatMs: 0,
  });
  // The run is GONE (not active) => orphan.
  const { internals, inventory, destroyed } = makeInternals(settings, [record], {
    isRunActive: () => false,
  });
  internals.now = () => 5_000; // heartbeat 5s old, stale threshold 1s

  await runReaperTick(internals);

  // The orphaned lease is force-returned: inFlight cleared, lease table cleared,
  // and the box recycled (a box that hosted an orphan is not trusted).
  assert.equal(record.inFlight <= 0 ? 0 : record.inFlight, 0);
  assert.deepEqual(destroyed, ["box-0"]);
  assert.equal(inventory.size, 0);
});

test("ALIVE: long single-turn run past staleHeartbeatMs but still active is NOT destroyed", async () => {
  const settings = poolSettings({ min: 0, staleHeartbeatMs: 1_000, ttlMs: 1_000_000 });
  const record = makeRecord({
    state: "LEASED",
    inFlight: 1,
    leaseId: "lease-1",
    lastHeartbeatMs: 0,
  });
  // The run is STILL ACTIVE (a long single turn emits no heartbeat) => NOT orphan.
  const { internals, inventory, destroyed } = makeInternals(settings, [record], {
    isRunActive: () => true,
  });
  internals.now = () => 5_000; // heartbeat 5s old but the run is alive

  await runReaperTick(internals);

  // A long-but-alive run is left untouched: no destroy, inFlight preserved.
  assert.equal(destroyed.length, 0);
  assert.equal(inventory.size, 1);
  assert.equal(record.inFlight, 1);
  assert.equal(record.state, "LEASED");
});

test("LIVE POOL: a long-stale LEASED box is never force-returned by the orphan path", async () => {
  // Honesty invariant: the live pool wires `isRunActive` to a constant true (an
  // un-settled in-flight lease == an active run in-process), so the orphan path is
  // a no-op there and never yanks a held box from under a long single-turn run.
  const { clock, advance } = controllableClock(0);
  const pool = createBoxPool(
    poolSettings({
      min: 0,
      warm: 0,
      max: 1,
      staleHeartbeatMs: 1_000,
      ttlMs: 1_000_000,
      idleReapMs: 1_000_000,
      reapIntervalMs: 10,
    }),
    { clock, logEvent: () => undefined },
  );

  const leased = await pool.acquire({
    issueId: "issue-1",
    slotIndex: 0,
    labels: [],
    timeoutMs: 1_000,
  });
  assert.equal(leased.status, "leased");
  if (leased.status !== "leased") return;

  // Advance far past staleHeartbeatMs WITHOUT a heartbeat, then let several reaper
  // ticks fire. The held lease never settles, so the box must stay LEASED.
  advance(60_000);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));

  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.leased, 1);
  assert.equal(snap.inFlight, 1);
  const row = snap.boxes.find((b) => b.boxId === leased.lease.boxId);
  assert.ok(row);
  assert.equal(row?.state, "LEASED");

  // The still-live lease settles cleanly afterward (it was never force-returned).
  await leased.lease.release("healthy");
  await pool.drain({ deadlineMs: 100 });
});

// --- list() authoritative reconcile ---------------------------------------

test("list() authoritative: labeled pool-owned unknown is destroyed", async () => {
  const { clock } = controllableClock(0);
  const provider = new FakeBoxProvider({ clock, logEvent: () => undefined });
  // A labeled pool-owned box exists at the provider but the pool has NO record
  // of it (e.g. a crashed-before-ledger orphan). It must be destroyed.
  await provider.provision({
    boxId: "ghost-0",
    labels: ["symphony.pool=worker-box-pool"],
    timeoutMs: 1_000,
  });

  const settings = poolSettings({ min: 0 });
  const { internals } = makeInternals(settings, [], { provider });

  await runReaperTick(internals);

  // The labeled-but-unknown survivor is destroyed at the provider directly (the
  // pool has no record to route through `destroyBox`).
  const remaining = await provider.list();
  assert.equal(remaining.length, 0);
});

test("list() pre-hydrate: a labeled survivor is NOT destroyed before hydrate has run", async () => {
  const { clock } = controllableClock(0);
  const provider = new FakeBoxProvider({ clock, logEvent: () => undefined });
  // A labeled pool-owned survivor exists at the provider. A reaper tick that fires
  // BEFORE hydrate() has re-adopted it must NOT destroy it (the constructor arms
  // the reaper but hydrate runs later); otherwise a restart reaps its own survivor.
  await provider.provision({
    boxId: "survivor-0",
    labels: ["symphony.pool=worker-box-pool"],
    timeoutMs: 1_000,
  });

  const settings = poolSettings({ min: 0 });
  const { internals } = makeInternals(settings, [], { provider });
  // The pool has not hydrated yet: the destroy-unknown branch must be inert.
  internals.hydrated = () => false;

  await runReaperTick(internals);

  // The labeled survivor is still present (never reaped pre-hydrate).
  const remaining = await provider.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.boxId, "survivor-0");
});

test("list() authoritative: unlabeled instance is NEVER destroyed", async () => {
  const { clock } = controllableClock(0);
  const provider = new FakeBoxProvider({ clock, logEvent: () => undefined });
  // An UNLABELED instance at the provider (not ours). The reaper must NEVER
  // destroy it even though the pool has no record of it.
  await provider.provision({ boxId: "foreign-0", labels: [], timeoutMs: 1_000 });

  const settings = poolSettings({ min: 0 });
  const { internals, destroyed } = makeInternals(settings, [], { provider });

  await runReaperTick(internals);

  assert.deepEqual(destroyed, []);
  const remaining = await provider.list();
  assert.equal(remaining.length, 1);
});

test("registered-but-missing-in-list is marked DESTROYED", async () => {
  const { clock } = controllableClock(0);
  const provider = new FakeBoxProvider({ clock, logEvent: () => undefined });
  // The pool has a record but the provider's authoritative list() does NOT show
  // it (the machine vanished). The record must be reconciled to DESTROYED.
  const settings = poolSettings({ min: 0 });
  const record = makeRecord({ boxId: "box-0", state: "WARM_IDLE" });
  const { internals, inventory } = makeInternals(settings, [record], { provider });

  await runReaperTick(internals);

  // The vanished box is dropped from inventory (reconciled to DESTROYED).
  assert.equal(inventory.has("box-0"), false);
});

test("reconcile-missing leaves a LEASED detached-provider box alone (no old-provider leak after a swap)", async () => {
  const { clock } = controllableClock(0);
  // The LIVE provider's list() is empty, so box-0 looks "missing".
  const provider = new FakeBoxProvider({ clock, logEvent: () => undefined });
  const settings = poolSettings({ min: 0 });
  // box-0 is still LEASED and was created on a now-detached provider (captured
  // originProvider by a swapProvider). The live list() legitimately cannot see it -
  // it lives on the OLD backend and is torn down on its origin when its lease settles.
  // Reconciling it away would drop the record so the settle no-ops and the paid
  // old-provider machine leaks.
  const oldProvider = new FakeBoxProvider({ clock, logEvent: () => undefined });
  const record = makeRecord({
    boxId: "box-0",
    state: "LEASED",
    inFlight: 1,
    originProvider: oldProvider,
  });
  const { internals, inventory } = makeInternals(settings, [record], { provider });

  await runReaperTick(internals);

  // NOT reconciled away: the record survives so its lease settle can destroy it on
  // its origin backend.
  assert.equal(inventory.has("box-0"), true);
});

// --- top-up ----------------------------------------------------------------

test("top-up provisions toward min/warm only within spend budget", async () => {
  const settings = poolSettings({ min: 2, warm: 2, max: 4 });
  const { internals, provisioned } = makeInternals(settings, []);
  internals.hasGrowthBudget = () => true;

  await runReaperTick(internals);
  // Empty pool, min=2 -> tops up two warm boxes.
  assert.equal(provisioned.length, 2);
});

test("top-up does NOT provision when spend budget is exhausted", async () => {
  const settings = poolSettings({ min: 2, warm: 2, max: 4 });
  const { internals, provisioned } = makeInternals(settings, []);
  internals.hasGrowthBudget = () => false; // budget exhausted

  await runReaperTick(internals);
  assert.equal(provisioned.length, 0);
});

test("top-up is HELD for a survivor-owning provider until hydrate completes (no pre-hydrate duplicates)", async () => {
  const settings = poolSettings({ min: 2, warm: 2, max: 4 });
  // A PAID provider that owns survivors (usesLedger/ephemeral). Pre-hydrate its
  // survivors are not yet adopted, so topping up would provision DUPLICATES.
  const paidProvider: BoxProvider = {
    kind: "fake",
    capabilities: { sshAddressable: true, ephemeral: true, usesLedger: true },
    provision: async (req) => ({
      boxId: req.boxId,
      workerHost: `fake://box-${req.boxId}`,
      providerRef: `fake://box-${req.boxId}`,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: {},
    }),
    probe: async () => ({ ok: true }),
    destroy: async () => undefined,
    list: async () => [],
  };
  const { internals, provisioned } = makeInternals(settings, [], { provider: paidProvider });
  internals.hasGrowthBudget = () => true;
  internals.hydrated = () => false; // hydrate has not completed yet

  await runReaperTick(internals);
  // Held: a survivor-owning provider must NOT top up before hydrate adopts survivors.
  assert.equal(provisioned.length, 0);

  // Once hydrate completes, top-up resumes toward the target.
  internals.hydrated = () => true;
  await runReaperTick(internals);
  assert.equal(provisioned.length, 2);
});

// --- pool wiring: serial guard + unref ------------------------------------

test("reaper serial: a second tick while one is in progress is skipped", async () => {
  const settings = poolSettings({ min: 1, warm: 1 });
  let bodyRuns = 0;
  let inBody = 0;
  let maxConcurrent = 0;
  const { internals, inventory } = makeInternals(settings, []);
  // Make the single top-up provision block so a second tick can be attempted
  // mid-flight, then add the box so the top-up loop terminates on release.
  let release: (() => void) | null = null;
  internals.provisionWarm = async () => {
    bodyRuns += 1;
    inBody += 1;
    maxConcurrent = Math.max(maxConcurrent, inBody);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    inventory.set(`warm-${bodyRuns}`, makeRecord({ boxId: `warm-${bodyRuns}` }));
    inBody -= 1;
  };

  const first = runReaperTick(internals);
  // Wait until the first tick has entered provisionWarm and parked (the body runs
  // after the reconcile/probe awaits, so poll rather than guess a microtask count).
  while (release === null) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  // A second tick must be a no-op while the first is in progress (it must NOT
  // start a second provision body).
  const second = runReaperTick(internals);
  await second;
  release?.();
  await first;

  // The serial in-progress guard means the body never ran concurrently and the
  // skipped second tick never started its own provision.
  assert.equal(maxConcurrent, 1);
  assert.equal(bodyRuns, 1);
});

test("pool invokes timerHandle.unref?.() on the reaper timer", () => {
  let unrefCalled = 0;
  const timer: TimerHandle = {
    unref: () => {
      unrefCalled += 1;
    },
  };
  const clock: ClockPort = {
    now: () => new Date(0),
    setTimeout: () => timer,
    clearTimeout: () => undefined,
  };
  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });
  // The reaper timer must be detached so it never keeps the process alive.
  assert.equal(unrefCalled >= 1, true);
  void pool.drain({ deadlineMs: 1 });
});

test("pool reaper tick fires on the clock timer and reaps an idle box (end-to-end wiring)", async () => {
  // Drive the reaper through the real pool timer to prove start/stop wiring.
  const { clock, advance } = controllableClock(0);
  const pool = createBoxPool(
    poolSettings({ min: 0, warm: 0, max: 1, idleReapMs: 1_000, reapIntervalMs: 10, ttlMs: 10_000 }),
    { clock, logEvent: () => undefined },
  );

  const leased = await pool.acquire({
    issueId: "issue-1",
    slotIndex: 0,
    labels: [],
    timeoutMs: 1_000,
  });
  assert.equal(leased.status, "leased");
  if (leased.status !== "leased") return;
  await leased.lease.release("healthy");
  assert.equal(pool.snapshot().warmIdle, 1);

  // Advance the logical clock past the idle window and let the real reaper timer
  // fire; the idle box should be reaped.
  advance(5_000);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  assert.equal(pool.snapshot().total, 0);
  await pool.drain({ deadlineMs: 100 });
});
