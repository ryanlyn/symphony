import type { SessionUpdate as ProtocolSessionUpdate } from "./spec/session.js";

export type AgentKind = string;
export type AgentExecutorKind = "appserver" | "acp";

export interface IssueRef {
  id?: string | undefined;
  identifier?: string | undefined;
  state?: string | undefined;
  stateType?: string | null | undefined;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null | undefined;
  state: string;
  stateType?: string | null | undefined;
  branchName?: string | null | undefined;
  url?: string | null | undefined;
  priority?: number | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  labels: string[];
  blockers: IssueRef[];
  assigneeId?: string | null | undefined;
  assignedToWorker?: boolean | null | undefined;
  raw?: unknown | undefined;
}

export interface DispatchSettings {
  acceptUnrouted: boolean;
  onlyRoutes: string[] | null;
  routeLabelPrefix: string;
}

export interface TrackerSettings {
  kind?: "linear" | "memory" | undefined;
  endpoint: string;
  apiKey?: string | undefined;
  projectSlug?: string | undefined;
  assignee?: string | undefined;
  activeStates: string[];
  terminalStates: string[];
  dispatch: DispatchSettings;
}

export interface WorkerSettings {
  sshHosts: string[];
  sshTimeoutMs: number;
  maxConcurrentAgentsPerHost?: number | undefined;
}

export interface AgentSettings {
  kind: AgentKind;
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  ensembleSize: number;
}

export interface AppServerAgentConfig extends CodexSettings {
  executor: "appserver";
}

export interface AcpAgentConfig {
  executor: "acp";
  bridgeCommand: string;
  bridgeArgs: string[];
  model?: string | undefined;
  permissionMode?: string | undefined;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  strictMcpConfig?: boolean | undefined;
}

export type AgentConfig = AppServerAgentConfig | AcpAgentConfig;

export interface CodexSettings {
  command: string;
  approvalPolicy: string | Record<string, unknown>;
  threadSandbox: string;
  turnSandboxPolicy: Record<string, unknown> | null;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface ClaudeSettings {
  command: string;
  model: string;
  permissionMode: string;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  strictMcpConfig: boolean;
}

export interface ObservabilitySettings {
  dashboardEnabled: boolean;
  refreshMs: number;
  renderIntervalMs: number;
}

export interface ServerSettings {
  host: string;
  port?: number | undefined;
}

export interface LoggingSettings {
  logFile: string;
}

export interface HooksSettings {
  afterCreate?: string | null | undefined;
  beforeRun?: string | null | undefined;
  afterRun?: string | null | undefined;
  beforeRemove?: string | null | undefined;
  timeoutMs: number;
}

export interface WorkspaceSettings {
  root: string;
  rootExpression?: string | undefined;
}

export interface Settings {
  tracker: TrackerSettings;
  polling: { intervalMs: number };
  workspace: WorkspaceSettings;
  worker: WorkerSettings;
  hooks: HooksSettings;
  agent: AgentSettings;
  agents: Record<string, AgentConfig>;
  codex: CodexSettings;
  claude: ClaudeSettings;
  observability: ObservabilitySettings;
  server: ServerSettings;
  logging: LoggingSettings;
  statusOverrides: Map<string, PartialRuntimeSettings>;
}

export interface PartialRuntimeSettings {
  agent?: Partial<AgentSettings> | undefined;
  codex?: Partial<CodexSettings> | undefined;
  claude?: Partial<ClaudeSettings> | undefined;
}

export interface WorkflowDefinition {
  path: string;
  config: Record<string, unknown>;
  promptTemplate: string;
  settings: Settings;
}

export interface RuntimeTrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
  fetchIssuesByStates?(states: string[]): Promise<Issue[]>;
}

export interface EnsembleContext {
  enabled: boolean;
  slot_index: number;
  size: number;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAt: Date;
  error?: string | undefined;
  slotIndex?: number | undefined;
  workerHost?: string | null | undefined;
  workspacePath?: string | null | undefined;
}

export type DispatchBlockReason =
  | "global_concurrency_cap"
  | "local_concurrency_cap"
  | "worker_host_capacity";

export interface DispatchBlockEntry {
  issueId: string;
  identifier: string;
  state: string;
  reason: DispatchBlockReason;
  workerHost?: string | null | undefined;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export interface RunningEntry {
  issue: Issue;
  identifier: string;
  slotIndex: number;
  ensembleSize: number;
  agentKind: AgentKind;
  workerHost?: string | null | undefined;
  workspacePath?: string | null | undefined;
  sessionId?: string | null | undefined;
  resumeId?: string | null | undefined;
  executorPid?: string | null | undefined;
  turnCount: number;
  startedAt: Date;
  lastAgentEvent?: string | null | undefined;
  lastAgentMessage?: unknown | undefined;
  lastAgentTimestamp?: Date | null | undefined;
  usageTotals: UsageTotals;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  retryAttempt: number | null;
}

export interface AgentUpdate {
  type: string;
  sessionUpdate?: ProtocolSessionUpdate | undefined;
  workspacePath?: string | null | undefined;
  sessionId?: string | null | undefined;
  resumeId?: string | null | undefined;
  executorPid?: string | null | undefined;
  message?: unknown | undefined;
  usage?: Partial<UsageTotals> | undefined;
  rateLimits?: unknown | undefined;
  timestamp?: Date | undefined;
}

export interface AgentSession {
  agentKind: AgentKind;
  sessionId?: string | null | undefined;
  resumeId?: string | null | undefined;
  executorPid?: string | null | undefined;
  stop(): Promise<void>;
}

export interface AgentExecutor {
  kind: AgentKind;
  startSession(input: {
    workspace: string;
    workerHost?: string | null | undefined;
    issue?: Issue;
    settings: Settings;
    resumeId?: string | null;
    onUpdate?: (update: AgentUpdate) => void;
  }): Promise<AgentSession>;
  runTurn(session: AgentSession, prompt: string, issue?: Issue): Promise<AgentUpdate[]>;
}
