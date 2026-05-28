import { systemClock, type ClockPort } from "@symphony/ports";

import type { WorkerProvider } from "../provider.js";
import type { PlacementInput, WorkerHandle } from "../types.js";

/** Runs agents in the local process (no remote target). Always has capacity. */
export class LocalProvider implements WorkerProvider {
  readonly kind = "local" as const;
  readonly reusable = true;
  readonly dynamic = false;

  constructor(private readonly clock: ClockPort = systemClock) {}

  hasCapacity(): boolean {
    return true;
  }

  select(input: PlacementInput): WorkerHandle {
    return {
      id: input.leaseId,
      providerKind: "local",
      target: { workerHost: null },
      createdAt: this.clock.now(),
    };
  }

  async provision(input: PlacementInput): Promise<WorkerHandle> {
    return Promise.resolve(this.select(input));
  }

  async healthCheck(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async release(): Promise<void> {}
}
