import { settingsForIssueState } from "@symphony/config";
import { issueIsActive } from "@symphony/dispatch";
import type { AgentMcpEndpointLease } from "@symphony/mcp";
import { ensembleSize } from "@symphony/issue";
import { buildPrompt, continuationPrompt } from "@symphony/prompt";
import type {
  AgentExecutor,
  AgentSession,
  AgentUpdate,
  Issue,
  Settings,
  WorkflowDefinition,
} from "@symphony/domain";

interface ResumeStateShape {
  agentKind: string;
  resumeId: string;
  sessionId?: string | null | undefined;
  issueId?: string | null | undefined;
  issueIdentifier?: string | null | undefined;
  issueState?: string | null | undefined;
  workspacePath?: string | null | undefined;
  workerHost?: string | null | undefined;
}

type ResumeReadResult =
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "error"; reason: string }
  | { status: "ok"; state: ResumeStateShape };

export interface RunAgentAttemptAdapters {
  createWorkspaceForIssue(
    settings: Settings,
    issue: Issue,
    options: {
      slotIndex: number;
      ensembleSize: number;
      workerHost: string | null;
      forceSlotSuffix?: boolean;
    },
  ): Promise<string>;
  runHook(
    command: string,
    workspace: string,
    hooks: Settings["hooks"],
    workerHost: string | null,
  ): Promise<void>;
  readResumeState(
    workspace: string,
    workerHost?: string | null,
    timeoutMs?: number,
  ): Promise<ResumeReadResult>;
  resumeStateMatches(
    state: ResumeStateShape,
    input: { agentKind: string; issue: Issue; workspacePath: string; workerHost: string | null },
  ): boolean;
  writeResumeState(
    workspace: string,
    state: ResumeStateShape,
    workerHost: string | null,
    timeoutMs: number,
  ): Promise<void>;
  executorFactory(settings: Settings): Promise<AgentExecutor> | AgentExecutor;
}

/**
 * The executor `startSession` input EXTENDED with the optional per-run
 * `mcpEndpoint` lease. The base is the shared `AgentExecutor.startSession`
 * parameter (so every required field stays in lockstep with the interface); the
 * extra optional `mcpEndpoint` is carried through to the executors' widened inputs
 * (acp consumes it, codex ignores it). Building the call argument as this type
 * keeps the value assignable to the narrower interface param without an
 * excess-property error on a fresh literal.
 */
type StartSessionInput = Parameters<AgentExecutor["startSession"]>[0] & {
  mcpEndpoint?: AgentMcpEndpointLease | null;
};

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
  /**
   * The dispatch coordinator's per-run MCP endpoint lease for THIS run, threaded
   * straight into `executor.startSession`. When present (non-null) the acp executor
   * USES it and skips acquiring/releasing its own endpoint (the coordinator owns the
   * whole lease); the codex executor ignores it. Absent / null on the local /
   * non-pool path, where acp acquires AND releases its own endpoint byte-for-byte.
   */
  mcpEndpoint?: AgentMcpEndpointLease | null;
  /**
   * Gated co-residence override for the workspace layout. When `true` the slot
   * suffix is applied UNCONDITIONALLY (so two solo runs of one issue co-residing on
   * one machine get distinct `<issue>/<slotIndex>` dirs instead of sharing the bare
   * path); the coordinator/runtime sets it only when `slotsPerMachine > 1`
   * co-residence is active. Absent / `false` (the default) keeps the single-slot
   * bare layout byte-identical.
   */
  forceSlotSuffix?: boolean;
  onUpdate?: (update: AgentUpdate) => void;
  fetchIssue?: (issue: Issue) => Promise<Issue>;
  abortSignal?: AbortSignal | undefined;
  adapters?: Partial<RunAgentAttemptAdapters> | undefined;
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
    const workerHost = input.workerHost ?? null;
    const workspace = await createWorkspaceForIssue(input.adapters, runtime, issue, {
      slotIndex,
      ensembleSize: size,
      workerHost,
      // Gated co-residence: force the slot suffix so two solo same-issue runs that
      // co-reside on one machine get distinct dirs. Default false keeps the
      // single-slot bare layout byte-identical.
      forceSlotSuffix: input.forceSlotSuffix ?? false,
    });
    input.onUpdate?.({ type: "workspace_prepared", workspacePath: workspace });
    if (runtime.hooks.beforeRun) {
      await runHook(input.adapters, runtime.hooks.beforeRun, workspace, runtime.hooks, workerHost);
    }

    const resume = await readResumeState(
      input.adapters,
      workspace,
      workerHost,
      runtime.worker.sshTimeoutMs,
    );
    const resumeMatches =
      resume.status === "ok" &&
      resumeStateMatches(input.adapters, resume.state, {
        agentKind: runtime.agent.kind,
        issue,
        workspacePath: workspace,
        workerHost,
      });
    if (resume.status === "error") {
      input.onUpdate?.({
        type: "resume_state_warning",
        workspacePath: workspace,
        message: resume.reason,
      });
    } else if (resume.status === "ok" && !resumeMatches) {
      input.onUpdate?.({
        type: "resume_state_warning",
        workspacePath: workspace,
        message: "resume_state_identity_mismatch",
      });
    }
    const resumeId = resumeMatches ? resume.state.resumeId : null;

    const executor = await executorFor(input.adapters, runtime);
    const updates: AgentUpdate[] = [];
    // Thread the coordinator's per-run endpoint (or null on the local/non-pool
    // path) into the executor. acp consumes a non-null lease and skips its own
    // acquire+release; codex ignores it. Built as a typed value so the optional
    // `mcpEndpoint` field is carried to the executor's widened input without
    // tripping the excess-property check on the narrower `AgentExecutor` interface.
    // The field is a DECLARED optional on `StartSessionInput`, and acp/codex both
    // read an absent value as null, so the explicit `null` is the deliberate, pinned
    // disabled-path contract (a strict adapter rejecting a declared optional field
    // would be its own bug) - we keep it rather than omit the key.
    const startSessionInput: StartSessionInput = {
      workspace,
      workerHost,
      issue,
      settings: runtime,
      resumeId,
      mcpEndpoint: input.mcpEndpoint ?? null,
      onUpdate: (update) => {
        updates.push(update);
        input.onUpdate?.(update);
      },
    };
    const session = await executor.startSession(startSessionInput);

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
        await persistResumeState(input.adapters, session, runtime, issue, workspace, workerHost);

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
          await runHook(
            input.adapters,
            runtime.hooks.afterRun,
            workspace,
            runtime.hooks,
            workerHost,
          );
        } catch {
          // after_run is best effort by SPEC.
        }
      }
    }

    await persistResumeState(input.adapters, session, runtime, issue, workspace, workerHost);

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
  session: AgentSession,
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
      void session.stop().catch((err) => {
        process.stderr.write(`session.stop failed: ${err}\n`);
      });
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

