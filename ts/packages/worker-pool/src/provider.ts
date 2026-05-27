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
 * that hides every backend (local/ssh/cloud/sandbox): `select` picks a target,
 * `healthCheck` confirms readiness, `release` returns or destroys it.
 */
export interface WorkerProvider {
  readonly kind: WorkerProviderKind;
  /** Whether released workers may be kept warm for reuse instead of destroyed. */
  readonly reusable: boolean;
  /** True if a new worker can be placed given the current usage (capacity gate). */
  hasCapacity(usage: ProviderUsage): boolean;
  /** Synchronous placement on the claim hot path; null when at capacity. */
  select(input: PlacementInput): WorkerHandle | null;
  /** Readiness probe run before a worker is handed to a run. */
  healthCheck(handle: WorkerHandle): Promise<boolean>;
  /** Return a worker; `recycle` destroys it, otherwise it may be kept (reusable). */
  release(handle: WorkerHandle, opts: ReleaseOptions): Promise<void>;
}
