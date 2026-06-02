// --------------------------------------------------------------------------
// @symphony/agent-events - Canonical provider-agnostic agent event types
// --------------------------------------------------------------------------

// --- Source provenance ---

export const AGENT_EVENT_SOURCES = ["codex", "claude", "unknown"] as const;

export type AgentEventSource = (typeof AGENT_EVENT_SOURCES)[number];

// --- Tool categories ---

export const TOOL_CATEGORIES = [
  "plan_mode",
  "agent",
  "bash_command",
  "search",
  "file_operation",
  "web",
  "todo",
  "skill",
  "unknown",
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

// --- Tool call status ---

export const TOOL_CALL_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;

export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

// --- Token usage ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

// --- Plan entry ---

export const PLAN_ENTRY_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
] as const;

export type PlanEntryStatus = (typeof PLAN_ENTRY_STATUSES)[number];

export interface PlanEntry {
  id?: string | undefined;
  title: string;
  status: PlanEntryStatus;
  priority?: "high" | "medium" | "low" | undefined;
}

// --- Event metadata (shared by all events) ---

export interface AgentEventMeta {
  /** Provider source that produced this event. */
  source: AgentEventSource;
  /** ISO-8601 timestamp when this event was observed. */
  timestamp: string;
  /** Session identifier from the agent backend. */
  sessionId?: string | null | undefined;
  /** Unique event id for deduplication/ordering (optional). */
  eventId?: string | undefined;
  /** Original raw payload preserved for debugging. */
  raw?: unknown;
}

// --- Event kind discriminator ---

