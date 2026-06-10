import os from "node:os";

import { Executor } from "@symphony/acp";
import {
  runAgentAttempt as runAgentAttemptCore,
  type RunAgentAttemptAdapters,
  type RunAgentAttemptInput,
  type RunResult,
} from "@symphony/agent-runner";
import type { DefaultSettingsOptions } from "@symphony/config";
import type { RuntimeTrackerClient, Settings } from "@symphony/domain";
import { createWorkspaceForIssue, removeIssueWorkspaces, runHook } from "@symphony/workspace";
import { appendLogEvent } from "@symphony/log-file";
import {
  deleteResumeState,
  readResumeState,
  resumeStateMatches,
  writeResumeState,
} from "@symphony/resume-state";
import { defaultTrackerRegistry } from "@symphony/tracker-sdk";
import { registerBuiltinTrackerProviders } from "@symphony/trackers";

// Composition root: the CLI decides which tracker backends this binary supports. Everything
// downstream (config parsing, dispatch, MCP tools) resolves them through the registry.
registerBuiltinTrackerProviders();

export function runtimeDefaultSettingsOptions(): DefaultSettingsOptions {
  return { tmpdir: os.tmpdir() };
}

export function createTrackerClient(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTrackerClient {
  return defaultTrackerRegistry.require(settings.tracker.kind).createClient(settings, { env });
}

function createRunAgentAttemptAdapters(): RunAgentAttemptAdapters {
  return {
    createWorkspaceForIssue,
    runHook,
    readResumeState,
    resumeStateMatches,
    writeResumeState,
    executorFactory: (settings) => {
      const agent = settings.agents[settings.agent.kind];
      if (!agent) throw new Error(`agents.${settings.agent.kind} is required`);
      return new Executor(settings.agent.kind);
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
