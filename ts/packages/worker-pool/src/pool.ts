import { systemClock, type ClockPort } from "@symphony/ports";
import type { Settings } from "@symphony/domain";

import type { WorkerProvider } from "./provider.js";
import { LocalProvider } from "./providers/local.js";
import { SshHostProvider, type SshProviderConfig } from "./providers/ssh.js";
import type {
  Lease,
  PlacementInput,
  ProviderUsage,
  ReleaseOptions,
  WorkerHandle,
  WorkerPoolSnapshot,
  WorkerProviderKind,
} from "./types.js";

const DEFAULT_HEALTH_RECHECK_MS = 30_000;

export interface WorkerPoolOptions {
  /** Reads the current settings; called lazily so hot-reloads are observed. */
  settings: () => Settings;
  clock?: ClockPort | undefined;
  /** Override or add providers (a sandbox/broker provider must be injected here). */
  providers?: Partial<Record<WorkerProviderKind, WorkerProvider>> | undefined;
  /** Emit lifecycle events for observability. */
  onEvent?: ((event: WorkerPoolEvent) => void) | undefined;
}

/**
 * Lifecycle event surfaced for observability (logs / runtime events / TUI).
 * The payload intentionally exposes only the lease's execution target, not the
 * raw provider handle, so consumers stay decoupled from provider internals.
 */
export type WorkerPoolEvent =
  | { type: "worker_provisioned"; leaseId: string; providerKind: WorkerProviderKind; workerHost: string | null }
  | { type: "worker_acquired"; leaseId: string; providerKind: WorkerProviderKind; holderKey: string }
  | { type: "worker_released"; leaseId: string; providerKind: WorkerProviderKind; warm: boolean }
  | { type: "worker_recycled"; leaseId: string; providerKind: WorkerProviderKind; reason: "failure" | "ttl" | "unhealthy" | "stop" }
  | { type: "worker_expired"; leaseId: string; providerKind: WorkerProviderKind }
  | { type: "worker_unhealthy"; leaseId: string; providerKind: WorkerProviderKind };

/**
 * Manages the set of leased workers behind a pluggable provider interface.
 *
 * Sync hot path (`reserve`): static providers (local/ssh) place via `select`;
 * dynamic providers (sandbox/broker) hand out a `ready` warm lease if one
 * exists, otherwise kick off background provisioning and return null.
 *
 * Async maintenance (`maintain`): expires TTL'd leases, recycles unhealthy ones,
 * and refills the warm pool. Runtime calls this each poll tick.
 */
export class WorkerPool {
  private readonly settings: () => Settings;
  private readonly clock: ClockPort;
  private readonly providers: Map<WorkerProviderKind, WorkerProvider>;
  private readonly leases = new Map<string, Lease>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly onEvent: (event: WorkerPoolEvent) => void;
  private provisioningCount = 0;
  private counter = 0;
  private stopped = false;

  constructor(options: WorkerPoolOptions) {
    this.settings = options.settings;
    this.clock = options.clock ?? systemClock;
    this.onEvent = options.onEvent ?? (() => {});
    this.providers = new Map();
    this.providers.set("local", options.providers?.local ?? new LocalProvider(this.clock));
    this.providers.set(
      "ssh",
      options.providers?.ssh ?? new SshHostProvider(() => sshConfig(this.settings()), this.clock),
    );
    if (options.providers?.sandbox) this.providers.set("sandbox", options.providers.sandbox);
    if (options.providers?.broker) this.providers.set("broker", options.providers.broker);
  }

  /** True if a worker could be placed right now (used to gate dispatch). */
  capacityAvailable(): boolean {
    const provider = this.provider(this.activeKind());
    if (!provider.dynamic) return provider.hasCapacity(this.usage());
    if (this.readyCount(provider.kind) > 0) return true;
    return this.totalCount() < this.maxPoolSize();
  }

  /**
   * Synchronously reserve a worker for `holderKey`, or null when at capacity.
   * For dynamic providers, returns a `ready` warm lease if one exists; otherwise
   * starts background provisioning and returns null (the issue gets retried).
   */
  reserve(holderKey: string, hint?: string | null): Lease | null {
    if (this.stopped) return null;
    const provider = this.provider(this.activeKind());
    if (!provider.dynamic) {
      const leaseId = this.nextLeaseId();
      const handle = provider.select({ leaseId, usage: this.usage(), hint });
      if (!handle) return null;
      const lease = this.registerAssigned(handle, holderKey);
      this.emit({ type: "worker_acquired", leaseId, providerKind: provider.kind, holderKey });
      return lease;
    }
    const ready = this.findReady(provider.kind);
    if (ready) {
      ready.state = "assigned";
      ready.holderKey = holderKey;
      ready.lastAssignedAt = this.clock.now();
      this.emit({
        type: "worker_acquired",
        leaseId: ready.handle.id,
        providerKind: provider.kind,
        holderKey,
      });
      return ready;
    }
    if (this.totalCount() < this.maxPoolSize()) this.startBackgroundProvision(provider, hint);
    return null;
  }

