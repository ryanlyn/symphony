import { test, expect } from "vitest";
import type { RemoteShellPort } from "@symphony/ports";

import { SandboxProvider, type SandboxClient } from "@symphony/worker-pool";

function fakeClient(): SandboxClient & { creates: number; destroys: number } {
  let counter = 0;
  const state = {
    creates: 0,
    destroys: 0,
    async create() {
      state.creates += 1;
      counter += 1;
      return { sandboxId: `sbx-${counter}`, sshHost: `runner@sbx-${counter}:22` };
    },
    async destroy() {
      state.destroys += 1;
    },
  };
  return state as SandboxClient & { creates: number; destroys: number };
}

test("provision calls client.create and stamps lease metadata", async () => {
  const client = fakeClient();
  const provider = new SandboxProvider(
    client,
    () => ({ template: "node-22", timeoutMs: 5_000, sshTimeoutMs: 1_000 }),
  );

  const handle = await provider.provision({
    leaseId: "lease-1",
    usage: { total: 0, perHost: new Map() },
  });

  expect(client.creates).toBe(1);
  expect(handle.providerKind).toBe("sandbox");
  expect(handle.target.workerHost).toBe("runner@sbx-1:22");
  expect(handle.providerRef).toBe("sbx-1");
  expect(handle.ttlMs).toBe(5_000);
});

test("release calls client.destroy with the sandbox id", async () => {
  const client = fakeClient();
  const provider = new SandboxProvider(client, () => ({ sshTimeoutMs: 1_000 }));
  const handle = await provider.provision({
    leaseId: "lease-1",
    usage: { total: 0, perHost: new Map() },
  });
  await provider.release(handle, { recycle: true });
  expect(client.destroys).toBe(1);
});

test("healthCheck shells out via the injected RemoteShellPort", async () => {
  const client = fakeClient();
  const failing: RemoteShellPort = {
    async run() {
      throw new Error("unreachable");
    },
  };
  const healthy: RemoteShellPort = {
    async run() {
      return { stdout: "", stderr: "" };
    },
  };
  const sick = new SandboxProvider(client, () => ({ sshTimeoutMs: 1_000 }), undefined, failing);
  const ok = new SandboxProvider(client, () => ({ sshTimeoutMs: 1_000 }), undefined, healthy);

  const handle = await ok.provision({ leaseId: "x", usage: { total: 0, perHost: new Map() } });
  expect(await sick.healthCheck(handle)).toBe(false);
  expect(await ok.healthCheck(handle)).toBe(true);
});
