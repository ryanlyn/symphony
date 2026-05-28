import { test, expect } from "vitest";

import { BrokerProvider, type BrokerClient } from "@symphony/worker-pool";

function fakeBroker(): BrokerClient & { leased: number; unleased: number } {
  let counter = 0;
  const state = {
    leased: 0,
    unleased: 0,
    async lease() {
      state.leased += 1;
      counter += 1;
      return { leaseRef: `lease-${counter}`, sshHost: `runner@cb-${counter}:22`, ttlMs: 60_000 };
    },
    async unlease() {
      state.unleased += 1;
    },
  };
  return state as BrokerClient & { leased: number; unleased: number };
}

test("broker provision delegates to the broker client", async () => {
  const client = fakeBroker();
  const provider = new BrokerProvider(client, () => ({ sshTimeoutMs: 1_000 }));
  const handle = await provider.provision({
    leaseId: "lease-1",
    usage: { total: 0, perHost: new Map() },
  });

  expect(client.leased).toBe(1);
  expect(handle.providerKind).toBe("broker");
  expect(handle.target.workerHost).toBe("runner@cb-1:22");
  expect(handle.providerRef).toBe("lease-1");
  expect(handle.ttlMs).toBe(60_000);
});

test("broker release calls unlease", async () => {
  const client = fakeBroker();
  const provider = new BrokerProvider(client, () => ({ sshTimeoutMs: 1_000 }));
  const handle = await provider.provision({
    leaseId: "x",
    usage: { total: 0, perHost: new Map() },
  });
  await provider.release(handle, { recycle: true });
  expect(client.unleased).toBe(1);
});