  /**
   * Probe a lease for readiness before handing it to a run. Static providers
   * resolve trivially true; dynamic providers re-probe and mark unhealthy on
   * failure so the next maintain() recycles them.
   */
  async ready(leaseId: string | null | undefined): Promise<boolean> {
    if (!leaseId) return false;
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    const provider = this.providers.get(lease.handle.providerKind);
    if (!provider) return false;
    if (!provider.dynamic) return true;
    const ok = await provider.healthCheck(lease.handle);
    if (ok) lease.lastHealthyAt = this.clock.now();
    else this.emit({ type: "worker_unhealthy", leaseId, providerKind: provider.kind });
    return ok;
  }

  /** Return a lease. May warm-keep when the provider is reusable and not recycling. */
  async release(
    leaseId: string | null | undefined,
    opts: ReleaseOptions = { recycle: false },
  ): Promise<void> {
    if (!leaseId) return;
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    const provider = this.providers.get(lease.handle.providerKind);

    if (!provider?.dynamic) {
      this.leases.delete(leaseId);
      this.emit({
        type: "worker_released",
        leaseId,
        providerKind: lease.handle.providerKind,
        warm: false,
      });
      if (provider) await provider.release(lease.handle, opts);
      return;
    }

    const destroy = opts.recycle || lease.expireAfterRelease;
    if (!destroy && provider.reusable) {
      const warm = this.warmPoolSize();
      if (this.readyCount(provider.kind) < warm) {
        lease.state = "ready";
        lease.holderKey = null;
        lease.lastAssignedAt = null;
        this.emit({ type: "worker_released", leaseId, providerKind: provider.kind, warm: true });
        return;
      }
    }
    await this.destroyLease(lease, opts.recycle ? "failure" : lease.expireAfterRelease ? "ttl" : "ttl");
  }

  /**
   * Periodic maintenance: TTL expiry, health recycle, warm refill. Runtime
   * calls this each poll tick; safe to call concurrently with reserve/release.
   */
  async maintain(): Promise<void> {
    if (this.stopped) return;
    await this.reapTtl();
    await this.recycleUnhealthy();
    this.refillWarm();
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
    return {
      total: this.leases.size + this.provisioningCount,
      ready,
      assigned,
      draining,
      byKind,
      ttlMs: this.ttlMs(),
    };
  }

