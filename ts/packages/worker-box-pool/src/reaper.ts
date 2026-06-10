import type { BoxPoolSettings } from "@symphony/domain";

import type { BoxDescriptor, BoxProvider, BoxRecord, Mutex } from "./types.js";

/**
 * The seam between the pool and the single serial reaper pass. The pool supplies
 * its live inventory, the per-box mutex factory, spend/growth predicates, and the
 * destroy/provision primitives; the reaper reads `settings`/`now` and drives the
 * ttl/idle/orphan/list-reconcile/top-up decisions over them. Keeping the contract
 * narrow lets the reaper logic be unit-tested over a hand-rolled inventory while
 * the pool owns the recurring timer (and its `unref`).
 */
export interface ReaperInternals {
  /** Current effective pool settings (swapped by the pool on config reload). */
  settings: BoxPoolSettings;
  /** The resolved provider whose `list()` is the authoritative source of truth. */
  provider: BoxProvider;
  /**
   * The label every pool-owned box carries. A `list()` reconcile destroys a
   * labeled-but-unknown survivor (ours, leaked) but NEVER an unlabeled instance
   * (not ours), so the reaper can never nuke a machine the pool did not create.
   */
  poolOwnedLabel: string;
  /** Monotonic millisecond wall clock (the pool's lease clock). */
  now: () => number;
  /** The pool's authoritative in-memory inventory, keyed on `boxId`. */
  inventory: Map<string, BoxRecord>;
  /** Returns (creating if needed) the per-box mutex serializing its mutations. */
  mutexFor: (boxId: string) => Mutex;
  /** Count of boxes that count as live for the `min` floor / growth headroom. */
  liveBoxCount: () => number;
  /**
   * Whether the run holding a leased box is still active. Distinguishes a true
   * orphan (stale heartbeat AND run gone -> force-return) from a long-but-alive
   * single turn (stale heartbeat but run still running -> left untouched). The
   * live pool wires this to a constant `true`: in-process a lease is settled
   * exactly once (only in `runClaim`'s finally), so an un-settled in-flight lease
   * always implies an active run, and the reaper must never force-return a LEASED
   * box (that would kill a legitimate long single turn). Cross-restart orphan
   * recovery is handled by `hydrate` (re-adopt only survivors `provider.list()`
   * still shows), not by this predicate. The reaper unit tests inject `false` to
   * exercise the force-return branch in isolation.
   */
  isRunActive: (record: BoxRecord) => boolean;
  /**
   * Whether `hydrate()` has completed at least once. The constructor arms the
   * recurring reaper but `hydrate()` (which re-adopts labeled survivors from
   * `provider.list()`) runs later, so a reaper tick that fires in the gap would see
   * a labeled survivor the pool has no record of yet and reap it as a leaked
   * unknown - destroying the pool's own survivor on restart. The destroy-unknown
   * reconcile branch is therefore gated on this: it is inert until the first
   * hydrate completes, after which normal reconcile behavior resumes.
   */
  hydrated: () => boolean;
  /** Whether the spend budget allows provisioning one more box right now. */
  hasGrowthBudget: () => boolean;
  /** Destroys a box (provider.destroy + inventory/mutex removal). Idempotent. */
  destroyBox: (record: BoxRecord, reason: TeardownReasonInternal) => Promise<void>;
  /** Provisions one warm box toward the min/warm target (under budget). */
  provisionWarm: () => Promise<void>;
  /** Structured-log sink. */
  logEvent: (event: Record<string, unknown>) => void;
  /** Wakes any FIFO waiters after capacity frees (e.g. a reaped box). */
  wakeWaiters: () => void;
}

/** Teardown reasons the reaper itself attributes (a subset of `TeardownReason`). */
type TeardownReasonInternal = "ttl" | "idle" | "unhealthy" | "orphan";

// Tracks which internals objects have a tick in progress so a second tick that
// fires while the first is still running (a slow probe/destroy) is skipped. Keyed
// on the internals object so the guard never leaks across pools and never makes
// `ReaperInternals` itself stateful.
const inProgress = new WeakSet<ReaperInternals>();

