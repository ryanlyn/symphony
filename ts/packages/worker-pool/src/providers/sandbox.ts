import { runSsh } from "@symphony/ssh";
import { systemClock, type ClockPort, type RemoteShellPort } from "@symphony/ports";

import type { WorkerProvider } from "../provider.js";
import type { PlacementInput, WorkerHandle } from "../types.js";

/**
 * Configuration the SandboxProvider reads at provision time. Kept narrow so
 * any backend (E2B, Daytona, a custom service) can drive it.
 */
export interface SandboxProviderConfig {
  template?: string | undefined;
  /** Sandbox-side TTL handed to the backend; also stamped onto the lease. */
  timeoutMs?: number | undefined;
  /** SSH probe timeout for `healthCheck`. */
  sshTimeoutMs: number;
}

/** Backend-agnostic API the SandboxProvider talks to. Wire E2B/Daytona/etc. here. */
export interface SandboxClient {
  create(opts: SandboxCreateOpts): Promise<SandboxInstance>;
  destroy(instance: SandboxInstance): Promise<void>;
}

export interface SandboxCreateOpts {
  template?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface SandboxInstance {
  /** Backend-native sandbox id; preserved on the lease for teardown. */
  sandboxId: string;
  /** OpenSSH destination (`user@host:port`) the existing executor/tunnel code consumes. */
  sshHost: string;
}

const defaultRemoteShell: RemoteShellPort = {
  async run(host, command, timeoutMs) {
    const result = await runSsh(host, command, timeoutMs !== undefined ? { timeoutMs } : {});
    if (result.status !== 0) throw new Error(`ssh_status_${result.status}`);
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

/**
 * Dynamic provider that leases an ephemeral sandbox per worker. The lease's
 * `target.workerHost` is the sandbox's SSH destination so all existing
 * workspace/executor/tunnel code keeps working unchanged (transport A in the
 * plan: SSH-into-sandbox).
 */
export class SandboxProvider implements WorkerProvider {
  readonly kind = "sandbox" as const;
  readonly reusable = true;
  readonly dynamic = true;

  constructor(
    private readonly client: SandboxClient,
    private readonly config: () => SandboxProviderConfig,
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
    const instance = await this.client.create({
      ...(cfg.template !== undefined ? { template: cfg.template } : {}),
      ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
    });
    return {
      id: input.leaseId,
      providerKind: "sandbox",
      target: { workerHost: instance.sshHost },
      providerRef: instance.sandboxId,
      createdAt: this.clock.now(),
      ...(cfg.timeoutMs !== undefined ? { ttlMs: cfg.timeoutMs } : {}),
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
      await this.client.destroy({
        sandboxId: handle.providerRef,
        sshHost: handle.target.workerHost ?? "",
      });
    } catch {
      /* best-effort teardown; lease is gone from the pool either way */
    }
  }
}