  leaseCount(): number {
    return this.leases.size + this.provisioningCount;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.inFlight]);
    const leases = [...this.leases.values()];
    this.leases.clear();
    for (const lease of leases) {
      const provider = this.providers.get(lease.handle.providerKind);
      this.emit({
        type: "worker_recycled",
        leaseId: lease.handle.id,
        providerKind: lease.handle.providerKind,
        reason: "stop",
      });
      if (provider) {
        try {
          await provider.release(lease.handle, { recycle: true });
        } catch {
          /* best-effort teardown */
        }
      }
    }
  }

  private async reapTtl(): Promise<void> {
    const ttl = this.ttlMs();
    if (ttl == null) return;
    const now = this.clock.now().getTime();
    for (const lease of [...this.leases.values()]) {
      const leaseTtl = lease.handle.ttlMs ?? ttl;
      if (now - lease.handle.createdAt.getTime() <= leaseTtl) continue;
      if (lease.state === "ready") {
        this.emit({
          type: "worker_expired",
          leaseId: lease.handle.id,
          providerKind: lease.handle.providerKind,
        });
        await this.destroyLease(lease, "ttl");
      } else if (lease.state === "assigned") {
        lease.expireAfterRelease = true;
      }
    }
  }

  private async recycleUnhealthy(): Promise<void> {
    const interval = this.healthRecheckMs();
    const now = this.clock.now();
    for (const lease of [...this.leases.values()]) {
      if (lease.state !== "ready") continue;
      const provider = this.providers.get(lease.handle.providerKind);
      if (!provider?.dynamic) continue;
      const last = lease.lastHealthyAt?.getTime() ?? 0;
      if (now.getTime() - last <= interval) continue;
      const ok = await provider.healthCheck(lease.handle);
      if (!ok) {
        this.emit({
          type: "worker_unhealthy",
          leaseId: lease.handle.id,
          providerKind: provider.kind,
        });
        await this.destroyLease(lease, "unhealthy");
      } else {
        lease.lastHealthyAt = now;
      }
    }
  }

  private refillWarm(): void {
    if (this.stopped) return;
    const activeKind = this.activeKind();
    const provider = this.providers.get(activeKind);
    if (!provider?.dynamic) return;
    const max = this.maxPoolSize();
    const warm = this.warmPoolSize();
    while (
      this.totalCount() < max &&
      this.readyCount(activeKind) + this.provisioningCount < warm
    ) {
      this.startBackgroundProvision(provider, null);
    }
  }

  private startBackgroundProvision(provider: WorkerProvider, hint: string | null | undefined): void {
    if (this.stopped) return;
    this.provisioningCount += 1;
    const leaseId = this.nextLeaseId();
    const input: PlacementInput = { leaseId, usage: this.usage(), hint };
    const job = this.provisionOne(provider, input, leaseId);
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));
  }

  private async provisionOne(
    provider: WorkerProvider,
    input: PlacementInput,
    leaseId: string,
  ): Promise<void> {
    let handle: WorkerHandle | null = null;
    try {
      handle = await provider.provision(input);
      if (this.stopped) {
        await provider.release(handle, { recycle: true });
        return;
      }
      const ok = await provider.healthCheck(handle);
      if (!ok) {
        this.emit({ type: "worker_unhealthy", leaseId, providerKind: provider.kind });
        await provider.release(handle, { recycle: true });
        return;
      }
      this.leases.set(handle.id, {
        handle,
        state: "ready",
        lastHealthyAt: this.clock.now(),
        lastAssignedAt: null,
        holderKey: null,
        expireAfterRelease: false,
      });
      this.emit({
        type: "worker_provisioned",
        leaseId: handle.id,
        providerKind: provider.kind,
        workerHost: handle.target.workerHost,
      });
    } catch {
      if (handle) {
        try {
          await provider.release(handle, { recycle: true });
        } catch {
          /* best-effort */
        }
      }
    } finally {
      this.provisioningCount -= 1;
    }
  }

  private async destroyLease(
    lease: Lease,
    reason: "failure" | "ttl" | "unhealthy",
  ): Promise<void> {
    this.leases.delete(lease.handle.id);
    lease.state = "draining";
    const provider = this.providers.get(lease.handle.providerKind);
    this.emit({
      type: "worker_recycled",
      leaseId: lease.handle.id,
      providerKind: lease.handle.providerKind,
      reason,
    });
    if (provider) {
      try {
        await provider.release(lease.handle, { recycle: true });
      } catch {
        /* best-effort teardown */
      }
    }
  }

  private registerAssigned(handle: WorkerHandle, holderKey: string): Lease {
    const lease: Lease = {
      handle,
      state: "assigned",
      lastHealthyAt: null,
      lastAssignedAt: this.clock.now(),
      holderKey,
      expireAfterRelease: false,
    };
    this.leases.set(handle.id, lease);
    return lease;
  }

  private findReady(kind: WorkerProviderKind): Lease | undefined {
    for (const lease of this.leases.values()) {
      if (lease.state === "ready" && lease.handle.providerKind === kind) return lease;
    }
    return undefined;
  }

  private readyCount(kind: WorkerProviderKind): number {
    let n = 0;
    for (const lease of this.leases.values()) {
      if (lease.state === "ready" && lease.handle.providerKind === kind) n += 1;
    }
    return n;
  }

  private totalCount(): number {
    return this.leases.size + this.provisioningCount;
  }

  private activeKind(): WorkerProviderKind {
    const pool = this.settings().worker.pool;
    if (pool?.provider) return pool.provider;
    return this.settings().worker.sshHosts.length > 0 ? "ssh" : "local";
  }

  private maxPoolSize(): number {
    const settings = this.settings();
    return settings.worker.pool?.maxPoolSize ?? settings.agent.maxConcurrentAgents;
  }

  private warmPoolSize(): number {
    return this.settings().worker.pool?.warmPoolSize ?? 0;
  }

  private ttlMs(): number | null {
    return this.settings().worker.pool?.ttlMs ?? null;
  }

  private healthRecheckMs(): number {
    return this.settings().worker.pool?.healthRecheckMs ?? DEFAULT_HEALTH_RECHECK_MS;
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
      if (lease.state !== "assigned") continue;
      total += 1;
      const host = lease.handle.target.workerHost;
      if (host) perHost.set(host, (perHost.get(host) ?? 0) + 1);
    }
    return { total, perHost };
  }

  private nextLeaseId(): string {
    this.counter += 1;
    return `lease-${this.counter}`;
  }

  private emit(event: WorkerPoolEvent): void {
    try {
      this.onEvent(event);
    } catch {
      /* listener errors must not poison the pool */
    }
  }
}

function sshConfig(settings: Settings): SshProviderConfig {
  return {
    sshHosts: settings.worker.sshHosts,
    cap: settings.worker.maxConcurrentAgentsPerHost ?? settings.agent.maxConcurrentAgents,
    sshTimeoutMs: settings.worker.sshTimeoutMs,
  };
}
