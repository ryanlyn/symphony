import { test, expect } from "vitest";
import { parseConfig, runtimeAdapters } from "@symphony/cli";
import type { RunResult, WorkflowDefinition } from "@symphony/cli";
import type { RemoteShellPort } from "@symphony/ports";
import { BrokerProvider, type BrokerClient } from "@symphony/worker-pool";

import { SymphonyRuntime } from "@symphony/runtime";

const healthyShell: RemoteShellPort = {
  async run() {
    return { stdout: "", stderr: "" };
  },
};

function workflow(): WorkflowDefinition {
  const settings = parseConfig({
    tracker: { kind: "memory" },
    worker: {
      pool: {
        provider: "broker",
        max_pool_size: 2,
        warm_pool_size: 1,
        broker: { endpoint: "https://broker.example.com/v1/leases" },
      },
    },
    agent: { max_concurrent_agents: 2 },
  });
  return {
    path: "/tmp/workflow.md",
    config: {},
    settings,
    promptTemplate: "{{issue.identifier}}",
  };
}

function fakeBroker(): BrokerClient & { leased: number; unleased: number } {
  let counter = 0;
  const state = {
    leased: 0,
    unleased: 0,
    async lease() {
      state.leased += 1;
      counter += 1;
      return { leaseRef: `cb-${counter}`, sshHost: `runner@cb-${counter}:22`, ttlMs: 60_000 };
    },
    async unlease() {
      state.unleased += 1;
    },
  };
  return state as BrokerClient & { leased: number; unleased: number };
}

test("runtime drives a broker provider end-to-end (warm-fill + stop teardown)", async () => {
  const broker = fakeBroker();
  const provider = new BrokerProvider(broker, () => ({ sshTimeoutMs: 1_000 }), undefined, healthyShell);
  const runtime = new SymphonyRuntime({
    ...runtimeAdapters,
    workflow: workflow(),
    workerProviders: { broker: provider },
    client: {
      fetchCandidateIssues: async () => [],
      fetchIssuesByIds: async () => [],
    },
    runner: async (): Promise<RunResult> => ({ resumeId: null, workspace: null, turnCount: 0 }),
  });

  await runtime.pollOnce({ dryRun: true });
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(broker.leased).toBeGreaterThanOrEqual(1);

  const snap = runtime.snapshot().workerPool;
  expect(snap?.byKind.broker?.ready ?? 0).toBeGreaterThanOrEqual(1);

  runtime.stop();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  expect(broker.unleased).toBe(broker.leased);
});