/**
 * Runs ONE serial reaper pass. Re-entrant calls while a pass is in progress are
 * skipped (the single in-progress guard), so a slow probe/destroy can never let
 * two passes interleave and double-decrement `inFlight`. The pass, in order:
 *
 *  1. reconcile against `provider.list()` (authoritative): destroy labeled
 *     pool-owned survivors the pool does not know about, NEVER touch unlabeled
 *     instances, and mark registered-but-missing records DESTROYED.
 *  2. orphan detection (gated on `isRunActive`): a LEASED box with a stale
 *     heartbeat whose run is gone would be force-returned. In the LIVE pool
 *     `isRunActive` is constant `true` (an un-settled in-flight lease == an active
 *     run in-process), so this branch never fires there; it exists for the unit
 *     tests that inject a `false` predicate. Cross-restart orphans are recovered by
 *     `hydrate`, not here.
 *  3. ttl/idle reaping above `min`: a WARM_IDLE box past ttl or its idle window is
 *     destroyed; a LEASED box past ttl is only flagged `markedForDestroy` and is
 *     recycled when its last lease returns (inside the per-box mutex).
 *  4. probe demotion: every WARM_IDLE box is probed for readiness each tick; a
 *     failing probe demotes it to DEGRADED and tears it down.
 *  5. top-up toward min/warm within the spend budget.
 *
 * Every per-box mutation runs inside that box's mutex so a concurrent lease
 * release observing the same `inFlight->0` is serialized (the reaper-vs-release
 * race fix). `now` is read once per call (passed implicitly via `internals.now`).
 */
export async function runReaperTick(internals: ReaperInternals): Promise<void> {
  if (inProgress.has(internals)) return;
  inProgress.add(internals);
  try {
    await reconcileWithProviderList(internals);
    await reapOrphans(internals);
    await reapTtlAndIdle(internals);
    await reapUnhealthy(internals);
    await topUp(internals);
    internals.wakeWaiters();
  } finally {
    inProgress.delete(internals);
  }
}

/**
 * Reconciles the in-memory inventory against `provider.list()`, the authoritative
 * source of truth. Two independent directions:
 *
 *  - provider-has / pool-lacks: a survivor at the provider the pool has no record
 *    of. Destroy it ONLY when it carries the pool-owned label (ours, leaked by a
 *    crash). An unlabeled instance is left strictly alone (it is not ours).
 *  - pool-has / provider-lacks: a registered record the authoritative list no
 *    longer shows (the machine vanished). Mark it DESTROYED and drop it.
 */
async function reconcileWithProviderList(internals: ReaperInternals): Promise<void> {
  let listed: BoxDescriptor[];
  try {
    listed = await internals.provider.list();
  } catch (error) {
    // list() is advisory-on-failure: a transient provider error must not cause a
    // mass reconcile (which could destroy or drop boxes). Skip reconcile this pass.
    internals.logEvent({ event: "box_pool_list_failed", error: errorMessage(error) });
    return;
  }

  const listedById = new Map<string, BoxDescriptor>();
  for (const descriptor of listed) listedById.set(descriptor.boxId, descriptor);

  // provider-has / pool-lacks: destroy labeled-pool-owned unknowns only. Held back
  // until the first hydrate completes: pre-hydrate, every labeled survivor is
  // "unknown" simply because hydrate has not re-adopted it yet, and reaping it here
  // would destroy the pool's own survivors on restart. After hydrate the branch
  // resumes normal behavior (a labeled-unknown is then a genuine leaked orphan).
  const reapUnknowns = internals.hydrated();
  for (const descriptor of listed) {
    if (internals.inventory.has(descriptor.boxId)) continue;
    if (!reapUnknowns) continue;
    const owned = descriptor.labels.includes(internals.poolOwnedLabel);
    if (!owned) {
      // Not ours: NEVER destroy.
      continue;
    }
    internals.logEvent({ event: "box_pool_reconcile_destroy_unknown", boxId: descriptor.boxId });
    try {
      await internals.provider.destroy(descriptor, {
        timeoutMs: internals.settings.acquireTimeoutMs,
        reason: "orphan",
      });
    } catch (error) {
      internals.logEvent({
        event: "box_pool_destroy_failed",
        boxId: descriptor.boxId,
        error: errorMessage(error),
      });
    }
  }

  // pool-has / provider-lacks: mark registered-but-missing records DESTROYED.
  for (const record of [...internals.inventory.values()]) {
    if (listedById.has(record.boxId)) continue;
    if (record.state === "DESTROYED" || record.state === "DESTROYING") continue;
    // A box still mid-provision may legitimately not appear in list() yet; only
    // reconcile away records the pool already considers live/idle.
    if (record.state === "PROVISIONING" || record.state === "WARMING") continue;
    // A box created on a now-detached provider (it carries the `originProvider` a
    // swapProvider stamped) is NOT expected in the LIVE provider's list() - it lives
    // on the OLD backend and is torn down on its origin when its lease settles. An
    // in-flight lease likewise owns its box's teardown (and a truly-dead one is
    // handled by the orphan reaper / eventual-consistency retry). Reconciling either
    // away here would drop the record so the later settle no-ops on a DESTROYED box
    // and `originProvider.destroy()` is never called - leaking the paid machine.
    if (record.originProvider !== undefined || record.inFlight > 0) continue;
    internals.logEvent({ event: "box_pool_reconcile_missing", boxId: record.boxId });
    await internals.mutexFor(record.boxId).runExclusive(async () => {
      record.state = "DESTROYED";
      record.inFlight = 0;
      record.leaseId = null;
      internals.inventory.delete(record.boxId);
      // The body is synchronous; awaiting a resolved promise satisfies the
      // mutex's Promise-returning contract without a meaningless async hop.
      await Promise.resolve();
    });
  }
}

