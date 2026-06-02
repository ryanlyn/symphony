import type {
  TraceTextMessage,
  TraceToolCall,
  TraceToolResult,
  TraceToolCallUpdate,
  TraceNotificationMessage,
} from "@symphony/domain";

export function isTraceTextMessage(msg: unknown): msg is TraceTextMessage {
  return (
    typeof msg === "object" && msg !== null && typeof (msg as TraceTextMessage).text === "string"
  );
}

export function isTraceToolCall(msg: unknown): msg is TraceToolCall {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as TraceToolCall;
  return typeof m.toolCallId === "string" && typeof m.toolName === "string";
}

export function isTraceToolResult(msg: unknown): msg is TraceToolResult {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as TraceToolResult;
  return typeof m.toolCallId === "string" && typeof m.isError === "boolean";
}

export function isTraceToolCallUpdate(msg: unknown): msg is TraceToolCallUpdate {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as TraceToolCallUpdate;
  return typeof m.toolCallId === "string";
}

export function isTraceNotification(msg: unknown): msg is TraceNotificationMessage {
  if (typeof msg !== "object" || msg === null) return false;
  return typeof (msg as TraceNotificationMessage).method === "string";
}
