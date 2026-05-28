import { runSsh } from "@symphony/ssh";
import { systemClock, type ClockPort, type RemoteShellPort } from "@symphony/ports";

import type { WorkerProvider } from "../provider.js";
import type { PlacementInput, WorkerHandle } from "../types.js";

/**
 * The "crabbox abstracts everything" model: a single provider that delegates
 * provisioning/release to an external control-plane broker which owns
 * credentials, lease state, TTL cleanup, and spend caps. Symphony never learns
 * whether the broker chose local, static SSH, or a cloud VM — it only sees
 * `handle.target.workerHost`, an opaque SSH destination the broker picked.
 *
 * Concrete brokers (e.g. crabbox's Cloudflare-Worker control plane) implement
 * `BrokerClient` against their HTTP API.
 */
export interface BrokerProviderConfig {
  /** SSH probe timeout. */
  sshTimeoutMs: number;
  /** Optional labels forwarded to the broker for routing. */
  labels?: Record<string, string> | undefined;
}

/** Backend-agnostic API the BrokerProvider talks to. Wire crabbox/etc. here. */
export interface BrokerClient {
  lease(opts: BrokerLeaseOpts): Promise<BrokerLease>;
  unlease(lease: BrokerLease): Promise<void>;
}

export interface BrokerLeaseOpts {
  labels?: Record<string, string> | undefined;
}

export interface BrokerLease {
  /** Broker-native lease id. */
  leaseRef: string;
  /** OpenSSH destination the broker provisioned/selected. */
  sshHost: string;
  /** Broker-enforced lease TTL in ms; consumed for local TTL bookkeeping. */
  ttlMs?: number | undefined;
}

const defaultRemoteShell: RemoteShellPort = {
  async run(host, command, timeoutMs) {
    const result = await runSsh(host, command, timeoutMs !== undefined ? { timeoutMs } : {});
    if (result.status !== 0) throw new Error(`ssh_status_${result.status}`);
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

export class BrokerProvider implements WorkerProvider {
  readonly kind = "broker" as const;
  readonly reusable = true;
  readonly dynamic = true;

  constructor(
    private readonly client: BrokerClient,
    private readonly config: () => BrokerProviderConfig,
    private readonly clock: ClockPort = systemClock,
    private readonly shell: RemoteShellPort = defaultRemoteShell,
  ) {}

  hasCapacity(): boolean {
    return true;
  }

  select(): WorkerHandle | null {
    return null;
  }

  async provision(input: PlacementInput): Promise<WorkerHandle> {
    const cfg = this.config();
    const lease = await this.client.lease({
      ...(cfg.labels !== undefined ? { labels: cfg.labels } : {}),
    });
    return {
      id: input.leaseId,
      providerKind: "broker",
      target: { workerHost: lease.sshHost },
      providerRef: lease.leaseRef,
      createdAt: this.clock.now(),
      ...(lease.ttlMs !== undefined ? { ttlMs: lease.ttlMs } : {}),
    };
  }

  async healthCheck(handle: WorkerHandle): Promise<boolean> {
    const host = handle.target.workerHost;
    if (!host) return true;
    try {
      await this.shell.run(host, "true", this.config().sshTimeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async release(handle: WorkerHandle): Promise<void> {
    if (!handle.providerRef) return;
    try {
      await this.client.unlease({
        leaseRef: handle.providerRef,
        sshHost: handle.target.workerHost ?? "",
      });
    } catch {
      /* best-effort teardown */
    }
  }
}
