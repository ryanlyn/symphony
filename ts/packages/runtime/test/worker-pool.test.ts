import { test, expect } from "vitest";
import { normalizeIssue, parseConfig, runtimeAdapters } from "@symphony/cli";
import type { Issue, RunResult, WorkflowDefinition } from "@symphony/cli";
import type {
  PlacementInput,
  ReleaseOptions,
  WorkerHandle,
  WorkerProvider,
} from "@symphony/worker-pool";

import { SymphonyRuntime } from "@symphony/runtime";

class InlineSandboxProvider implements WorkerProvider {
  readonly kind = "sandbox" as const;
  readonly reusable = true;
  readonly dynamic = true;
  provisions = 0;
  releases = 0;
  recycles = 0;
  private counter = 0;

  hasCapacity(): boolean {
    return true;
  }
  select(): null {
    return null;
  }
  async provision(input: PlacementInput): Promise<WorkerHandle> {
    this.counter += 1;
    this.provisions += 1;
    return {
      id: input.leaseId,
      providerKind: "sandbox",
      target: { workerHost: `runner@sbx-${this.counter}:22` },
      providerRef: `sbx-${this.counter}`,
      createdAt: new Date(),
    };
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
  async release(_handle: WorkerHandle, opts: ReleaseOptions): Promise<void> {
    this.releases += 1;
    if (opts.recycle) this.recycles += 1;
  }
}

function workflow(): WorkflowDefinition {
  const settings = parseConfig({
    tracker: { kind: "memory" },
    worker: {
      pool: { provider: "sandbox", max_pool_size: 2, warm_pool_size: 1 },
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

function issueFixture(id: string, identifier: string): Issue {
  return normalizeIssue({ id, identifier, title: identifier, state: "Todo" });
}

test("runtime maintain() warm-fills via injected sandbox provider", async () => {
  const provider = new InlineSandboxProvider();
  const runtime = new SymphonyRuntime({
    ...runtimeAdapters,
    workflow: workflow(),
    workerProviders: { sandbox: provider },
    client: {
      fetchCandidateIssues: async () => [],
      fetchIssuesByIds: async () => [],
    },
    runner: async (): Promise<RunResult> => ({ resumeId: null, workspace: null, turnCount: 0 }),
  });

  await runtime.pollOnce({ dryRun: true });

  expect(provider.provisions).toBeGreaterThanOrEqual(1);
  expect(runtime.snapshot().workerPool?.ready).toBeGreaterThanOrEqual(1);
});

test("runtime stop tears down warm sandbox leases", async () => {
  const provider = new InlineSandboxProvider();
  const runtime = new SymphonyRuntime({
    ...runtimeAdapters,
    workflow: workflow(),
    workerProviders: { sandbox: provider },
    client: {
      fetchCandidateIssues: async () => [],
      fetchIssuesByIds: async () => [],
    },
    runner: async (): Promise<RunResult> => ({ resumeId: null, workspace: null, turnCount: 0 }),
  });

  await runtime.pollOnce({ dryRun: true });
  const initialProvisions = provider.provisions;
  runtime.stop();
  // Allow microtask queue to drain the async stop chain.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  expect(provider.releases).toBe(initialProvisions);
  expect(provider.recycles).toBe(initialProvisions);
});

// Use issueFixture to keep import-tree consistent with sibling tests.
void issueFixture;