/**
 * Force-returns orphaned leases. A LEASED box whose last heartbeat is older than
 * `staleHeartbeatMs` AND whose run is gone is an orphan: its lease is cleared,
 * `inFlight` zeroed, and the box recycled (a box that hosted an orphan is not
 * trusted). The "run is gone" check is `!isRunActive(record)`, which in the LIVE
 * pool is always false (an un-settled in-flight lease == an active run in-process),
 * so this NEVER force-returns a LEASED box from the live pool - that would kill a
 * legitimate long single turn that emits no heartbeat. The branch is exercised only
 * by the unit tests that inject `isRunActive: () => false`; real cross-restart
 * orphans are recovered by `hydrate`. Runs inside the per-box mutex so a racing
 * late release cannot underflow.
 */
async function reapOrphans(internals: ReaperInternals): Promise<void> {
  const now = internals.now();
  const stale = internals.settings.staleHeartbeatMs;
  for (const record of [...internals.inventory.values()]) {
    if (record.state !== "LEASED") continue;
    if (record.inFlight <= 0) continue;
    if (now - record.lastHeartbeatMs < stale) continue;
    // Stale heartbeat: in the live pool the run is always still active, so this is
    // a no-op there; a unit-injected `false` predicate exercises the force-return.
    if (internals.isRunActive(record)) continue;
    await internals.mutexFor(record.boxId).runExclusive(async () => {
      // Re-check inside the mutex: a release may have settled while we queued.
      if (record.state === "DESTROYED" || record.inFlight <= 0) return;
      internals.logEvent({ event: "box_pool_orphan_reaped", boxId: record.boxId });
      record.inFlight = 0;
      record.leaseId = null;
      record.leaseIssues?.clear();
      await internals.destroyBox(record, "orphan");
    });
  }
}

/**
 * ttl/idle reaping above the `min` floor. WARM_IDLE boxes past their ttl or idle
 * window are destroyed oldest-first while staying at or above `min`. A LEASED box
 * past its ttl is only FLAGGED `markedForDestroy` (never yanked mid-run); the
 * pool's lease-settle recycles it the instant its last lease returns. A box that
 * is ALREADY flagged and idle is recycled here too.
 */
