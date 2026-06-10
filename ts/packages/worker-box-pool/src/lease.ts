import type { BoxLease, BoxOutcome, BoxRecord, Mutex } from "./types.js";

/**
 * Settles a lease against its box. Invoked by `createLease` INSIDE the per-box
 * mutex (so a reaper tick and a release can never both decrement `inFlight`).
 * The callback owns the real accounting: decrement `inFlight`, mark the box for
 * recycle on `poison`, and run any returning/destroy bookkeeping. It is only
 * ever called once per lease, and only when the lease still owns the box.
 */
export type OnSettle = (
  record: BoxRecord,
  outcome: BoxOutcome,
  reason: string | null,
) => Promise<void>;

/**
 * Dependencies the pool injects when it hands out a lease. `record` is the
 * shared inventory record (mutated only inside `mutex`); `clock` stamps
 * heartbeats; `onSettle` is the pool's accounting callback.
 */
export interface CreateLeaseOptions {
  leaseId: string;
  record: BoxRecord;
  mutex: Mutex;
  clock: { now(): number };
  acquiredAtMs: number;
  expiresAtMs: number | null;
  onSettle: OnSettle;
}

/**
 * Builds a `BoxLease` over a single box generation. The lease settles exactly
 * once: a per-lease `settled` flag short-circuits a double `release`/`fail`, and
 * the actual settlement runs inside the per-box `mutex` where it re-checks
 * ownership. A stale generation (the box was re-stamped with a newer `leaseId`)
 * or an already-DESTROYED box is a no-op that NEVER touches `inFlight`, so a
 * late-resolving run from an old generation cannot underflow the live count.
 */
export function createLease(options: CreateLeaseOptions): BoxLease {
  const { leaseId, record, mutex, clock, acquiredAtMs, expiresAtMs, onSettle } = options;

  // Per-lease guard so a second release/fail from the SAME lease is a no-op.
  // This is distinct from the leaseId ownership check (cross-generation).
  let settled = false;

  async function settle(outcome: BoxOutcome, reason: string | null): Promise<void> {
    // Cheap pre-check outside the mutex: an already-settled lease never queues.
    if (settled) return;
    await mutex.runExclusive(async () => {
      // Re-check inside the lock: a concurrent settle may have flipped the flag
      // while this body waited its turn in the chain.
      if (settled) return;
      // Ownership/state guard: the box must still belong to THIS lease generation
      // and not have been destroyed by the reaper. A mismatch is a cross-generation
      // stale release (or a destroyed box) and must not touch `inFlight`.
      if (record.leaseId !== leaseId || record.state === "DESTROYED") {
        settled = true;
        return;
      }
      settled = true;
      await onSettle(record, outcome, reason);
    });
  }

  return {
    leaseId,
    boxId: record.boxId,
    workerHost: record.workerHost,
    acquiredAtMs,
    expiresAtMs,
    async release(outcome: BoxOutcome = "healthy"): Promise<void> {
      await settle(outcome, null);
    },
    async fail(reason: string): Promise<void> {
      await settle("poison", reason);
    },
    heartbeat(): void {
      // Best-effort liveness stamp read by the reaper's orphan detection. A stale
      // generation's heartbeat is harmless: the record is no longer this lease's.
      record.lastHeartbeatMs = clock.now();
    },
  };
}
