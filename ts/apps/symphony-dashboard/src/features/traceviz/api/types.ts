/**
 * Re-export display event types from @symphony/traceviz-server to avoid duplication.
 * Only the WsMessage type remains local (it is a client-only concern).
 */
export type {
  DisplayEvent,
  ThoughtDisplayEvent as ThoughtEvent,
  MessageDisplayEvent as MessageEvent,
  ToolCallDisplayEvent as ToolCallEvent,
  TurnCompletedDisplayEvent as TurnCompletedEvent,
  TurnStartedDisplayEvent as TurnStartedEvent,
  TurnFailedDisplayEvent as TurnFailedEvent,
  NotificationDisplayEvent as NotificationEvent,
  UnknownDisplayEvent as UnknownEvent,
  ToolCategory,
  TokenUsage,
} from "@symphony/traceviz-server";

export type {
  TicketInfo,
  ToolBreakdownEntry,
  TraceStats as Stats,
} from "@symphony/traceviz-server";

export type WsMessage =
  | { type: "init"; tickets: TicketInfo[] }
  | { type: "update"; issueId: string; events: DisplayEvent[]; tickets: TicketInfo[] }
  | { type: "events"; issueId: string; events: DisplayEvent[] }
  | { type: "ping" };

// Re-import for use in the WsMessage type above
import type { TicketInfo, DisplayEvent } from "@symphony/traceviz-server";
