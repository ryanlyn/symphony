import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";
import type { TraceEvent } from "@symphony/domain";
import { z } from "zod";

import type {
  DisplayEvent,
  ToolCallDisplayEvent,
  ToolCategory,
  TokenUsage,
} from "./models/display-events.js";

/** Tool name -> category mapping for common Claude tools. */
const TOOL_NAME_CATEGORIES: Record<string, ToolCategory> = {
  // plan_mode
  Task: "plan_mode",
  TaskOutput: "plan_mode",
  TaskStop: "plan_mode",
  TaskCreate: "plan_mode",
  TaskUpdate: "plan_mode",
  TaskGet: "plan_mode",
  TaskList: "plan_mode",
  EnterPlanMode: "plan_mode",
  ExitPlanMode: "plan_mode",
  AskUserQuestion: "plan_mode",
  EnterWorktree: "plan_mode",
  ExitWorktree: "plan_mode",
  // skill
  Skill: "skill",
  // search
  ToolSearch: "search",
  Glob: "search",
  Grep: "search",
  // bash_command
  Bash: "bash_command",
  // file_operation
  Read: "file_operation",
  Write: "file_operation",
  Edit: "file_operation",
  NotebookEdit: "file_operation",
  // web
  WebFetch: "web",
  // agent
  Agent: "agent",
  // todo
  TodoWrite: "todo",
  TodoRead: "todo",
};

export function detectToolCategory(toolName: string): ToolCategory {
  return TOOL_NAME_CATEGORIES[toolName] ?? "unknown";
}

// --- Zod envelope schema (validates structure at parse boundary) ---

const TraceLineSchema = z
  .object({
    type: z.string(),
    issueId: z.string().optional(),
    issueIdentifier: z.string().optional(),
    timestamp: z.string().nullable().optional(),
    message: z.unknown().optional(),
    usage: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        totalTokens: z.number().optional(),
      })
      .nullable()
      .optional(),
    workspacePath: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    executorPid: z.string().nullable().optional(),
  })
  .refine((d) => d.issueId || d.issueIdentifier);

interface PendingToolCall {
  event: ToolCallDisplayEvent;
  toolUseId: string;
  startTs: string;
}

interface TurnStartedRecord {
  timestamp: string;
  consumed: boolean;
}

type ParsedLine =
  | TraceEvent
  | {
      type: string;
      issueId?: string;
      issueIdentifier?: string;
      timestamp?: string | null;
      message?: unknown;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
      workspacePath?: string | null;
      sessionId?: string | null;
    };

/**
 * Parse a single JSONL line. Known types narrow to TraceEvent;
 * unknown types still pass through for the `default` branch.
 */
function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const result = TraceLineSchema.safeParse(JSON.parse(trimmed));
    return result.success ? (result.data as unknown as ParsedLine) : null;
  } catch {
    return null;
  }
}

function extractTextFromNotification(msg: SessionNotification): string {
  const update = msg.update;
  if (
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "user_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk"
  ) {
    const block = update.content;
    if (block.type === "text") return block.text;
  }
  return "";
}

/**
 * Parse an `item/completed` notification params into a DisplayEvent.
 */
function parseItemCompleted(params: Record<string, unknown>, ts: string): DisplayEvent | null {
  const item = params.item as Record<string, unknown> | undefined;
  if (!item) return null;
  const itemType = item.type as string | undefined;

  switch (itemType) {
    case "reasoning": {
      let text = typeof item.text === "string" ? item.text : "";
      if (!text) {
        const summary = item.summary as Array<Record<string, unknown>> | undefined;
        if (summary && summary.length > 0) {
          text = summary
            .map((s) => (s.text as string) ?? "")
            .filter(Boolean)
            .join("\n");
        }
      }
      if (!text) {
        const content = item.content as Array<Record<string, unknown>> | undefined;
        if (content && content.length > 0) {
          text = content
            .map((c) => (c.text as string) ?? "")
            .filter(Boolean)
            .join("\n");
        }
      }
      if (!text) return null;
      return { kind: "thought", text, timestamp: ts };
    }

    case "agentMessage":
      return {
        kind: "message",
        text: typeof item.text === "string" ? item.text : "",
        timestamp: ts,
      };

    case "userMessage": {
      const content = item.content as Array<Record<string, unknown>> | undefined;
      const text = content?.[0]?.text as string | undefined;
      return { kind: "message", text: text ?? "", timestamp: ts };
    }

    case "commandExecution":
      return {
        kind: "tool_call",
        category: "bash_command",
        toolName: "command_execution",
        input: { command: item.command },
        output: (item.aggregatedOutput as string) ?? null,
        isError: (item.exitCode as number) !== 0,
        durationMs: (item.durationMs as number) ?? null,
        nestedEvents: [],
        timestamp: ts,
      };

    case "dynamicToolCall": {
      const toolName = (item.tool as string) ?? "unknown";
      const args = (item.arguments as Record<string, unknown>) ?? {};
      const contentItems = item.contentItems as Array<Record<string, unknown>> | undefined;
      const output = (contentItems?.[0]?.text as string | null) ?? null;
      return {
        kind: "tool_call",
        category: detectToolCategory(toolName),
        toolName,
        input: args,
        output,
        isError: (item.success as boolean) === false,
        durationMs: (item.durationMs as number) ?? null,
        nestedEvents: [],
        timestamp: ts,
      };
    }

    default:
      return null;
  }
}