export const AGENT_EVENT_KINDS = [
  // Lifecycle events
  "session_started",
  "session_ended",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_input_required",
  // Content events
  "assistant_message",
  "assistant_message_chunk",
  "user_message",
  "user_message_chunk",
  "thought",
  "thought_chunk",
  // Tool events
  "tool_use_requested",
  "tool_call_update",
  "tool_result",
  "tool_call_failed",
  // Plan events
  "plan",
  // Usage and rate limit events
  "usage",
  "rate_limit",
  // Approval/interaction events
  "approval_required",
  "approval_auto_approved",
  "tool_input_auto_answered",
  // Workspace/process events
  "workspace_prepared",
  "fs_write",
  "process_exit",
  // Informational events
  "notification",
  "mode_update",
  "config_update",
  "session_info_update",
  "stderr",
  "malformed",
  "unknown",
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

// --- Individual event interfaces ---

// -- Lifecycle events --

export interface SessionStartedEvent extends AgentEventMeta {
  kind: "session_started";
  resumeId?: string | null | undefined;
  executorPid?: string | null | undefined;
}

export interface SessionEndedEvent extends AgentEventMeta {
  kind: "session_ended";
  reason?: string | undefined;
}

export interface TurnStartedEvent extends AgentEventMeta {
  kind: "turn_started";
  turnIndex?: number | undefined;
}

export interface TurnCompletedEvent extends AgentEventMeta {
  kind: "turn_completed";
  usage?: TokenUsage | null | undefined;
  durationMs?: number | null | undefined;
  stopReason?: string | undefined;
}

export interface TurnFailedEvent extends AgentEventMeta {
  kind: "turn_failed";
  error: string;
  durationMs?: number | null | undefined;
}

export interface TurnCancelledEvent extends AgentEventMeta {
  kind: "turn_cancelled";
  reason?: string | undefined;
}

export interface TurnInputRequiredEvent extends AgentEventMeta {
  kind: "turn_input_required";
  prompt?: string | undefined;
}

// -- Content events --

export interface AssistantMessageEvent extends AgentEventMeta {
  kind: "assistant_message";
  text: string;
}

export interface AssistantMessageChunkEvent extends AgentEventMeta {
  kind: "assistant_message_chunk";
  text: string;
}

export interface UserMessageEvent extends AgentEventMeta {
  kind: "user_message";
  text: string;
}

export interface UserMessageChunkEvent extends AgentEventMeta {
  kind: "user_message_chunk";
  text: string;
}

export interface ThoughtEvent extends AgentEventMeta {
  kind: "thought";
  text: string;
  durationMs?: number | undefined;
}

export interface ThoughtChunkEvent extends AgentEventMeta {
  kind: "thought_chunk";
  text: string;
}

// -- Tool events --

export interface ToolUseRequestedEvent extends AgentEventMeta {
  kind: "tool_use_requested";
  toolCallId: string;
  toolName: string;
  category: ToolCategory;
  input: Record<string, unknown>;
  /** ACP tool kind (read, edit, execute, etc.) when available. */
  toolKind?: string | undefined;
}

export interface ToolCallUpdateEvent extends AgentEventMeta {
  kind: "tool_call_update";
  toolCallId: string;
  toolName?: string | undefined;
  category?: ToolCategory | undefined;
  status?: ToolCallStatus | undefined;
  /** Partial or streaming output accumulated so far. */
  partialOutput?: string | null | undefined;
  /** ACP tool kind when available. */
  toolKind?: string | undefined;
}

export interface ToolResultEvent extends AgentEventMeta {
  kind: "tool_result";
  toolCallId: string;
  toolName: string;
  category: ToolCategory;
  input: Record<string, unknown>;
  output: string | unknown[] | null;
  isError: boolean;
  durationMs: number | null;
  /** ACP tool kind when available. */
  toolKind?: string | undefined;
}

export interface ToolCallFailedEvent extends AgentEventMeta {
  kind: "tool_call_failed";
  toolCallId: string;
  toolName: string;
  category: ToolCategory;
  input: Record<string, unknown>;
  error: string;
  durationMs: number | null;
}

// -- Plan events --

export interface PlanEvent extends AgentEventMeta {
  kind: "plan";
  entries: PlanEntry[];
}

// -- Usage and rate limit events --

export interface UsageEvent extends AgentEventMeta {
  kind: "usage";
  usage: Partial<TokenUsage>;
  /** Cumulative total tokens consumed (from ACP usage_update). */
  totalUsed?: number | undefined;
}

export interface RateLimitEvent extends AgentEventMeta {
  kind: "rate_limit";
  /** Provider-specific rate limit details. */
  limits: unknown;
}

// -- Approval/interaction events --

export interface ApprovalRequiredEvent extends AgentEventMeta {
  kind: "approval_required";
  toolCallId?: string | undefined;
  toolName?: string | undefined;
  description?: string | undefined;
  options?: unknown[] | undefined;
}

export interface ApprovalAutoApprovedEvent extends AgentEventMeta {
  kind: "approval_auto_approved";
  toolCallId?: string | undefined;
  toolName?: string | undefined;
  selectedOption?: string | undefined;
}

export interface ToolInputAutoAnsweredEvent extends AgentEventMeta {
  kind: "tool_input_auto_answered";
  toolCallId?: string | undefined;
  answer?: string | undefined;
}

// -- Workspace/process events --

export interface WorkspacePreparedEvent extends AgentEventMeta {
  kind: "workspace_prepared";
  workspacePath: string;
}

export interface FsWriteEvent extends AgentEventMeta {
  kind: "fs_write";
  path: string;
  content?: string | undefined;
}

export interface ProcessExitEvent extends AgentEventMeta {
  kind: "process_exit";
  exitCode?: number | null | undefined;
  signal?: string | null | undefined;
}

// -- Informational events --

export interface NotificationEvent extends AgentEventMeta {
  kind: "notification";
  text: string;
  /** Original notification method (e.g. "item/completed", "thread/compacted"). */
  method?: string | undefined;
}

export interface ModeUpdateEvent extends AgentEventMeta {
  kind: "mode_update";
  mode: string;
}

export interface ConfigUpdateEvent extends AgentEventMeta {
  kind: "config_update";
  configId: string;
  value: unknown;
}

export interface SessionInfoUpdateEvent extends AgentEventMeta {
  kind: "session_info_update";
  title?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface StderrEvent extends AgentEventMeta {
  kind: "stderr";
  text: string;
}

export interface MalformedEvent extends AgentEventMeta {
  kind: "malformed";
  error: string;
  rawData?: unknown;
}

export interface UnknownEvent extends AgentEventMeta {
  kind: "unknown";
  data?: unknown;
}

// --- Discriminated union ---

export type AgentEvent =
  // Lifecycle
  | SessionStartedEvent
  | SessionEndedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent
  | TurnInputRequiredEvent
  // Content
  | AssistantMessageEvent
  | AssistantMessageChunkEvent
  | UserMessageEvent
  | UserMessageChunkEvent
  | ThoughtEvent
  | ThoughtChunkEvent
  // Tool
  | ToolUseRequestedEvent
  | ToolCallUpdateEvent
  | ToolResultEvent
  | ToolCallFailedEvent
  // Plan
  | PlanEvent
  // Usage
  | UsageEvent
  | RateLimitEvent
  // Approval
  | ApprovalRequiredEvent
  | ApprovalAutoApprovedEvent
  | ToolInputAutoAnsweredEvent
  // Workspace/process
  | WorkspacePreparedEvent
  | FsWriteEvent
  | ProcessExitEvent
  // Informational
  | NotificationEvent
  | ModeUpdateEvent
  | ConfigUpdateEvent
  | SessionInfoUpdateEvent
  | StderrEvent
  | MalformedEvent
  | UnknownEvent;

// --- Utility types ---

/** Extract event type by kind. */
export type AgentEventOfKind<K extends AgentEventKind> = Extract<AgentEvent, { kind: K }>;

/** Events that represent lifecycle boundaries (session/turn start/end). */
export type LifecycleEvent = Extract<
  AgentEvent,
  {
    kind:
      | "session_started"
      | "session_ended"
      | "turn_started"
      | "turn_completed"
      | "turn_failed"
      | "turn_cancelled"
      | "turn_input_required";
  }
>;

/** Events that carry content (messages, thoughts). */
export type ContentEvent = Extract<
  AgentEvent,
  {
    kind:
      | "assistant_message"
      | "assistant_message_chunk"
      | "user_message"
      | "user_message_chunk"
      | "thought"
      | "thought_chunk";
  }
>;

/** Events related to tool execution. */
export type ToolEvent = Extract<
  AgentEvent,
  { kind: "tool_use_requested" | "tool_call_update" | "tool_result" | "tool_call_failed" }
>;

/** Streaming chunk events suitable for real-time rendering. */
export type StreamingEvent = Extract<
  AgentEvent,
  { kind: "assistant_message_chunk" | "user_message_chunk" | "thought_chunk" | "tool_call_update" }
>;
