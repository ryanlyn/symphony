import type {
  PlacementInput,
  ProviderUsage,
  ReleaseOptions,
  WorkerHandle,
  WorkerProviderKind,
} from "./types.js";

/**
 * Pluggable backend that knows how to place, probe, and release workers.
 *
 * The interface is shaped so a single provider could front an external broker
 * that hides every backend (local/ssh/cloud/sandbox): `provision` leases a
 * target, `healthCheck` confirms readiness, `release` returns or destroys it.
 *
 * Static providers (local, ssh) set `dynamic=false` and place workers via the
 * synchronous `select` on the claim hot path. Dynamic providers (sandbox,
 * broker) set `dynamic=true`, return `null` from `select`, and do their work
 * in async `provision` — the pool keeps a warm set of ready leases so claim
 * stays synchronous.
 */
export interface WorkerProvider {
  readonly kind: WorkerProviderKind;
  /** Whether released workers may be kept warm for reuse instead of destroyed. */
  readonly reusable: boolean;
  /** Whether placement requires async provisioning (true) or sync select (false). */
  readonly dynamic: boolean;
  /** True if a new worker can be placed given the current usage (capacity gate). */
  hasCapacity(usage: ProviderUsage): boolean;
  /** Synchronous placement on the claim hot path; null for dynamic providers or when at capacity. */
  select(input: PlacementInput): WorkerHandle | null;
  /** Async create-or-reuse for dynamic providers; static providers wrap `select`. */
  provision(input: PlacementInput): Promise<WorkerHandle>;
  /** Readiness probe run before a worker is handed to a run. */
  healthCheck(handle: WorkerHandle): Promise<boolean>;
  /** Return a worker; `recycle` destroys it, otherwise it may be kept (reusable). */
  release(handle: WorkerHandle, opts: ReleaseOptions): Promise<void>;
}
