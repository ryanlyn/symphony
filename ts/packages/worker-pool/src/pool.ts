import { systemClock, type ClockPort } from "@symphony/ports";
import type { Settings } from "@symphony/domain";

import type { WorkerProvider } from "./provider.js";
import { LocalProvider } from "./providers/local.js";
import { SshHostProvider, type SshProviderConfig } from "./providers/ssh.js";
import type {
  Lease,
  ProviderUsage,
  ReleaseOptions,
  WorkerPoolSnapshot,
  WorkerProviderKind,
} from "./types.js";

export interface WorkerPoolOptions {
  /** Reads the current settings; called lazily so hot-reloads are observed. */
  settings: () => Settings;
  clock?: ClockPort | undefined;
  /** Override or add providers (e.g. a sandbox/broker provider in later phases). */
  providers?: Partial<Record<WorkerProviderKind, WorkerProvider>> | undefined;
}

/**
 * Manages the set of leased workers behind a pluggable provider interface.
 *
 * Phase 1 covers Local + static SSH parity: `reserve` makes a synchronous
 * placement decision on the claim hot path and `release` returns the worker.
 * The lease registry is the source of truth for per-host load, mirroring the
 * orchestrator's running set (every running entry holds exactly one lease).
 */
export class WorkerPool {
  private readonly settings: () => Settings;
  private readonly clock: ClockPort;
  private readonly providers: Map<WorkerProviderKind, WorkerProvider>;
  private readonly leases = new Map<string, Lease>();
  private counter = 0;

  constructor(options: WorkerPoolOptions) {
    this.settings = options.settings;
    this.clock = options.clock ?? systemClock;
    this.providers = new Map();
    this.providers.set("local", options.providers?.local ?? new LocalProvider(this.clock));
    this.providers.set(
      "ssh",
      options.providers?.ssh ??
        new SshHostProvider(() => sshConfig(this.settings()), this.clock),
    );
    if (options.providers?.sandbox) this.providers.set("sandbox", options.providers.sandbox);
    if (options.providers?.broker) this.providers.set("broker", options.providers.broker);
  }

  /** True if a worker could be placed right now (used to gate dispatch). */
  capacityAvailable(): boolean {
    return this.provider(this.activeKind()).hasCapacity(this.usage());
  }

  /**
   * Synchronously reserve a worker for `holderKey`, or null when at capacity.
   * The returned lease's `handle.target.workerHost` is the execution target.
   */
  reserve(holderKey: string, hint?: string | null): Lease | null {
    const provider = this.provider(this.activeKind());
    const leaseId = `lease-${(this.counter += 1)}`;
    const handle = provider.select({ leaseId, usage: this.usage(), hint });
    if (!handle) return null;
    const lease: Lease = {
      handle,
      state: "assigned",
      lastHealthyAt: null,
      lastAssignedAt: this.clock.now(),
      holderKey,
    };
    this.leases.set(leaseId, lease);
    return lease;
  }

  /** Return a lease. The registry is updated synchronously before any teardown. */
  async release(
    leaseId: string | null | undefined,
    opts: ReleaseOptions = { recycle: false },
  ): Promise<void> {
    if (!leaseId) return;
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    this.leases.delete(leaseId);
    await this.providers.get(lease.handle.providerKind)?.release(lease.handle, opts);
  }

  snapshot(): WorkerPoolSnapshot {
    const byKind: Partial<Record<WorkerProviderKind, { ready: number; assigned: number }>> = {};
    let ready = 0;
    let assigned = 0;
    let draining = 0;
    for (const lease of this.leases.values()) {
      const kind = lease.handle.providerKind;
      const bucket = (byKind[kind] ??= { ready: 0, assigned: 0 });
      if (lease.state === "assigned") {
        assigned += 1;
        bucket.assigned += 1;
      } else if (lease.state === "ready") {
        ready += 1;
        bucket.ready += 1;
      } else if (lease.state === "draining") {
        draining += 1;
      }
    }
    return { total: this.leases.size, ready, assigned, draining, byKind, ttlMs: null };
  }

  leaseCount(): number {
    return this.leases.size;
  }

  private activeKind(): WorkerProviderKind {
    return this.settings().worker.sshHosts.length > 0 ? "ssh" : "local";
  }

  private provider(kind: WorkerProviderKind): WorkerProvider {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`worker_provider_missing: ${kind}`);
    return provider;
  }

  private usage(): ProviderUsage {
    const perHost = new Map<string, number>();
    let total = 0;
    for (const lease of this.leases.values()) {
      if (lease.state === "draining" || lease.state === "expired") continue;
      total += 1;
      const host = lease.handle.target.workerHost;
      if (host) perHost.set(host, (perHost.get(host) ?? 0) + 1);
    }
    return { total, perHost };
  }
}

function sshConfig(settings: Settings): SshProviderConfig {
  return {
    sshHosts: settings.worker.sshHosts,
    cap: settings.worker.maxConcurrentAgentsPerHost ?? settings.agent.maxConcurrentAgents,
    sshTimeoutMs: settings.worker.sshTimeoutMs,
  };
}
