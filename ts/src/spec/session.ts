import type { AgentKind, UsageTotals } from "../types.js";

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface SymphonyMeta {
  executorPid?: string | null | undefined;
  rateLimits?: unknown | undefined;
  usage?: Partial<UsageTotals> | undefined;
}

export interface SessionUpdateBase {
  kind: string;
  sessionId?: string | null | undefined;
  agentKind?: AgentKind | string | undefined;
  message?: unknown | undefined;
  at?: Date | undefined;
  _meta?: SymphonyMeta | undefined;
}

export interface UsageUpdate extends SessionUpdateBase {
  kind: "usage_update";
  usage: Partial<UsageTotals>;
}

export interface TurnUpdate extends SessionUpdateBase {
  kind:
    | "session_started"
    | "turn_started"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "tool_call"
    | "tool_result"
    | "notification";
  message?: unknown | undefined;
}

export type SessionUpdate = UsageUpdate | TurnUpdate | SessionUpdateBase;

export interface TurnResult {
  stopReason: StopReason;
  sessionId: string;
  _meta?: SymphonyMeta | undefined;
}
