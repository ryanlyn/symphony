import { test } from "vitest";
import { assert } from "@symphony/test-utils";

import { createLease } from "../src/lease.js";
import { createMutex } from "../src/mutex.js";
import type { BoxOutcome, BoxRecord } from "../src/types.js";

// A minimal manual clock so tests deterministically control `now`.
function fakeClock(start: number): { now(): number; advance(ms: number): void } {
  let current = start;
  return {
    now(): number {
      return current;
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// Builds a LEASED BoxRecord stamped with `leaseId` holding one in-flight run,
// matching the state the pool is in right after it synchronously stamps a lease.
function leasedRecord(overrides: Partial<BoxRecord> = {}): BoxRecord {
  return {
    boxId: "box-1",
    workerHost: "fake://box-box-1",
    providerRef: "ref-1",
    state: "LEASED",
    labels: [],
    createdAtMs: 0,
    leaseId: "lease-1",
    inFlight: 1,
    lastIdleAtMs: 0,
    lastHeartbeatMs: 0,
    boxSecondsUsed: 0,
    markedForDestroy: false,
    affinityKey: null,
    metadata: {},
    ...overrides,
  };
}

// Captures the (record, outcome) pairs the pool would observe so a test can
// assert the lease delegates settlement to the injected pool callback exactly
// once and with the right outcome.
function makeOnSettle(): {
  calls: Array<{ outcome: BoxOutcome; reason: string | null }>;
  onSettle: (record: BoxRecord, outcome: BoxOutcome, reason: string | null) => Promise<void>;
} {
  const calls: Array<{ outcome: BoxOutcome; reason: string | null }> = [];
  return {
    calls,
    async onSettle(record, outcome, reason): Promise<void> {
      // Mirror the pool's accounting: a single decrement per real settle.
      record.inFlight -= 1;
      if (outcome === "poison") {
        record.markedForDestroy = true;
      }
      calls.push({ outcome, reason });
    },
  };
}

test("release('healthy') keeps box, decrements inFlight once", async () => {
  const record = leasedRecord();
  const mutex = createMutex();
  const clock = fakeClock(1_000);
  const { calls, onSettle } = makeOnSettle();

  const lease = createLease({
    leaseId: "lease-1",
    record,
    mutex,
    clock,
    acquiredAtMs: 1_000,
    expiresAtMs: null,
    onSettle,
  });

  await lease.release("healthy");

  assert.equal(record.inFlight, 0);
  assert.equal(record.markedForDestroy, false);
  assert.deepEqual(calls, [{ outcome: "healthy", reason: null }]);
});

test("release() defaults to healthy", async () => {
  const record = leasedRecord();
  const { calls, onSettle } = makeOnSettle();

  const lease = createLease({
    leaseId: "lease-1",
    record,
    mutex: createMutex(),
    clock: fakeClock(0),
    acquiredAtMs: 0,
    expiresAtMs: null,
    onSettle,
  });

  await lease.release();

  assert.equal(record.inFlight, 0);
  assert.deepEqual(calls, [{ outcome: "healthy", reason: null }]);
});

test("fail(reason) marks box poison for recycle", async () => {
  const record = leasedRecord();
  const { calls, onSettle } = makeOnSettle();

  const lease = createLease({
    leaseId: "lease-1",
    record,
    mutex: createMutex(),
    clock: fakeClock(0),
    acquiredAtMs: 0,
    expiresAtMs: null,
    onSettle,
  });

  await lease.fail("ssh_timeout");

  assert.equal(record.inFlight, 0);
  assert.equal(record.markedForDestroy, true);
  assert.deepEqual(calls, [{ outcome: "poison", reason: "ssh_timeout" }]);
});

test("second settle on same lease is a no-op (settled flag), inFlight unchanged", async () => {
  const record = leasedRecord();
  const { calls, onSettle } = makeOnSettle();

  const lease = createLease({
    leaseId: "lease-1",
    record,
    mutex: createMutex(),
    clock: fakeClock(0),
    acquiredAtMs: 0,
    expiresAtMs: null,
    onSettle,
  });

  await lease.release("healthy");
  // A second settle (release OR fail) must do nothing: already settled.
  await lease.release("healthy");
  await lease.fail("late");

  assert.equal(record.inFlight, 0);
  assert.equal(record.markedForDestroy, false);
  assert.deepEqual(calls, [{ outcome: "healthy", reason: null }]);
});

test("stale leaseId release is a no-op and does NOT touch inFlight (cross-generation)", async () => {
  // The pool has re-stamped the box for a NEWER run (leaseId 'lease-2', inFlight 1).
  // A late release from the OLD lease must not decrement the new generation's inFlight.
  const record = leasedRecord({ leaseId: "lease-2", inFlight: 1 });
  const { calls, onSettle } = makeOnSettle();

  const staleLease = createLease({
    leaseId: "lease-1",
    record,
    mutex: createMutex(),
    clock: fakeClock(0),
    acquiredAtMs: 0,
    expiresAtMs: null,
    onSettle,
  });

  await staleLease.release("healthy");

  assert.equal(record.inFlight, 1);
  assert.equal(record.leaseId, "lease-2");
  assert.deepEqual(calls, []);
});

test("stale leaseId fail is a no-op", async () => {
  const record = leasedRecord({ leaseId: "lease-2", inFlight: 1 });
  const { calls, onSettle } = makeOnSettle();

  const staleLease = createLease({
    leaseId: "lease-1",
    record,
    mutex: createMutex(),
    clock: fakeClock(0),
    acquiredAtMs: 0,
    expiresAtMs: null,
    onSettle,
  });

  await staleLease.fail("ssh_timeout");

  assert.equal(record.inFlight, 1);
  assert.equal(record.markedForDestroy, false);
  assert.deepEqual(calls, []);
});

test("release after box DESTROYED is a no-op", async () => {
  // The reaper already destroyed the box (state DESTROYED, inFlight cleared to 0).
  // A late release must not underflow inFlight or call onSettle.
  const record = leasedRecord({ state: "DESTROYED", inFlight: 0 });
  const { calls, onSettle } = makeOnSettle();

  const lease = createLease({
    leaseId: "lease-1",
    record,
    mutex: createMutex(),
    clock: fakeClock(0),
    acquiredAtMs: 0,
    expiresAtMs: null,
    onSettle,
  });

  await lease.release("healthy");

  assert.equal(record.inFlight, 0);
  assert.deepEqual(calls, []);
});

test("heartbeat updates lastHeartbeatMs", () => {
  const record = leasedRecord({ lastHeartbeatMs: 0 });
  const clock = fakeClock(5_000);
  const { onSettle } = makeOnSettle();

  const lease = createLease({
    leaseId: "lease-1",
    record,
    mutex: createMutex(),
    clock,
    acquiredAtMs: 0,
    expiresAtMs: null,
    onSettle,
  });

  lease.heartbeat();
  assert.equal(record.lastHeartbeatMs, 5_000);

  clock.advance(2_000);
  lease.heartbeat();
  assert.equal(record.lastHeartbeatMs, 7_000);
});

test("settle runs inside the per-box mutex (no concurrent decrement)", async () => {
  // Two leases share the SAME record + SAME mutex, each holding one in-flight run.
  // The mutex must serialize their settles so the two decrements never interleave
  // (inFlight ends at exactly 0, observed only as 2 -> 1 -> 0, never a lost update).
  const record = leasedRecord({ leaseId: "lease-1", inFlight: 2 });
  const mutex = createMutex();
  const observed: number[] = [];

  // An onSettle that yields to the event loop mid-decrement: if the mutex did NOT
  // serialize, both bodies would read inFlight=2 before either wrote back.
  const onSettle = async (rec: BoxRecord): Promise<void> => {
    const seen = rec.inFlight;
    await Promise.resolve();
    rec.inFlight = seen - 1;
    observed.push(rec.inFlight);
  };

  const leaseA = createLease({
    leaseId: "lease-1",
    record,
    mutex,
    clock: fakeClock(0),
    acquiredAtMs: 0,
    expiresAtMs: null,
    onSettle,
  });
  // Both leases must carry the SAME leaseId (one box generation, maxInFlight>1)
  // so the ownership guard passes for each.
  const leaseB = createLease({
    leaseId: "lease-1",
    record,
    mutex,
    clock: fakeClock(0),
    acquiredAtMs: 0,
    expiresAtMs: null,
    onSettle,
  });

  await Promise.all([leaseA.release("healthy"), leaseB.release("healthy")]);

  assert.equal(record.inFlight, 0);
  // Serialized decrements: the second body observed the first body's write.
  assert.deepEqual(observed, [1, 0]);
});
