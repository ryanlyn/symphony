/**
 * ACP (Agent Client Protocol) SessionNotification parser.
 *
 * Converts raw ACP SessionNotification updates into canonical AgentEvent types.
 *
 * ACP SessionUpdate kinds:
 *   - agent_message_chunk
 *   - user_message_chunk
 *   - agent_thought_chunk
 *   - tool_call
 *   - tool_call_update
 *   - usage_update
 *   - plan
 *   - available_commands_update
 *   - current_mode_update
 *   - config_option_update
 *   - session_info_update
 */

import type {
  AgentEvent,
  AgentEventSource,
  PlanEntry,
  PlanEntryStatus,
  ToolCallStatus,
} from "./types.js";
import { detectToolCategory } from "./tool-categories.js";

// ---------------------------------------------------------------------------
// Source constant
// ---------------------------------------------------------------------------

const SOURCE: AgentEventSource = "claude";

// ---------------------------------------------------------------------------
// Internal helpers to safely access nested properties
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === "string" ? val : undefined;
}

function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const val = obj[key];
  return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

// ---------------------------------------------------------------------------
// Extract tool name from ACP tool_call update
// Priority: _meta.claudeCode.toolName > title > kind
// ---------------------------------------------------------------------------

function extractToolName(update: Record<string, unknown>): string {
  const meta = asRecord(update._meta);
  if (meta) {
    const claudeCode = asRecord(meta.claudeCode);
    if (claudeCode) {
      const toolName = getString(claudeCode, "toolName");
      if (toolName) return toolName;
    }
  }
  const title = getString(update, "title");
  if (title) return title;
  const kind = getString(update, "kind");
  if (kind) return kind;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Extract text content from a ContentChunk
// ACP format: { content: { type: "text", text: "..." } }
// ---------------------------------------------------------------------------

function extractChunkText(update: Record<string, unknown>): string {
  const content = asRecord(update.content);
  if (!content) return "";
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  // Fallback: try to get text directly
  if (typeof content.text === "string") return content.text;
  return "";
}

// ---------------------------------------------------------------------------
// Extract output from tool_call_update content array
// Content blocks: {type: "content", content: {text: "..."}} or {type: "terminal", output: "..."}
// ---------------------------------------------------------------------------

function extractToolCallOutput(update: Record<string, unknown>): string | unknown[] | null {
  // Prefer rawOutput
  if (typeof update.rawOutput === "string") {
    return update.rawOutput;
  }
  if (update.rawOutput != null && update.rawOutput !== undefined) {
    return JSON.stringify(update.rawOutput);
  }

  // Try content array
  const content = update.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  const texts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;
    if (rec.type === "content") {
      const inner = asRecord(rec.content);
      if (inner && typeof inner.text === "string") {
        texts.push(inner.text);
      }
    } else if (rec.type === "terminal") {
      // Terminal content has an output field or a terminalId for reference
      if (typeof rec.output === "string") {
        texts.push(rec.output);
      }
    } else if (rec.type === "diff") {
      // Diff content
      const path = getString(rec, "path") ?? "";
      const newText = getString(rec, "newText") ?? "";
      if (path || newText) {
        texts.push(`[diff] ${path}\n${newText}`);
      }
    }
  }

  return texts.length > 0 ? texts.join("\n") : null;
}

// ---------------------------------------------------------------------------
// Map ACP PlanEntryStatus to canonical PlanEntryStatus
// ---------------------------------------------------------------------------

function mapPlanStatus(status: string): PlanEntryStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

// ---------------------------------------------------------------------------
// Map ACP ToolCallStatus to canonical ToolCallStatus
// ---------------------------------------------------------------------------

