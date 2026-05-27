import { test, expect } from "vitest";
import type { Settings } from "@symphony/domain";
import type { RemoteShellPort } from "@symphony/ports";

import { WorkerPool, SshHostProvider } from "@symphony/worker-pool";

function makeSettings(
  worker: { sshHosts: string[]; maxConcurrentAgentsPerHost?: number; sshTimeoutMs?: number },
  maxConcurrentAgents = 10,
): Settings {
  return {
    worker: {
      sshHosts: worker.sshHosts,
      sshTimeoutMs: worker.sshTimeoutMs ?? 60_000,
      ...(worker.maxConcurrentAgentsPerHost !== undefined
        ? { maxConcurrentAgentsPerHost: worker.maxConcurrentAgentsPerHost }
        : {}),
    },
    agent: { maxConcurrentAgents },
  } as unknown as Settings;
}

test("reserves a local target when no ssh hosts are configured", async () => {
  const pool = new WorkerPool({ settings: () => makeSettings({ sshHosts: [] }) });

  expect(pool.capacityAvailable()).toBe(true);
  const lease = pool.reserve("issue:0");
  expect(lease).not.toBeNull();
  expect(lease?.handle.target.workerHost).toBeNull();
  expect(lease?.handle.providerKind).toBe("local");
  expect(pool.leaseCount()).toBe(1);

  await pool.release(lease?.handle.id);
  expect(pool.leaseCount()).toBe(0);
});

test("places onto the least-loaded ssh host and respects the per-host cap", async () => {
  const pool = new WorkerPool({
    settings: () => makeSettings({ sshHosts: ["worker-a", "worker-b"], maxConcurrentAgentsPerHost: 1 }),
  });

  const first = pool.reserve("i1:0");
  const second = pool.reserve("i2:0");
  expect(first?.handle.target.workerHost).toBe("worker-a");
  expect(second?.handle.target.workerHost).toBe("worker-b");

  // Both hosts at cap → no capacity.
  expect(pool.capacityAvailable()).toBe(false);
  expect(pool.reserve("i3:0")).toBeNull();

  // Freeing worker-a makes it the least loaded again.
  await pool.release(first?.handle.id);
  expect(pool.capacityAvailable()).toBe(true);
  expect(pool.reserve("i3:0")?.handle.target.workerHost).toBe("worker-a");
});

test("observes settings changes between reservations (hot reload)", () => {
  let settings = makeSettings({ sshHosts: [] });
  const pool = new WorkerPool({ settings: () => settings });

  expect(pool.reserve("a:0")?.handle.providerKind).toBe("local");

  settings = makeSettings({ sshHosts: ["worker-a"] });
  expect(pool.reserve("b:0")?.handle.providerKind).toBe("ssh");
});

test("snapshot reports assigned counts by provider kind", () => {
  const pool = new WorkerPool({
    settings: () => makeSettings({ sshHosts: ["worker-a", "worker-b"], maxConcurrentAgentsPerHost: 2 }),
  });
  pool.reserve("i1:0");
  pool.reserve("i2:0");

  const snapshot = pool.snapshot();
  expect(snapshot.total).toBe(2);
  expect(snapshot.assigned).toBe(2);
  expect(snapshot.byKind.ssh?.assigned).toBe(2);
});

test("ssh health check reflects probe success and failure", async () => {
  const failing: RemoteShellPort = {
    async run() {
      throw new Error("unreachable");
    },
  };
  const config = () => ({ sshHosts: ["worker-a"], cap: 1, sshTimeoutMs: 1_000 });
  const healthy: RemoteShellPort = { async run() {
    return { stdout: "", stderr: "" };
  } };

  const sick = new SshHostProvider(config, undefined, failing);
  const ok = new SshHostProvider(config, undefined, healthy);
  const handle = ok.select({ leaseId: "lease-1", usage: { total: 0, perHost: new Map() } });
  expect(handle).not.toBeNull();

  expect(await sick.healthCheck(handle!)).toBe(false);
  expect(await ok.healthCheck(handle!)).toBe(true);
  // A local (null host) target needs no probe.
  expect(
    await ok.healthCheck({
      id: "x",
      providerKind: "local",
      target: { workerHost: null },
      createdAt: new Date(),
    }),
  ).toBe(true);
});
