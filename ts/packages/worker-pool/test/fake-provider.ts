import type { ClockPort } from "@symphony/ports";

import type { WorkerProvider } from "@symphony/worker-pool";
import type {
  PlacementInput,
  ReleaseOptions,
  WorkerHandle,
} from "@symphony/worker-pool";

/**
 * Deterministic, in-memory dynamic provider for unit tests. Tracks every
 * lifecycle call so tests can assert provision/health/release counts and
 * script outcomes.
 */
export class FakeProvider implements WorkerProvider {
  readonly kind = "sandbox" as const;
  readonly reusable = true;
  readonly dynamic = true;
  provisionCount = 0;
  releaseCount = 0;
  recycleCount = 0;
  healthCheckCount = 0;
  /** Set per-handle health overrides; default is healthy. */
  readonly health = new Map<string, boolean>();
  /** Throw on the next N provision attempts. */
  failProvisions = 0;
  /** Stamp this TTL onto provisioned handles. */
  ttlMs: number | undefined = undefined;
  private serial = 0;

  constructor(private readonly clock?: ClockPort) {}

  hasCapacity(): boolean {
    return true;
  }

  select(): WorkerHandle | null {
    return null;
  }

  async provision(input: PlacementInput): Promise<WorkerHandle> {
    if (this.failProvisions > 0) {
      this.failProvisions -= 1;
      throw new Error("fake_provision_failed");
    }
    this.provisionCount += 1;
    this.serial += 1;
    const ref = `fake-${this.serial}`;
    return {
      id: input.leaseId,
      providerKind: "sandbox",
      target: { workerHost: `fake@${ref}` },
      providerRef: ref,
      createdAt: this.clock?.now() ?? new Date(),
      ...(this.ttlMs !== undefined ? { ttlMs: this.ttlMs } : {}),
    };
  }

  async healthCheck(handle: WorkerHandle): Promise<boolean> {
    this.healthCheckCount += 1;
    const ref = handle.providerRef ?? "";
    return this.health.get(ref) ?? true;
  }

  async release(handle: WorkerHandle, opts: ReleaseOptions): Promise<void> {
    this.releaseCount += 1;
    if (opts.recycle) this.recycleCount += 1;
    this.health.delete(handle.providerRef ?? "");
  }
}