function mapToolCallStatus(status: string | undefined): ToolCallStatus | undefined {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main parser: parseAcpSessionUpdate
// ---------------------------------------------------------------------------

/**
 * Parse a raw ACP SessionNotification into a canonical AgentEvent.
 *
 * @param notification - The raw SessionNotification payload (the full notification object
 *   with `sessionId` and `update` fields).
 * @param timestamp - Optional ISO-8601 timestamp override; defaults to now.
 * @returns A canonical AgentEvent, or null if the notification cannot be parsed.
 */
export function parseAcpSessionUpdate(
  notification: unknown,
  timestamp?: string,
): AgentEvent | null {
  const rec = asRecord(notification);
  if (!rec) return null;

  const sessionId = getString(rec, "sessionId") ?? undefined;
  const ts = timestamp ?? new Date().toISOString();
  const update = asRecord(rec.update);
  if (!update) return null;

  const sessionUpdate = getString(update, "sessionUpdate");
  if (!sessionUpdate) return null;

  const baseMeta = {
    source: SOURCE,
    timestamp: ts,
    sessionId,
    raw: notification,
  } as const;

  switch (sessionUpdate) {
    // --- Content chunk events ---
    case "agent_message_chunk": {
      const text = extractChunkText(update);
      return {
        ...baseMeta,
        kind: "assistant_message_chunk",
        text,
      };
    }

    case "user_message_chunk": {
      const text = extractChunkText(update);
      return {
        ...baseMeta,
        kind: "user_message_chunk",
        text,
      };
    }

    case "agent_thought_chunk": {
      const text = extractChunkText(update);
      return {
        ...baseMeta,
        kind: "thought_chunk",
        text,
      };
    }

    // --- Tool call (new tool invocation) ---
    case "tool_call": {
      const toolName = extractToolName(update);
      const toolCallId = getString(update, "toolCallId") ?? "";
      const rawInput = update.rawInput;
      const input =
        rawInput != null && typeof rawInput === "object" && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {};
      const toolKind = getString(update, "kind");

      return {
        ...baseMeta,
        kind: "tool_use_requested",
        toolCallId,
        toolName,
        category: detectToolCategory(toolName),
        input,
        toolKind,
      };
    }

    // --- Tool call update (status change, partial output, result) ---
    case "tool_call_update": {
      return parseAcpToolCallUpdate(update, ts, sessionId, notification);
    }

    // --- Usage update ---
    case "usage_update": {
      const used = getNumber(update, "used");
      const size = getNumber(update, "size");
      return {
        ...baseMeta,
        kind: "usage",
        usage: {
          totalTokens: used ?? 0,
          ...(size != null ? { inputTokens: size } : {}),
        },
        totalUsed: used,
      };
    }

    // --- Plan ---
    case "plan": {
      const rawEntries = update.entries;
      if (!Array.isArray(rawEntries)) {
        return {
          ...baseMeta,
          kind: "plan",
          entries: [],
        };
      }
      const entries: PlanEntry[] = [];
      for (const entry of rawEntries) {
        const e = asRecord(entry);
        if (!e) continue;
        const title = getString(e, "content") ?? getString(e, "title") ?? "";
        const status = mapPlanStatus(getString(e, "status") ?? "pending");
        const priority = getString(e, "priority") as "high" | "medium" | "low" | undefined;
        entries.push({ title, status, priority });
      }

      return {
        ...baseMeta,
        kind: "plan",
        entries,
      };
    }

    // --- Available commands update ---
    case "available_commands_update": {
      return {
        ...baseMeta,
        kind: "notification",
        text: "Available commands updated",
        method: "available_commands_update",
      };
    }

    // --- Current mode update ---
    case "current_mode_update": {
      const currentModeId = getString(update, "currentModeId") ?? "unknown";
      return {
        ...baseMeta,
        kind: "mode_update",
        mode: currentModeId,
      };
    }

    // --- Config option update ---
    case "config_option_update": {
      const configOptions = update.configOptions;
      return {
        ...baseMeta,
        kind: "config_update",
        configId: "config_options",
        value: configOptions,
      };
    }

    // --- Session info update ---
    case "session_info_update": {
      const title = getString(update, "title");
      const updatedAt = getString(update, "updatedAt");
      const metadata: Record<string, unknown> = {};
      if (updatedAt) metadata.updatedAt = updatedAt;
      return {
        ...baseMeta,
        kind: "session_info_update",
        title: title ?? undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    }

    default: {
      return {
        ...baseMeta,
        kind: "unknown",
        data: update,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Tool call update parser (exported for direct use)
// ---------------------------------------------------------------------------

/**
 * Parse an ACP tool_call_update into a canonical AgentEvent.
 *
 * tool_call_update with status "completed" -> tool_result
 * tool_call_update with status "failed" -> tool_call_failed
 * tool_call_update with other status -> tool_call_update
 *
 * @param update - The raw update object (the `update` field from a SessionNotification,
 *   or a standalone tool_call_update payload).
 * @param timestamp - Optional ISO-8601 timestamp; defaults to now.
 * @param sessionId - Optional session ID to include in the event metadata.
 * @param raw - Optional raw payload to preserve for debugging.
 * @returns A canonical AgentEvent, or null if the payload cannot be parsed.
 */
export function parseAcpToolCallUpdate(
  update: unknown,
  timestamp?: string,
  sessionId?: string | null,
  raw?: unknown,
): AgentEvent | null {
  const rec = asRecord(update);
  if (!rec) return null;

  const ts = timestamp ?? new Date().toISOString();
  const sid = sessionId ?? getString(rec, "sessionId") ?? undefined;
  const toolCallId = getString(rec, "toolCallId") ?? "";
  const status = getString(rec, "status");
  const toolName = extractToolName(rec);
  const category = detectToolCategory(toolName);
  const toolKind = getString(rec, "kind");

  const baseMeta = {
    source: SOURCE,
    timestamp: ts,
    sessionId: sid,
    raw: raw ?? update,
  } as const;

  if (status === "completed") {
    // This is a tool result
    const output = extractToolCallOutput(rec);
    const rawInput = rec.rawInput;
    const input =
      rawInput != null && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : {};

    return {
      ...baseMeta,
      kind: "tool_result",
      toolCallId,
      toolName,
      category,
      input,
      output,
      isError: false,
      durationMs: null,
      toolKind,
    };
  }

  if (status === "failed") {
    // This is a tool call failure
    const output = extractToolCallOutput(rec);
    const rawInput = rec.rawInput;
    const input =
      rawInput != null && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : {};
    const errorText =
      typeof output === "string" ? output : output ? JSON.stringify(output) : "Tool call failed";

    return {
      ...baseMeta,
      kind: "tool_call_failed",
      toolCallId,
      toolName,
      category,
      input,
      error: errorText,
      durationMs: null,
    };
  }

  // Partial update / in_progress / pending
  const partialOutput = extractToolCallOutput(rec);
  return {
    ...baseMeta,
    kind: "tool_call_update",
    toolCallId,
    toolName: toolName !== "unknown" ? toolName : undefined,
    category: toolName !== "unknown" ? category : undefined,
    status: mapToolCallStatus(status),
    partialOutput: typeof partialOutput === "string" ? partialOutput : null,
    toolKind,
  };
}
