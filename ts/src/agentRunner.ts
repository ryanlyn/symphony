import { settingsForIssueState } from "./config.js";
import { issueIsActive } from "./dispatch.js";
import { ensembleSize } from "./issue.js";
import { buildPrompt, continuationPrompt } from "./prompt.js";
import { readResumeState, resumeStateMatches, writeResumeState } from "./resumeState.js";
import { createWorkspaceForIssue, runHook } from "./workspace.js";
import { AcpExecutor } from "./executors/acpExecutor.js";
import { CodexAppServerExecutor } from "./executors/codexAppServer.js";
import type { AgentExecutor, AgentUpdate, Issue, Settings, WorkflowDefinition } from "./types.js";

export interface RunResult {
  workspace: string;
  turnCount: number;
  updates: AgentUpdate[];
  resumeId?: string | null | undefined;
  agentKind: string;
  finalIssue?: Issue | undefined;
}

export interface RunAgentAttemptInput {
  issue: Issue;
  workflow: WorkflowDefinition;
  settings?: Settings;
  workerHost?: string | null;
  slotIndex?: number;
  attempt?: number | null;
  onUpdate?: (update: AgentUpdate) => void;
  fetchIssue?: (issue: Issue) => Promise<Issue>;
  abortSignal?: AbortSignal | undefined;
}

export async function runAgentAttempt(input: RunAgentAttemptInput): Promise<RunResult> {
  return new RunController(input).run();
}

export class RunController {
  constructor(private readonly input: RunAgentAttemptInput) {}

  async run(): Promise<RunResult> {
    const input = this.input;
    let issue = input.issue;
    const settings = input.settings ?? input.workflow.settings;
    let runtime = settingsForIssueState(settings, issue.state);
    const size = ensembleSize(issue) ?? settings.agent.ensembleSize;
    const slotIndex = input.slotIndex ?? 0;
    const workspace = await createWorkspaceForIssue(runtime, issue, {
      slotIndex,
      ensembleSize: size,
      workerHost: input.workerHost ?? null,
    });
    const workerHost = input.workerHost ?? null;
    input.onUpdate?.({ type: "workspace_prepared", workspacePath: workspace });
    if (runtime.hooks.beforeRun)
      await runHook(runtime.hooks.beforeRun, workspace, runtime.hooks, workerHost);

    const resume = await readResumeState(workspace, workerHost, runtime.worker.sshTimeoutMs);
    const resumeMatches =
      resume.status === "ok" &&
      resumeStateMatches(resume.state, {
        agentKind: runtime.agent.kind,
        issue,
        workspacePath: workspace,
        workerHost,
      });
    if (resume.status === "error")
      input.onUpdate?.({
        type: "resume_state_warning",
        workspacePath: workspace,
        message: resume.reason,
      });
    else if (resume.status === "ok" && !resumeMatches)
      input.onUpdate?.({
        type: "resume_state_warning",
        workspacePath: workspace,
        message: "resume_state_identity_mismatch",
      });
    const resumeId = resumeMatches ? resume.state.resumeId : null;

    const executor = executorFor(runtime);
    const updates: AgentUpdate[] = [];
    const session = await executor.startSession({
      workspace,
      workerHost,
      issue,
      settings: runtime,
      resumeId,
      onUpdate: (update) => {
        updates.push(update);
        input.onUpdate?.(update);
      },
    });

    let turnCount = 0;
    try {
      while (turnCount < runtime.agent.maxTurns) {
        throwIfAborted(input.abortSignal);
        const prompt =
          turnCount === 0
            ? await buildPrompt(input.workflow.promptTemplate, issue, {
                attempt: input.attempt ?? null,
                slotIndex,
                ensembleSize: size,
              })
            : continuationPrompt(turnCount + 1, runtime.agent.maxTurns);
        await runTurnWithAbort(executor, session, prompt, issue, input.abortSignal);
        turnCount += 1;
        await persistResumeState(session, runtime, issue, workspace, workerHost);

        if (!input.fetchIssue) break;
        issue = await input.fetchIssue(issue);
        if (!issueIsActive(issue, settings)) break;
        const refreshed = settingsForIssueState(settings, issue.state);
        if (
          refreshed.agent.kind !== runtime.agent.kind ||
          backendProfile(refreshed) !== backendProfile(runtime)
        ) {
          break;
        }
        runtime = refreshed;
      }
    } finally {
      await session.stop();
      if (runtime.hooks.afterRun) {
        try {
          await runHook(runtime.hooks.afterRun, workspace, runtime.hooks, workerHost);
        } catch {
          // after_run is best effort by SPEC.
        }
      }
    }

    await persistResumeState(session, runtime, issue, workspace, workerHost);

    return {
      workspace,
      turnCount,
      updates,
      resumeId: session.resumeId,
      agentKind: runtime.agent.kind,
      finalIssue: issue,
    };
  }
}

async function runTurnWithAbort(
  executor: AgentExecutor,
  session: Awaited<ReturnType<AgentExecutor["startSession"]>>,
  prompt: string,
  issue: Issue,
  abortSignal: AbortSignal | undefined,
): Promise<AgentUpdate[]> {
  if (!abortSignal) return executor.runTurn(session, prompt, issue);
  throwIfAborted(abortSignal);
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<AgentUpdate[]>((_resolve, reject) => {
    onAbort = () => {
      reject(new Error("agent_run_aborted"));
      void session.stop();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([executor.runTurn(session, prompt, issue), abortPromise]);
  } finally {
    if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(abortSignal: AbortSignal | undefined): void {
  if (!abortSignal?.aborted) return;
  throw new Error("agent_run_aborted");
}

function executorFor(settings: Settings): AgentExecutor {
  const agent = settings.agents[settings.agent.kind];
  if (!agent) throw new Error(`agents.${settings.agent.kind} is required`);
  if (agent.executor === "appserver") return new CodexAppServerExecutor();
  if (agent.executor === "acp") return new AcpExecutor(settings.agent.kind);
  throw new Error(`unsupported agents.${settings.agent.kind}.executor`);
}

function backendProfile(settings: Settings): string {
  return JSON.stringify(settings.agents[settings.agent.kind] ?? null);
}

async function persistResumeState(
  session: Awaited<ReturnType<AgentExecutor["startSession"]>>,
  runtime: Settings,
  issue: Issue,
  workspace: string,
  workerHost: string | null,
): Promise<void> {
  if (!session.resumeId) return;
  await writeResumeState(
    workspace,
    {
      agentKind: runtime.agent.kind,
      resumeId: session.resumeId,
      sessionId: session.sessionId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueState: issue.state,
      workspacePath: workspace,
      workerHost,
    },
    workerHost,
    runtime.worker.sshTimeoutMs,
  );
}