async function reapTtlAndIdle(internals: ReaperInternals): Promise<void> {
  const now = internals.now();
  const { ttlMs, idleReapMs, min } = internals.settings;

  // Flag LEASED boxes past ttl (and recycle any already-flagged idle box).
  for (const record of internals.inventory.values()) {
    if (record.state === "LEASED" && now - record.createdAtMs >= ttlMs) {
      record.markedForDestroy = true;
    }
  }

  // Candidate idle boxes to reap, oldest-idle first so the freshest survivors are
  // the ones kept toward `min`.
  const idle = [...internals.inventory.values()]
    .filter((record) => record.state === "WARM_IDLE" && record.inFlight === 0)
    .sort((a, b) => a.lastIdleAtMs - b.lastIdleAtMs);

  let liveAbove = internals.liveBoxCount();
  for (const record of idle) {
    const ttlExpired = now - record.createdAtMs >= ttlMs;
    const idleExpired = now - record.lastIdleAtMs >= idleReapMs;
    const flagged = record.markedForDestroy;
    if (!ttlExpired && !idleExpired && !flagged) continue;
    // Respect the min floor: never reap below `min` live boxes (a flagged box is
    // still reaped because the operator/ttl explicitly wants it gone).
    if (!flagged && liveAbove <= min) continue;
    const reason: TeardownReasonInternal = ttlExpired ? "ttl" : "idle";
    await internals.mutexFor(record.boxId).runExclusive(async () => {
      if (record.state !== "WARM_IDLE" || record.inFlight !== 0) return;
      await internals.destroyBox(record, reason);
    });
    liveAbove -= 1;
  }
}

/**
 * Probe-demotes unhealthy idle boxes. EVERY WARM_IDLE box (inFlight 0) that
 * survived the ttl/idle reaping above is probed for readiness each tick; a failing
 * probe demotes it to DEGRADED and then tears it down (a dead box serves no leases).
 * Only idle boxes are probed, so a live run is never disturbed by a readiness check.
 */
async function reapUnhealthy(internals: ReaperInternals): Promise<void> {
  for (const record of [...internals.inventory.values()]) {
    if (record.state !== "WARM_IDLE" || record.inFlight !== 0) continue;
    let health: { ok: boolean };
    try {
      health = await internals.provider.probe(descriptorOf(record), {
        timeoutMs: internals.settings.acquireTimeoutMs,
      });
    } catch (error) {
      health = { ok: false };
      internals.logEvent({
        event: "box_pool_probe_failed",
        boxId: record.boxId,
        error: errorMessage(error),
      });
    }
    if (health.ok) continue;
    await internals.mutexFor(record.boxId).runExclusive(async () => {
      if (record.state !== "WARM_IDLE" || record.inFlight !== 0) return;
      record.state = "DEGRADED";
      internals.logEvent({ event: "box_pool_degraded", boxId: record.boxId });
      await internals.destroyBox(record, "unhealthy");
    });
  }
}

/**
 * Tops up the warm inventory toward the higher of `min` and `warm`, one box at a
 * time, ONLY while the spend budget allows. Capped by `max` via `hasGrowthBudget`
 * / the pool's own headroom check inside `provisionWarm`.
 */
async function topUp(internals: ReaperInternals): Promise<void> {
  // Hold top-up until the first hydrate has adopted any provider survivors, but ONLY
  // for a provider that actually OWNS survivors (paid: usesLedger / ephemeral). The
  // ctor arms the reaper before `hydrate()` runs, so a pre-hydrate tick sees an empty
  // in-memory inventory even while paid survivors still exist at the backend - topping
  // up now would provision DUPLICATES and overshoot warm/max (a paid provider that
  // cannot hydrate fails startup loudly, so reaching steady state implies hydrated).
  // A non-paid provider (fake / static-ssh) owns no survivors and need not wait on a
  // one-time list(), so it warms immediately regardless of `hydrated`.
  const caps = internals.provider.capabilities;
  if (!internals.hydrated() && (caps.usesLedger || caps.ephemeral)) return;

  const target = Math.max(internals.settings.min, internals.settings.warm);
  // Bound attempts to the size of the gap so a persistently-failing provision
  // (which never adds a box) cannot spin the tick forever; the next tick retries.
  let attempts = Math.max(0, target - internals.liveBoxCount());
  while (attempts > 0 && internals.liveBoxCount() < target) {
    if (!internals.hasGrowthBudget()) {
      internals.logEvent({ event: "box_pool_topup_budget_blocked" });
      return;
    }
    await internals.provisionWarm();
    attempts -= 1;
  }
}

/** Reconstructs a BoxDescriptor from a record for provider probe/destroy calls. */
function descriptorOf(record: BoxRecord): BoxDescriptor {
  return {
    boxId: record.boxId,
    workerHost: record.workerHost,
    providerRef: record.providerRef,
    createdAtMs: record.createdAtMs,
    labels: record.labels,
    metadata: record.metadata,
  };
}

/** Extracts a stable message from an unknown thrown value for structured logs. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
