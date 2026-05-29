/**
 * Testing sandbox for Symphony runtime.
 *
 * Provides chaos-monkey tracker clients, configurable fake agent runners,
 * scenario orchestration, and issue factory helpers -- all purely in-memory
 * with no file I/O.
 */

import { parseConfig, normalizeIssue } from "@symphony/cli";
import { SymphonyRuntime } from "@symphony/runtime";
import type {
  Issue,
  IssueStateType,
  Settings,
  WorkflowDefinition,
  RuntimeTrackerClient,
  AgentUpdate,
  UsageTotals,
  RunResult,
} from "@symphony/cli";
import type {
  RuntimeRunner,
  RuntimeSnapshot,
  RuntimeEvent,
  SymphonyRuntimeOptions,
} from "@symphony/runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Promisified setTimeout. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Quickly create an Issue object with sensible defaults. */
export function makeIssue(
  id: string,
  identifier: string,
  overrides: Record<string, unknown> = {},
): Issue {
  return normalizeIssue({
    id,
    identifier,
    title: overrides.title ?? `Issue ${identifier}`,
    state: overrides.state ?? "Todo",
    stateType: overrides.stateType ?? "unstarted",
    labels: overrides.labels ?? [],
    blockers: overrides.blockers ?? [],
    priority: overrides.priority ?? 2,
    description: overrides.description ?? null,
    ...overrides,
  });
}

/** Create a Settings object with sensible testing defaults. */
export function makeSettings(overrides: Record<string, unknown> = {}): Settings {
  return parseConfig(
    {
      tracker: {
        kind: "memory",
        endpoint: "memory://test",
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "Cancelled"],
        dispatch: {
          acceptUnrouted: true,
          onlyRoutes: null,
          routeLabelPrefix: "Symphony:",
        },
      },
      polling: { intervalMs: 100 },
      workspace: { root: "/tmp/sandbox_workspaces" },
      agent: {
        kind: "codex",
        maxConcurrentAgents: 5,
        maxTurns: 10,
        maxRetryBackoffMs: 1000,
        ensembleSize: 1,
      },
      codex: {
        command: "echo codex",
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: null,
        turnTimeoutMs: 60_000,
        readTimeoutMs: 5_000,
        stallTimeoutMs: 30_000,
      },
      claude: {
        command: "echo claude",
        model: "claude-opus-4-6",
        permissionMode: "dontAsk",
        turnTimeoutMs: 60_000,
        stallTimeoutMs: 30_000,
        strictMcpConfig: true,
      },
      ...overrides,
    },
    {},
    { tmpdir: "/tmp", cwd: "/tmp" },
  );
}

/** Create N issues forming a dependency chain where each blocks the next. */
export function makeDependencyChain(count: number): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < count; i++) {
    const id = `chain-${i}`;
    const identifier = `CHAIN-${i}`;
    const blockers =
      i > 0
        ? [{ id: `chain-${i - 1}`, identifier: `CHAIN-${i - 1}`, state: "Todo", stateType: "unstarted" }]
        : [];
    issues.push(
      makeIssue(id, identifier, { blockers }),
    );
  }
  return issues;
}

/** Create N issues with varied priorities (1 = urgent through N = low). */
export function makePrioritySpread(count: number): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < count; i++) {
    issues.push(
      makeIssue(`prio-${i}`, `PRIO-${i}`, { priority: i + 1 }),
    );
  }
  return issues;
}

