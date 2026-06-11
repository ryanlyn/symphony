import os from "node:os";
import path from "node:path";

import { acpExecutorProvider } from "@symphony/acp";
import { defaultAgentExecutorRegistry, type AgentExecutorRegistry } from "@symphony/agent-sdk";
import {
  runAgentAttempt as runAgentAttemptCore,
  type RunAgentAttemptAdapters,
  type RunAgentAttemptInput,
  type RunResult,
} from "@symphony/agent-runner";
import {
  defaultBoxDriverRegistry,
  registerFakeBoxDriver,
  type BoxDriverRegistry,
} from "@symphony/box-sdk";
import type { DefaultSettingsOptions } from "@symphony/config";
import { registerDockerBoxDriver } from "@symphony/docker-box-driver";
import { systemClock, type RuntimeTrackerClient, type Settings } from "@symphony/domain";
import { registerE2bBoxDriver } from "@symphony/e2b-box-driver";
import { registerFlyBoxDriver } from "@symphony/fly-box-driver";
import { registerJiraTrackers } from "@symphony/jira-tracker";
import { registerLinearTracker } from "@symphony/linear-tracker";
import { registerLocalTracker } from "@symphony/local-tracker";
import { registerMemoryTracker } from "@symphony/memory-tracker";
import { registerModalBoxDriver } from "@symphony/modal-box-driver";
import { registerStaticSshBoxDriver } from "@symphony/static-ssh-box-driver";
import { acquireAgentMcpEndpointForRun } from "@symphony/mcp";
import { createBoxPool, type BoxPool } from "@symphony/worker-box-pool";
import {
  createDispatchCoordinator,
  createPerRunEndpointManager,
  type DispatchCoordinator,
} from "@symphony/dispatch-coordinator";
import {
  createWorkspaceForIssue,
  listIssueWorkspaceIdentifiers,
  removeIssueWorkspaces,
  runHook,
} from "@symphony/workspace";
import { appendLogEvent } from "@symphony/log-file";
import {
  deleteResumeState,
  readResumeState,
  resumeStateMatches,
  writeResumeState,
} from "@symphony/resume-state";
import { defaultToolRegistry, type ToolRegistry } from "@symphony/tool-sdk";
import {
  createTrackerToolProvider,
  defaultTrackerRegistry,
  type TrackerRegistry,
} from "@symphony/tracker-sdk";

export interface BackendRegistries {
  trackers?: TrackerRegistry | undefined;
  tools?: ToolRegistry | undefined;
  executors?: AgentExecutorRegistry | undefined;
  boxDrivers?: BoxDriverRegistry | undefined;
}

/**
 * Composition root: the CLI decides which extensions and agent executors this binary
 * supports. Each extension registers itself; the CLI only lists them here. Everything
 * downstream (config parsing, dispatch validation, MCP tools, executor selection)
 * resolves through the registries. Called from every CLI entrypoint before config is
 * parsed; idempotent so entrypoints and tests can call it freely.
 */
export function registerBuiltinBackends(registries: BackendRegistries = {}): void {
  const trackers = registries.trackers ?? defaultTrackerRegistry;
  const tools = registries.tools ?? defaultToolRegistry;
  const executors = registries.executors ?? defaultAgentExecutorRegistry;

  registerLinearTracker({ trackers, tools });
  registerLocalTracker({ trackers, tools });
  registerMemoryTracker({ trackers });
  registerJiraTrackers({ trackers });
  if (tools.get("tracker") === undefined) {
    tools.register(createTrackerToolProvider(trackers));
  }
  if (executors.get(acpExecutorProvider.executor) === undefined) {
    executors.register(acpExecutorProvider);
  }

  const boxDrivers = registries.boxDrivers ?? defaultBoxDriverRegistry;
  registerFakeBoxDriver({ boxDrivers });
  registerStaticSshBoxDriver({ boxDrivers });
  registerDockerBoxDriver({ boxDrivers });
  registerFlyBoxDriver({ boxDrivers });
  // e2b/modal register fail-loud factories here: the stock daemon ships no
  // cloud client/transport, so enabling those kinds points the operator at the
  // configured registration (registerE2bBoxDriver(registries, { client }) /
  // registerModalBoxDriver(registries, { transport })) instead of failing at
  // first provision.
  registerE2bBoxDriver({ boxDrivers });
  registerModalBoxDriver({ boxDrivers });
}

export function runtimeDefaultSettingsOptions(): DefaultSettingsOptions {
  return { tmpdir: os.tmpdir() };
}

export function createTrackerClient(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTrackerClient {
  return defaultTrackerRegistry.require(settings.tracker.kind).createClient(settings, { env });
}

/**
 * Constructs the warm worker box pool when `worker.box_pool.enabled` is set, and
 * returns `undefined` otherwise so the disabled path stays byte-identical to the
 * pre-pool daemon. The pool resolves the configured `driver` against the
 * box-driver registry populated by {@link registerBuiltinBackends}; an
 * unregistered enabled kind throws `box_pool_driver_unavailable`, so an operator
 * misconfiguration fails loud at startup rather than silently disabling the
 * pool. The write-ahead ledger (only consulted by cloud drivers) lives under
 * `<workspace.root>/.symphony/box-pool/`.
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
    drivers: defaultBoxDriverRegistry,
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
    // Same structured-event sink as the pool so coordinator faults (e.g.
    // box_pool_endpoint_release_failed) reach the log file instead of being
    // silently dropped by the no-op default.
    logEvent: (event: Record<string, unknown>) =>
      void appendLogEvent(settings.logging.logFile, event),
    settings: boxPoolSettings,
  });
}

function createRunAgentAttemptAdapters(): RunAgentAttemptAdapters {
  return {
    createWorkspaceForIssue,
    runHook,
    readResumeState,
    resumeStateMatches,
    writeResumeState,
    executorFactory: async (settings) => {
      const kind = settings.agent.kind;
      const agent = settings.agents[kind];
      if (!agent) throw new Error(`agents.${kind} is required`);
      return defaultAgentExecutorRegistry.require(agent.executor).createExecutor(kind, settings);
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
  listIssueWorkspaces: listIssueWorkspaceIdentifiers,
  deleteResumeState,
  appendLogEvent,
};
