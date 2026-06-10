import { startReverseTunnel } from "@symphony/ssh";

export interface RemoteMcpTunnelLease {
  workerHost: string;
  remotePort: number;
}

interface RemoteMcpTunnelEntry extends RemoteMcpTunnelLease {
  localHost: string;
  localPort: number;
  process: ReturnType<typeof startReverseTunnel>;
  refCount: number;
  exited: boolean;
}

export class WorkerHostPool {
  private nextRemoteMcpPort = 46_000;
  private readonly availableRemoteMcpPorts: number[] = [];
  private readonly remoteMcpTunnels = new Map<string, RemoteMcpTunnelEntry>();
  // Per-run tunnels are keyed by `${workerHost}#${runKey}`, NOT host-coalesced,
  // so each run owns a distinct entry (and distinct remote port). One run's
  // localPort change can never replace another run's entry.
  private readonly perRunMcpTunnels = new Map<string, RemoteMcpTunnelEntry>();

  acquireRemoteMcpTunnel(
    workerHost: string,
    localHost: string,
    localPort: number,
  ): RemoteMcpTunnelLease {
    const current = this.remoteMcpTunnels.get(workerHost);
    if (
      current &&
      !current.exited &&
      current.localHost === localHost &&
      current.localPort === localPort
    ) {
      current.refCount += 1;
      return { workerHost, remotePort: current.remotePort };
    }
    if (current) this.closeRemoteMcpTunnel(workerHost, current, true);

    const recycledPort = this.availableRemoteMcpPorts.shift();
    const remotePort = recycledPort ?? this.nextRemoteMcpPort;
    let process: ReturnType<typeof startReverseTunnel>;
    try {
      process = startReverseTunnel(workerHost, remotePort, localHost, localPort);
    } catch (error) {
      if (recycledPort !== undefined) this.recycleRemoteMcpPort(recycledPort);
      throw error;
    }
    if (recycledPort === undefined) this.nextRemoteMcpPort += 1;
    const entry: RemoteMcpTunnelEntry = {
      workerHost,
      localHost,
      localPort,
      process,
      refCount: 1,
      remotePort,
      exited: false,
    };
    this.remoteMcpTunnels.set(workerHost, entry);
    process.on("close", () => {
      entry.exited = true;
      if (this.remoteMcpTunnels.get(workerHost) === entry) {
        this.closeRemoteMcpTunnel(workerHost, entry, true);
      }
    });
    process.on("error", () => {
      entry.exited = true;
      if (this.remoteMcpTunnels.get(workerHost) === entry) {
        this.closeRemoteMcpTunnel(workerHost, entry, true);
      }
    });
    return { workerHost, remotePort };
  }

  releaseRemoteMcpTunnel(workerHost: string): void {
    const entry = this.remoteMcpTunnels.get(workerHost);
    if (!entry) return;
    if (entry.refCount > 1) {
      entry.refCount -= 1;
      return;
    }
    this.closeRemoteMcpTunnel(workerHost, entry, true);
  }

  openForRun(
    workerHost: string,
    runKey: string,
    localHost: string,
    localPort: number,
  ): RemoteMcpTunnelLease {
    const key = perRunKey(workerHost, runKey);
    const current = this.perRunMcpTunnels.get(key);
    if (
      current &&
      !current.exited &&
      current.localHost === localHost &&
      current.localPort === localPort
    ) {
      current.refCount += 1;
      return { workerHost, remotePort: current.remotePort };
    }
    if (current) this.closePerRunMcpTunnel(key, current, true);

    const remotePort = this.allocateRemoteMcpPort();
    const recycledPort = remotePort < this.nextRemoteMcpPort ? remotePort : undefined;
    let process: ReturnType<typeof startReverseTunnel>;
    try {
      process = startReverseTunnel(workerHost, remotePort, localHost, localPort);
    } catch (error) {
      if (recycledPort !== undefined) this.recycleRemoteMcpPort(recycledPort);
      throw error;
    }
    if (recycledPort === undefined) this.nextRemoteMcpPort += 1;
    const entry: RemoteMcpTunnelEntry = {
      workerHost,
      localHost,
      localPort,
      process,
      refCount: 1,
      remotePort,
      exited: false,
    };
    this.perRunMcpTunnels.set(key, entry);
    process.on("close", () => {
      entry.exited = true;
      if (this.perRunMcpTunnels.get(key) === entry) {
        this.closePerRunMcpTunnel(key, entry, true);
      }
    });
    process.on("error", () => {
      entry.exited = true;
      if (this.perRunMcpTunnels.get(key) === entry) {
        this.closePerRunMcpTunnel(key, entry, true);
      }
    });
    return { workerHost, remotePort };
  }

  closeForRun(workerHost: string, runKey: string): void {
    const key = perRunKey(workerHost, runKey);
    const entry = this.perRunMcpTunnels.get(key);
    if (!entry) return;
    if (entry.refCount > 1) {
      entry.refCount -= 1;
      return;
    }
    this.closePerRunMcpTunnel(key, entry, true);
  }

  // Allocate a remote port, reusing a recycled candidate only when no live
  // entry (host-keyed OR per-run) still holds it. This guards the
  // recycled-port-vs-stale-entry interaction under N concurrent live ports.
  private allocateRemoteMcpPort(): number {
    while (this.availableRemoteMcpPorts.length > 0) {
      const candidate = this.availableRemoteMcpPorts.shift()!;
      if (!this.isRemoteMcpPortLive(candidate)) return candidate;
    }
    return this.nextRemoteMcpPort;
  }

  private isRemoteMcpPortLive(remotePort: number): boolean {
    for (const entry of this.remoteMcpTunnels.values()) {
      if (entry.remotePort === remotePort) return true;
    }
    for (const entry of this.perRunMcpTunnels.values()) {
      if (entry.remotePort === remotePort) return true;
    }
    return false;
  }

  private closePerRunMcpTunnel(
    key: string,
    entry: RemoteMcpTunnelEntry,
    recyclePort: boolean,
  ): void {
    this.perRunMcpTunnels.delete(key);
    if (recyclePort) this.recycleRemoteMcpPort(entry.remotePort);
    if (!entry.exited) {
      entry.exited = true;
      entry.process.kill();
    }
  }

  private closeRemoteMcpTunnel(
    workerHost: string,
    entry: RemoteMcpTunnelEntry,
    recyclePort: boolean,
  ): void {
    this.remoteMcpTunnels.delete(workerHost);
    if (recyclePort) this.recycleRemoteMcpPort(entry.remotePort);
    if (!entry.exited) {
      entry.exited = true;
      entry.process.kill();
    }
  }

  private recycleRemoteMcpPort(remotePort: number): void {
    if (this.availableRemoteMcpPorts.includes(remotePort)) return;
    this.availableRemoteMcpPorts.push(remotePort);
    this.availableRemoteMcpPorts.sort((left, right) => left - right);
  }
}

function perRunKey(workerHost: string, runKey: string): string {
  return `${workerHost}#${runKey}`;
}

export const workerHostPool = new WorkerHostPool();
