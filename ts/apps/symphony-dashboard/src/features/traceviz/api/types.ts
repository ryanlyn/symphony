export type {
  DisplayEvent,
  ThoughtDisplayEvent as ThoughtEvent,
  MessageDisplayEvent as MessageEvent,
  ToolCallDisplayEvent as ToolCallEvent,
  TurnCompletedDisplayEvent as TurnCompletedEvent,
  TurnFailedDisplayEvent as TurnFailedEvent,
  NotificationDisplayEvent as NotificationEvent,
  UnknownDisplayEvent as UnknownEvent,
} from "@symphony/traceviz-server";

export type { TicketInfo, TraceStats as Stats } from "@symphony/traceviz-server";

/** Mirrors IssueRecord from @symphony/server — kept local to avoid a Node.js dependency in the browser bundle. */
export interface IssueRecord {
  issueId: string;
  issueIdentifier: string;
  title: string | null;
  url: string | null;
  updatedAt: number;
}