/**
 * Parse all lines from a JSONL trace file content into DisplayEvents.
 */
export function parseTraceLines(lines: string[]): DisplayEvent[] {
  const events: DisplayEvent[] = [];
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const turnStartedRecords: TurnStartedRecord[] = [];
  let turnIndex = 0;

  for (const line of lines) {
    const raw = parseLine(line);
    if (!raw) continue;

    const ts = raw.timestamp ?? new Date().toISOString();

    switch (raw.type) {
      case "agent_thought": {
        const msg = raw.message as SessionNotification | null;
        if (!msg || !("update" in msg)) break;
        const text = extractTextFromNotification(msg);
        if (text) events.push({ kind: "thought", text, timestamp: ts });
        break;
      }

      case "assistant_message":
      case "user_message": {
        const msg = raw.message as SessionNotification | null;
        if (!msg || !("update" in msg)) break;
        const text = extractTextFromNotification(msg);
        if (text) events.push({ kind: "message", text, timestamp: ts });
        break;
      }

      case "tool_use_requested": {
        const msg = raw.message as SessionNotification | null;
        if (!msg || !("update" in msg)) break;
        const update = msg.update;
        if (update.sessionUpdate !== "tool_call") break;
        const name = update.title ?? (update.kind as string) ?? "unknown";
        const id = update.toolCallId ?? "";
        const input = (update.rawInput as Record<string, unknown>) ?? {};

        const toolCall: ToolCallDisplayEvent = {
          kind: "tool_call",
          category: detectToolCategory(name),
          toolName: name,
          input,
          output: null,
          isError: false,
          durationMs: null,
          nestedEvents: [],
          timestamp: ts,
        };
        pendingToolCalls.set(id, { event: toolCall, toolUseId: id, startTs: ts });
        break;
      }

      case "tool_call_update": {
        const msg = raw.message as SessionNotification | null;
        if (!msg || !("update" in msg)) break;
        const update = msg.update;
        if (update.sessionUpdate !== "tool_call_update") break;
        const toolUseId = update.toolCallId ?? "";
        const pending = pendingToolCalls.get(toolUseId);
        if (pending) {
          const partialOutput = typeof update.rawOutput === "string" ? update.rawOutput : null;
          if (partialOutput !== null && typeof pending.event.output === "string") {
            pending.event.output = pending.event.output + partialOutput;
          } else if (partialOutput !== null) {
            pending.event.output = partialOutput;
          }
        }
        break;
      }

      case "tool_result":
      case "tool_call_completed":
      case "tool_call_failed": {
        const msg = raw.message as SessionNotification | null;
        if (!msg || !("update" in msg)) break;
        const update = msg.update;
        if (update.sessionUpdate !== "tool_call_update") break;
        const id = update.toolCallId ?? "";

        let output: string | unknown[] | null = null;
        if (typeof update.rawOutput === "string") {
          output = update.rawOutput;
        } else if (update.rawOutput != null) {
          output = JSON.stringify(update.rawOutput);
        } else {
          const content = update.content as Array<ToolCallContent> | undefined;
          if (content && content.length > 0) {
            const texts = content
              .map((c) => {
                if (c.type === "content") {
                  const block = c.content;
                  return block.type === "text" ? block.text : "";
                }
                if (c.type === "terminal") {
                  return ((c as Record<string, unknown>).output as string) ?? "";
                }
                return "";
              })
              .filter(Boolean);
            output = texts.join("\n") || null;
          }
        }
        const isError = update.status === "failed";

        const pending = id ? pendingToolCalls.get(id) : undefined;
        if (pending) {
          pendingToolCalls.delete(id);
          const toolCall = pending.event;
          if (output !== null) {
            toolCall.output = output;
          }
          toolCall.isError = isError || raw.type === "tool_call_failed";
          const startMs = new Date(pending.startTs).getTime();
          const endMs = new Date(ts).getTime();
          toolCall.durationMs =
            Number.isNaN(startMs) || Number.isNaN(endMs) ? null : endMs - startMs;
          events.push(toolCall);
        } else {
          events.push({
            kind: "tool_call",
            category: "unknown",
            toolName: "unknown",
            input: {},
            output,
            isError: isError || raw.type === "tool_call_failed",
            durationMs: null,
            nestedEvents: [],
            timestamp: ts,
          });
        }
        break;
      }

      case "turn_started": {
        turnIndex++;
        turnStartedRecords.push({ timestamp: ts, consumed: false });
        events.push({ kind: "turn_started", turnIndex, timestamp: ts });
        break;
      }

      case "turn_completed": {
        let usage: TokenUsage | null = null;
        if (raw.usage) {
          usage = {
            inputTokens: raw.usage.inputTokens ?? 0,
            outputTokens: raw.usage.outputTokens ?? 0,
            totalTokens:
              raw.usage.totalTokens ?? (raw.usage.inputTokens ?? 0) + (raw.usage.outputTokens ?? 0),
          };
        }
        let durationMs: number | null = null;
        for (let i = turnStartedRecords.length - 1; i >= 0; i--) {
          const record = turnStartedRecords[i];
          if (record !== undefined && !record.consumed) {
            record.consumed = true;
            const startMs = new Date(record.timestamp).getTime();
            const endMs = new Date(ts).getTime();
            if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
              durationMs = endMs - startMs;
            }
            break;
          }
        }
        events.push({ kind: "turn_completed", usage, durationMs, timestamp: ts });
        break;
      }

      case "turn_failed":
      case "turn_cancelled": {
        for (let i = turnStartedRecords.length - 1; i >= 0; i--) {
          const record = turnStartedRecords[i];
          if (record !== undefined && !record.consumed) {
            record.consumed = true;
            break;
          }
        }
        const msg = raw.message;
        events.push({
          kind: "turn_failed",
          text: `Turn ${raw.type}: ${typeof msg === "string" ? msg : JSON.stringify(msg ?? "")}`,
          timestamp: ts,
        });
        break;
      }

      case "notification": {
        const msg = raw.message;
        if (!msg || typeof msg !== "object") break;
        const method = (msg as Record<string, unknown>).method as string | undefined;
        const params = (msg as Record<string, unknown>).params as
          | Record<string, unknown>
          | undefined;
        if (!method || !params) break;

        if (method === "item/completed") {
          const displayEvent = parseItemCompleted(params, ts);
          if (displayEvent) events.push(displayEvent);
        } else if (method === "turn/started") {
          const lastEvent = events[events.length - 1];
          if (lastEvent && lastEvent.kind === "turn_started") {
            if (ts && new Date(ts).getTime() > 0) {
              lastEvent.timestamp = ts;
              const lastRecord = turnStartedRecords[turnStartedRecords.length - 1];
              if (lastRecord) {
                lastRecord.timestamp = ts;
              }
            }
          } else {
            turnIndex++;
            turnStartedRecords.push({ timestamp: ts, consumed: false });
            events.push({ kind: "turn_started", turnIndex, timestamp: ts });
          }
        } else if (method === "turn/completed") {
          let durationMs: number | null = null;
          for (let i = turnStartedRecords.length - 1; i >= 0; i--) {
            const record = turnStartedRecords[i];
            if (record !== undefined && !record.consumed) {
              record.consumed = true;
              const startMs = new Date(record.timestamp).getTime();
              const endMs = new Date(ts).getTime();
              if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
                durationMs = endMs - startMs;
              }
              break;
            }
          }
          events.push({ kind: "turn_completed", usage: null, durationMs, timestamp: ts });
        }
        break;
      }

      case "usage":
      case "rate_limit":
      case "workspace_prepared":
      case "session_started":
      case "session_replay_suppressed":
      case "process_exit":
      case "stderr":
      case "fs_write":
      case "plan":
      case "approval_auto_approved":
      case "approval_required":
      case "resume_state_warning": {
        break;
      }

      default: {
        events.push({
          kind: "unknown",
          raw: raw as unknown as Record<string, unknown>,
          timestamp: ts,
        });
        break;
      }
    }
  }

  // Flush any remaining pending tool calls that never got a result
  for (const [, pending] of pendingToolCalls) {
    events.push(pending.event);
  }

  return events;
}

/**
 * Extract the issueId and issueIdentifier from the first valid line of a trace file.
 */
export function extractTicketMetadata(
  lines: string[],
): { issueId: string; issueIdentifier: string } | null {
  for (const line of lines) {
    const raw = parseLine(line);
    if (raw && raw.issueId && raw.issueIdentifier) {
      return { issueId: raw.issueId, issueIdentifier: raw.issueIdentifier };
    }
  }
  return null;
}