/** Create many concurrent issues for load testing. */
export function makeHighTraffic(count: number): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < count; i++) {
    issues.push(
      makeIssue(`traffic-${i}`, `TRAFFIC-${i}`, { priority: 2 }),
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// ChaosLinearClient
// ---------------------------------------------------------------------------

/** Configuration for chaos-monkey behavior on the tracker client. */
export interface ChaosConfig {
  /** Probability (0-1) that any fetch call throws an error. Default 0. */
  failureRate?: number;
  /** Additional delay (ms) added to every call. Default 0. */
  latencyMs?: number;
  /** Issue IDs that always fail when fetched. */
  intermittentErrorIds?: Set<string>;
}

/**
 * A tracker client that wraps MemoryTrackerClient with chaos-monkey capabilities:
 * configurable failure rate, latency injection, intermittent errors, and dynamic
 * issue manipulation at runtime.
 */
export class ChaosLinearClient implements RuntimeTrackerClient {
  private issues: Issue[];
  private config: Required<ChaosConfig>;
  private _callCount = 0;

  constructor(
    issues: Issue[] = [],
    chaosConfig: ChaosConfig = {},
  ) {
    this.issues = issues.map(cloneIssue);
    this.config = {
      failureRate: chaosConfig.failureRate ?? 0,
      latencyMs: chaosConfig.latencyMs ?? 0,
      intermittentErrorIds: chaosConfig.intermittentErrorIds ?? new Set(),
    };
  }

  /** Total number of API calls made against this client. */
  get callCount(): number {
    return this._callCount;
  }

  /** Reset the call counter. */
  resetCallCount(): void {
    this._callCount = 0;
  }

  // -- Dynamic manipulation --

  /** Add an issue at runtime. */
  addIssue(issue: Issue): void {
    this.issues.push(cloneIssue(issue));
  }

  /** Remove an issue by ID. Returns true if found and removed. */
  removeIssue(id: string): boolean {
    const before = this.issues.length;
    this.issues = this.issues.filter((i) => i.id !== id);
    return this.issues.length < before;
  }

  /** Update an issue in-place by ID. Merges provided fields. */
  updateIssue(id: string, patch: Partial<Issue>): boolean {
    const issue = this.issues.find((i) => i.id === id);
    if (!issue) return false;
    Object.assign(issue, patch);
    return true;
  }

  /** Change the state of a specific issue (simulating external state transitions). */
  changeIssueState(id: string, state: string, stateType?: IssueStateType): boolean {
    const issue = this.issues.find((i) => i.id === id);
    if (!issue) return false;
    issue.state = state;
    if (stateType !== undefined) {
      issue.stateType = stateType;
    }
    return true;
  }

  /** Replace the full chaos config at runtime. */
  setChaosConfig(config: ChaosConfig): void {
    this.config = {
      failureRate: config.failureRate ?? this.config.failureRate,
      latencyMs: config.latencyMs ?? this.config.latencyMs,
      intermittentErrorIds: config.intermittentErrorIds ?? this.config.intermittentErrorIds,
    };
  }

  /** Get a readonly snapshot of current issues. */
  getIssues(): Issue[] {
    return this.issues.map(cloneIssue);
  }

  // -- RuntimeTrackerClient implementation --

  async fetchCandidateIssues(): Promise<Issue[]> {
    await this.applyChaosMaybeThrow();
    return this.issues.map(cloneIssue);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    await this.applyChaosMaybeThrow();
    const wanted = new Set(ids);
    const results: Issue[] = [];
    for (const issue of this.issues) {
      if (!wanted.has(issue.id)) continue;
      if (this.config.intermittentErrorIds.has(issue.id)) {
        throw new Error(`ChaosLinearClient: intermittent error fetching issue ${issue.id}`);
      }
      results.push(cloneIssue(issue));
    }
    return results;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    await this.applyChaosMaybeThrow();
    const normalizedStates = new Set(states.map((s) => s.trim().toLowerCase()));
    return this.issues
      .filter((i) => normalizedStates.has(i.state.trim().toLowerCase()))
      .map(cloneIssue);
  }

  private async applyChaosMaybeThrow(): Promise<void> {
    this._callCount += 1;
    if (this.config.latencyMs > 0) {
      await sleep(this.config.latencyMs);
    }
    if (this.config.failureRate > 0 && Math.random() < this.config.failureRate) {
      throw new Error(
        `ChaosLinearClient: random failure (rate=${this.config.failureRate})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// FakeAgentRunner
// ---------------------------------------------------------------------------

/** Per-issue behavior configuration for the fake runner. */
export interface FakeRunnerIssueBehavior {
  /** Whether this issue should succeed. Default true. */
  shouldSucceed?: boolean;
  /** Error message when failing. */
  errorMessage?: string;
  /** Number of turns before completion. Default 1. */
  turnCount?: number;
  /** Delay (ms) per turn. Default 0. */
  latencyPerTurnMs?: number;
  /** If true, the runner never resolves (simulates a stall). */
  stall?: boolean;
  /** Simulated token usage reported per turn. */
  usagePerTurn?: Partial<UsageTotals>;
  /** If true, throw mid-turn to simulate a session crash. */
  crashMidTurn?: boolean;
  /** Turn number at which to crash (1-based). Default 1 if crashMidTurn is true. */
  crashAtTurn?: number;
  /** Arbitrary AgentUpdate sequence to emit before completing. */
  customUpdates?: AgentUpdate[];
}

/** Configuration for the FakeAgentRunner factory. */
export interface FakeRunnerConfig {
  /** Default behavior for issues not matched by ID or pattern. */
  defaultBehavior?: FakeRunnerIssueBehavior;
  /** Per-issue overrides keyed by issue ID. */
  byId?: Record<string, FakeRunnerIssueBehavior>;
  /** Pattern-based overrides. First matching pattern wins. */
  byPattern?: Array<{ pattern: RegExp; behavior: FakeRunnerIssueBehavior }>;
}

/**
 * Creates a RuntimeRunner function with configurable behavior per issue.
 * Supports success/failure, turn counts, latency, stalls, usage reporting,
 * session crashes, and arbitrary update sequences.
 */
export function createFakeAgentRunner(config: FakeRunnerConfig = {}): RuntimeRunner {
  const defaultBehavior: Required<FakeRunnerIssueBehavior> = {
    shouldSucceed: true,
    errorMessage: "FakeAgentRunner: simulated failure",
    turnCount: 1,
    latencyPerTurnMs: 0,
    stall: false,
    usagePerTurn: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    crashMidTurn: false,
    crashAtTurn: 1,
    customUpdates: [],
  };

  function resolveBehavior(issue: Issue): Required<FakeRunnerIssueBehavior> {
    // Check by ID first
    if (config.byId && config.byId[issue.id]) {
      return { ...defaultBehavior, ...config.defaultBehavior, ...config.byId[issue.id] };
    }
    // Check patterns
    if (config.byPattern) {
      for (const { pattern, behavior } of config.byPattern) {
        if (pattern.test(issue.id) || pattern.test(issue.identifier)) {
          return { ...defaultBehavior, ...config.defaultBehavior, ...behavior };
        }
      }
    }
    // Use default
    return { ...defaultBehavior, ...config.defaultBehavior };
  }

  const runner: RuntimeRunner = async (input) => {
    const { issue, onUpdate, abortSignal } = input;
    const behavior = resolveBehavior(issue);
    const workspace = `/tmp/sandbox_workspaces/${issue.identifier}`;
    const allUpdates: AgentUpdate[] = [];

    // Emit workspace_prepared
    const workspaceUpdate: AgentUpdate = {
      type: "workspace_prepared",
      workspacePath: workspace,
    };
    onUpdate?.(workspaceUpdate);
    allUpdates.push(workspaceUpdate);

    // Emit session_started
    const sessionUpdate: AgentUpdate = {
      type: "session_started",
      sessionId: `fake-session-${issue.id}`,
    };
    onUpdate?.(sessionUpdate);
    allUpdates.push(sessionUpdate);

    // Stall simulation: never resolve
    if (behavior.stall) {
      return new Promise<RunResult>(() => {
        // Intentionally never resolves
      });
    }

    // Emit custom updates if any
    for (const update of behavior.customUpdates) {
      onUpdate?.(update);
      allUpdates.push(update);
    }

    // Process turns
    let completedTurns = 0;
    for (let turn = 1; turn <= behavior.turnCount; turn++) {
      // Check abort signal
      if (abortSignal?.aborted) {
        throw new Error("FakeAgentRunner: aborted");
      }

      // Simulate latency
      if (behavior.latencyPerTurnMs > 0) {
        await sleep(behavior.latencyPerTurnMs);
      }

      // Crash mid-turn
      if (behavior.crashMidTurn && turn === behavior.crashAtTurn) {
        const crashUpdate: AgentUpdate = {
          type: "turn_failed",
          message: "session crash",
        };
        onUpdate?.(crashUpdate);
        allUpdates.push(crashUpdate);
        throw new Error("FakeAgentRunner: session crashed mid-turn");
      }

      // Emit turn_started
      const turnStarted: AgentUpdate = {
        type: "turn_started",
        message: `turn ${turn}`,
      };
      onUpdate?.(turnStarted);
      allUpdates.push(turnStarted);

      // Emit usage
      if (behavior.usagePerTurn) {
        const usageUpdate: AgentUpdate = {
          type: "usage",
          usage: { ...behavior.usagePerTurn },
        };
        onUpdate?.(usageUpdate);
        allUpdates.push(usageUpdate);
      }

      // Emit turn_completed
      const turnCompleted: AgentUpdate = {
        type: "turn_completed",
        sessionId: `fake-session-${issue.id}`,
        resumeId: `fake-resume-${issue.id}`,
        usage: { ...behavior.usagePerTurn },
      };
      onUpdate?.(turnCompleted);
      allUpdates.push(turnCompleted);

      completedTurns += 1;
    }

    // After all turns, fail or succeed
    if (!behavior.shouldSucceed) {
      throw new Error(behavior.errorMessage);
    }

    const result: RunResult = {
      workspace,
      turnCount: completedTurns,
      updates: allUpdates,
      resumeId: `fake-resume-${issue.id}`,
      agentKind: "codex",
    };

    return result;
  };

  return runner;
}

// ---------------------------------------------------------------------------
// Scenario Runner
// ---------------------------------------------------------------------------

/** Collected events from a sandbox run. */
export interface SandboxResult {
  /** All runtime snapshots captured during the run. */
  snapshots: RuntimeSnapshot[];
  /** All runtime events captured during the run. */
  events: RuntimeEvent[];
  /** Errors thrown during poll ticks. */
  errors: Error[];
  /** Final snapshot after all ticks complete. */
  finalSnapshot: RuntimeSnapshot;
  /** Number of poll ticks executed. */
  ticksExecuted: number;
  /** Total API calls made to the chaos client. */
  clientCallCount: number;
}

/** Configuration for a sandbox scenario. */
export interface SandboxScenario {
  /** Issues to seed the tracker with. */
  issues: Issue[];
  /** Settings overrides (raw config format, passed to parseConfig). */
  settingsOverrides?: Record<string, unknown>;
  /** Chaos configuration for the tracker client. */
  chaosConfig?: ChaosConfig;
  /** Fake runner behavior configuration. */
  runnerConfig?: FakeRunnerConfig;
  /** Number of poll ticks to execute. Default 1. */
  pollTicks?: number;
  /** Delay (ms) between poll ticks. Default 0. */
  tickDelayMs?: number;
  /** If true, wait for all in-flight runs after each tick. Default true. */
  waitForRuns?: boolean;
  /** Optional mutations to apply between ticks. Keyed by tick number (0-based). */
  mutations?: Record<number, (client: ChaosLinearClient) => void>;
}

/**
 * Run a sandbox scenario: sets up the runtime with the chaos client and fake
 * runner, executes poll ticks, collects all events and snapshots, and returns
 * the full history.
 */
export async function runScenario(scenario: SandboxScenario): Promise<SandboxResult> {
  const settings = makeSettings(scenario.settingsOverrides ?? {});
  const client = new ChaosLinearClient(scenario.issues, scenario.chaosConfig);
  const runner = createFakeAgentRunner(scenario.runnerConfig ?? {});

  const workflow: WorkflowDefinition = {
    path: "/tmp/sandbox_workflow.md",
    config: {},
    promptTemplate: "Fix issue {{ issue.identifier }}: {{ issue.title }}",
    settings,
  };

  const snapshots: RuntimeSnapshot[] = [];
  const events: RuntimeEvent[] = [];
  const errors: Error[] = [];

  const runtimeOptions: SymphonyRuntimeOptions = {
    workflow,
    client,
    runner,
    removeIssueWorkspaces: async () => {},
    deleteResumeState: async () => {},
    appendLogEvent: async () => {},
  };

  const runtime = new SymphonyRuntime(runtimeOptions);

  // Subscribe to snapshot changes
  const unsubscribe = runtime.subscribe((snapshot) => {
    snapshots.push(snapshot);
    // Collect new events not yet seen
    for (const event of snapshot.recentEvents) {
      if (!events.some((e) => e.at === event.at && e.type === event.type && e.message === event.message)) {
        events.push(event);
      }
    }
  });

  const ticks = scenario.pollTicks ?? 1;
  const waitForRuns = scenario.waitForRuns ?? true;
  let ticksExecuted = 0;

  try {
    for (let tick = 0; tick < ticks; tick++) {
      // Apply mutations if any for this tick
      const mutationFn = scenario.mutations?.[tick];
      if (mutationFn) {
        mutationFn(client);
      }

      try {
        await runtime.pollOnce({ waitForRuns });
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }

      ticksExecuted += 1;

      if (scenario.tickDelayMs && scenario.tickDelayMs > 0 && tick < ticks - 1) {
        await sleep(scenario.tickDelayMs);
      }
    }
  } finally {
    runtime.stop();
    unsubscribe();
  }

  const finalSnapshot = runtime.snapshot();

  return {
    snapshots,
    events,
    errors,
    finalSnapshot,
    ticksExecuted,
    clientCallCount: client.callCount,
  };
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blockers: issue.blockers.map((b) => ({ ...b })),
  };
}
