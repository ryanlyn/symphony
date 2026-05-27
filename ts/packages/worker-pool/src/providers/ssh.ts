import { selectLeastLoadedHost } from "@symphony/policies/workerHost";
import { runSsh } from "@symphony/ssh";
import { systemClock, type ClockPort, type RemoteShellPort } from "@symphony/ports";

import type { WorkerProvider } from "../provider.js";
import type { PlacementInput, ProviderUsage, WorkerHandle } from "../types.js";

export interface SshProviderConfig {
  sshHosts: string[];
  /** Max concurrent agents per host before a host is considered full. */
  cap: number;
  /** Timeout for the health-check ssh probe. */
  sshTimeoutMs: number;
}

const defaultRemoteShell: RemoteShellPort = {
  async run(host, command, timeoutMs) {
    const result = await runSsh(host, command, timeoutMs !== undefined ? { timeoutMs } : {});
    if (result.status !== 0) throw new Error(`ssh_status_${result.status}`);
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

/**
 * Places agents onto a static pool of SSH hosts using least-loaded selection,
 * preserving the existing `worker.sshHosts` behavior behind the provider API.
 */
export class SshHostProvider implements WorkerProvider {
  readonly kind = "ssh" as const;
  readonly reusable = true;

  constructor(
    private readonly config: () => SshProviderConfig,
    private readonly clock: ClockPort = systemClock,
    private readonly shell: RemoteShellPort = defaultRemoteShell,
  ) {}

  hasCapacity(usage: ProviderUsage): boolean {
    return typeof this.pick(usage) === "string";
  }

  select(input: PlacementInput): WorkerHandle | null {
    const host = this.pick(input.usage);
    if (typeof host !== "string") return null;
    return {
      id: input.leaseId,
      providerKind: "ssh",
      target: { workerHost: host },
      createdAt: this.clock.now(),
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

  async release(): Promise<void> {}

  private pick(usage: ProviderUsage): string | null | undefined {
    const { sshHosts, cap } = this.config();
    return selectLeastLoadedHost({ hosts: sshHosts, runningCounts: usage.perHost, cap });
  }
}
