import os from "node:os";
import path from "node:path";

import { AcpExecutor } from "@symphony/acp";
import {
  runAgentAttempt as runAgentAttemptCore,
  type RunAgentAttemptAdapters,
  type RunAgentAttemptInput,
  type RunResult,
} from "@symphony/agent-runner";
import { defaultSettings, type DefaultSettingsOptions } from "@symphony/config";
import { CodexAppServerExecutor } from "@symphony/codex";
import type { RuntimeTrackerClient, Settings } from "@symphony/domain";
import { systemClock } from "@symphony/ports";
import { acquireAgentMcpEndpointForRun } from "@symphony/mcp";
import { createBoxPool, type BoxPool } from "@symphony/worker-box-pool";
import {
  createDispatchCoordinator,
  createPerRunEndpointManager,
  type DispatchCoordinator,
} from "@symphony/dispatch-coordinator";
import { createWorkspaceForIssue, removeIssueWorkspaces, runHook } from "@symphony/workspace";
import { appendLogEvent } from "@symphony/log-file";
import {
  deleteResumeState,
  readResumeState,
  resumeStateMatches,
  writeResumeState,
} from "@symphony/resume-state";
import { LinearClient } from "@symphony/linear-tracker";
import { MemoryTrackerClient, memoryIssuesFromEnv } from "@symphony/memory-tracker";

export function runtimeDefaultSettings(): Settings {
  return defaultSettings(runtimeDefaultSettingsOptions());
}

export function runtimeDefaultSettingsOptions(): DefaultSettingsOptions {
  return { tmpdir: os.tmpdir(), cwd: process.cwd() };
}

export function createTrackerClient(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTrackerClient {
  if (settings.tracker.kind === "memory") return new MemoryTrackerClient(memoryIssuesFromEnv(env));
  if (settings.tracker.kind === "linear") return new LinearClient(settings);
  throw new Error("tracker.kind is required");
}

/**
 * Constructs the warm worker box pool when `worker.box_pool.enabled` is set, and
 * returns `undefined` otherwise so the disabled path stays byte-identical to the
 * pre-pool daemon. Built-in providers (`fake`, `static-ssh`, ...) self-register
 * on the `@symphony/worker-box-pool` barrel import; `createBoxPool` resolves the
 * configured `provider` against that registry and throws
 * `box_pool_provider_unavailable` for an unregistered enabled kind, so an
 * operator misconfiguration fails loud at startup rather than silently disabling
 * the pool. The write-ahead ledger (only consulted by cloud providers) lives
 * under `<workspace.root>/.symphony/box-pool/`.
 */
export function buildBoxPool(
  settings: Settings,
  _env: NodeJS.ProcessEnv = process.env,
): BoxPool | undefined {
  const boxPoolSettings = settings.worker.boxPool;
  if (!boxPoolSettings?.enabled) return undefined;
  return createBoxPool(boxPoolSettings, {
    clock: systemClock,
    logEvent: (event: Record<string, unknown>) =>
      void appendLogEvent(settings.logging.logFile, event),
    ledgerPath: path.join(settings.workspace.root, ".symphony", "box-pool", "ledger.json"),
  });
}

/**
 * Constructs the runtime-facing {@link DispatchCoordinator} when
 * `worker.box_pool.enabled` is set, wrapping the same {@link BoxPool} that
 * {@link buildBoxPool} builds and the injected {@link McpEndpointManager}. Returns
 * `undefined` when the pool is disabled so the disabled path stays byte-identical
 * to the pre-pool daemon.
 *
 * The CONCRETE per-run {@link McpEndpointManager} (`perRunEndpoint=true`) is wired
 * here: it OWNS the whole per-run MCP endpoint lease (auth token + refcounted local
 * mcp server + reverse tunnel) via the injected `acquireAgentMcpEndpointForRun`. The
 * daemon is the right ownership boundary because it already depends on
 * `@symphony/mcp`, keeping `@symphony/worker-box-pool` and
 * `@symphony/dispatch-coordinator` free of any mcp/tunnel runtime dependency
 * (invariant #8). At the default `slotsPerMachine=1` this opens exactly ONE endpoint
 * per run (just coordinator-owned), and the manager returns `null` for a
 * `null`/`pending://` worker host so the local path keeps using acp's own endpoint -
 * byte-identical to the single-tenant path. `buildBoxPool` stays for the box-pool
 * wiring / e2e tests and for any caller that still wants a bare pool.
 */
export function buildDispatchCoordinator(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): DispatchCoordinator | undefined {
  const boxPoolSettings = settings.worker.boxPool;
  if (!boxPoolSettings?.enabled) return undefined;
  const pool = buildBoxPool(settings, env);
  if (!pool) return undefined;
  return createDispatchCoordinator({
    pool,
    // The concrete manager OWNS each run's whole endpoint lease; it calls the
    // injected `acquireAgentMcpEndpointForRun` (signature-compatible) for an
    // ssh-addressable host and returns null for a null/`pending://` host so the
    // local path keeps using acp's own endpoint.
    mcpEndpointManager: createPerRunEndpointManager({
      acquireForRun: acquireAgentMcpEndpointForRun,
    }),
    settings: boxPoolSettings,
  });
}

export function createRunAgentAttemptAdapters(): RunAgentAttemptAdapters {
  return {
    createWorkspaceForIssue,
    runHook,
    readResumeState,
    resumeStateMatches,
    writeResumeState,
    executorFactory: (settings) => {
      const agent = settings.agents[settings.agent.kind];
      if (!agent) throw new Error(`agents.${settings.agent.kind} is required`);
      if (agent.executor === "appserver") return new CodexAppServerExecutor();
      if (agent.executor === "acp") return new AcpExecutor(settings.agent.kind);
      throw new Error(`unsupported agents.${settings.agent.kind}.executor`);
    },
  };
}

export async function runAgentAttempt(input: RunAgentAttemptInput): Promise<RunResult> {
  return runAgentAttemptCore({
    ...input,
    adapters: { ...createRunAgentAttemptAdapters(), ...input.adapters },
  });
}

export const runtimeAdapters = {
  removeIssueWorkspaces,
  deleteResumeState,
  appendLogEvent,
};