async function executorFor(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  settings: Settings,
): Promise<AgentExecutor> {
  if (adapters?.executorFactory) return adapters.executorFactory(settings);
  throw new Error("agent_runner_adapter_missing: executorFactory");
}

function backendProfile(settings: Settings): string {
  return JSON.stringify(settings.agents[settings.agent.kind] ?? null);
}

async function persistResumeState(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  session: AgentSession,
  runtime: Settings,
  issue: Issue,
  workspace: string,
  workerHost: string | null,
): Promise<void> {
  if (!session.resumeId) return;
  await writeResumeState(
    adapters,
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

async function createWorkspaceForIssue(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  settings: Settings,
  issue: Issue,
  options: {
    slotIndex: number;
    ensembleSize: number;
    workerHost: string | null;
    forceSlotSuffix?: boolean;
  },
): Promise<string> {
  if (adapters?.createWorkspaceForIssue)
    return adapters.createWorkspaceForIssue(settings, issue, options);
  throw new Error("agent_runner_adapter_missing: createWorkspaceForIssue");
}

async function runHook(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  command: string,
  workspacePath: string,
  hooks: Settings["hooks"],
  workerHost: string | null,
): Promise<void> {
  if (adapters?.runHook) return adapters.runHook(command, workspacePath, hooks, workerHost);
  throw new Error("agent_runner_adapter_missing: runHook");
}

async function readResumeState(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  workspacePath: string,
  workerHost: string | null,
  timeoutMs: number,
): Promise<ResumeReadResult> {
  if (adapters?.readResumeState)
    return adapters.readResumeState(workspacePath, workerHost, timeoutMs);
  throw new Error("agent_runner_adapter_missing: readResumeState");
}

function resumeStateMatches(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  state: ResumeStateShape,
  input: { agentKind: string; issue: Issue; workspacePath: string; workerHost: string | null },
): boolean {
  if (adapters?.resumeStateMatches) return adapters.resumeStateMatches(state, input);
  return (
    state.agentKind === input.agentKind &&
    state.issueId === input.issue.id &&
    state.issueIdentifier === input.issue.identifier &&
    state.issueState === input.issue.state &&
    state.workspacePath === input.workspacePath &&
    (state.workerHost ?? null) === input.workerHost
  );
}

async function writeResumeState(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  workspacePath: string,
  state: ResumeStateShape,
  workerHost: string | null,
  timeoutMs: number,
): Promise<void> {
  if (adapters?.writeResumeState) {
    return adapters.writeResumeState(workspacePath, state, workerHost, timeoutMs);
  }
  throw new Error("agent_runner_adapter_missing: writeResumeState");
}
