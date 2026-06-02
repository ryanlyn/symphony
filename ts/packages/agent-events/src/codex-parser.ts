/**
 * Codex app-server protocol message parser.
 *
 * Converts raw Codex JSON-RPC notifications into canonical AgentEvent instances.
 * The Codex app-server sends NDJSON messages where each line is a JSON-RPC
 * notification with a `method` field and `params` object.
 *
 * Key notification methods handled:
 *   - item/completed          (ThreadItem completed - reasoning, messages, tool calls)
 *   - item/started            (ThreadItem started - streaming in progress)
 *   - item/agentMessage/delta (Streaming text delta for agent messages)
 *   - item/reasoning/summaryTextDelta (Streaming reasoning summary deltas)
 *   - item/reasoning/textDelta (Streaming reasoning content deltas)
 *   - turn/started            (New turn begins)
 *   - turn/completed          (Turn finishes with optional usage)
 *   - thread/tokenUsage/updated (Cumulative token usage update)
 *   - account/rateLimits/updated (Rate limit snapshot)
 *   - thread/compacted        (Context compaction notification)
 *   - thread/name/updated     (Thread title changed)
 *   - thread/started          (Thread/session started)
 *   - thread/closed           (Thread/session ended)
 *   - process/exited          (Process exit notification)
 *   - rawResponseItem/completed (Raw Responses API item: function_call, function_call_output, etc.)
 */

import type { AgentEvent, ToolCategory, TokenUsage } from "./types.js";
import { detectToolCategory } from "./tool-categories.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function toIso(timestampMs: number | null | undefined): string {
  if (timestampMs != null && !Number.isNaN(timestampMs)) {
    return new Date(timestampMs).toISOString();
  }
  return nowIso();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeParseJson(str: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(str);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the effective tool category. For Codex items that are clearly
 * bash/shell commands, we return "bash_command"; for MCP and dynamic tool
 * calls we attempt lookup by tool name; otherwise fall through to "unknown".
 */
function resolveCategory(toolName: string, itemType?: string): ToolCategory {
  if (itemType === "commandExecution" || itemType === "local_shell_call") {
    return "bash_command";
  }
  if (itemType === "webSearch" || itemType === "web_search_call") {
    return "web";
  }
  if (itemType === "fileChange") {
    return "file_operation";
  }
  return detectToolCategory(toolName);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a top-level Codex JSON-RPC notification into a canonical AgentEvent.
 *
 * @param method - The JSON-RPC notification method (e.g. "item/completed")
 * @param params - The notification params payload
 * @param timestamp - Optional ISO-8601 timestamp; defaults to now if omitted
 * @returns A canonical AgentEvent, or null if the notification is not relevant
 */
export function parseCodexNotification(
  method: string,
  params: unknown,
  timestamp?: string,
): AgentEvent | null {
  const ts = timestamp ?? nowIso();
  const p = isRecord(params) ? params : {};

  switch (method) {
    // ----- Item lifecycle -----
    case "item/completed":
      return parseCodexItemCompleted(params, ts);

    case "item/started":
      return parseItemStarted(p, ts);

    // ----- Streaming deltas -----
    case "item/agentMessage/delta":
      return parseAgentMessageDelta(p, ts);

    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return parseReasoningDelta(p, ts);

    case "item/reasoning/summaryPartAdded":
      // A new reasoning summary part began; not enough content to emit yet
      return null;

    // ----- Raw response items (Responses API passthrough) -----
    case "rawResponseItem/completed":
      return parseRawResponseItemCompleted(p, ts);

    // ----- Turn lifecycle -----
    case "turn/started":
      return parseTurnStarted(p, ts);

    case "turn/completed":
      return parseTurnCompleted(p, ts);

    // ----- Token usage -----
    case "thread/tokenUsage/updated":
      return parseTokenUsageUpdated(p, ts);

    // ----- Rate limits -----
    case "account/rateLimits/updated":
    case "rateLimits/updated":
      return {
        kind: "rate_limit",
        source: "codex",
        timestamp: ts,
        limits: p.rateLimits ?? p,
        raw: params,
      };

    // ----- Session/thread lifecycle -----
    case "thread/started":
      return {
        kind: "session_started",
        source: "codex",
        timestamp: ts,
        sessionId: (p.threadId as string) ?? undefined,
        raw: params,
      };

    case "thread/closed":
      return {
        kind: "session_ended",
        source: "codex",
        timestamp: ts,
        sessionId: (p.threadId as string) ?? undefined,
        reason: "thread_closed",
        raw: params,
      };

    // ----- Thread info -----
    case "thread/name/updated":
      return {
        kind: "session_info_update",
        source: "codex",
        timestamp: ts,
        sessionId: (p.threadId as string) ?? undefined,
        title: (p.name as string) ?? undefined,
        raw: params,
      };

    case "thread/compacted":
      return {
        kind: "notification",
        source: "codex",
        timestamp: ts,
        text: "Context compacted",
        method,
        raw: params,
      };

    case "thread/goal/updated":
      return {
        kind: "notification",
        source: "codex",
        timestamp: ts,
        text: `Goal updated: ${(p.goal as string) ?? ""}`.trim(),
        method,
        raw: params,
      };

    // ----- Process lifecycle -----
    case "process/exited":
      return {
        kind: "process_exit",
        source: "codex",
        timestamp: ts,
        exitCode: (p.exitCode as number) ?? null,
        signal: (p.signal as string) ?? null,
        raw: params,
      };

    // ----- File system -----
    case "fs/changed":
      return {
        kind: "fs_write",
        source: "codex",
        timestamp: ts,
        path: (p.path as string) ?? (p.uri as string) ?? "",
        raw: params,
      };

    // ----- Plan updates -----
    case "turn/plan/updated":
    case "item/plan/delta":
      return parsePlanUpdate(p, ts);

    // ----- Command execution output delta (streaming) -----
    case "item/commandExecution/outputDelta":
      return {
        kind: "tool_call_update",
        source: "codex",
        timestamp: ts,
        toolCallId: (p.itemId as string) ?? "",
        toolName: "command_execution",
        category: "bash_command",
        status: "in_progress",
        partialOutput: (p.delta as string) ?? null,
        raw: params,
      };

    // ----- Notifications we intentionally skip -----
    case "hook/started":
    case "hook/completed":
    case "turn/diff/updated":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/mcpToolCall/progress":
    case "skills/changed":
    case "thread/settings/updated":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "model/rerouted":
    case "model/verification":
    case "mcpServer/startupStatus/updated":
    case "mcpServer/oauthLogin/completed":
    case "serverRequest/resolved":
    case "account/updated":
    case "account/login/completed":
    case "app/list/updated":
    case "remoteControl/status/changed":
    case "externalAgentConfig/import/completed":
    case "thread/goal/cleared":
    case "fuzzyFileSearch/sessionUpdated":
    case "fuzzyFileSearch/sessionCompleted":
    case "warning":
    case "guardianWarning":
    case "deprecationNotice":
    case "configWarning":
    case "error":
      return null;

    default:
      return null;
  }
}

/**
 * Parse an `item/completed` notification into a canonical AgentEvent.
 *
 * The item/completed notification contains a ThreadItem with a `type` discriminator.
 * Supported types: reasoning, agentMessage, userMessage, plan, commandExecution,
 * fileChange, dynamicToolCall, mcpToolCall, collabAgentToolCall, webSearch,
 * contextCompaction, hookPrompt.
 *
 * @param params - The notification params (should have `item`, `threadId`, `turnId`, `completedAtMs`)
 * @param timestamp - Optional ISO-8601 timestamp; defaults to now if omitted
 * @returns A canonical AgentEvent, or null if the item type is not relevant
 */
export function parseCodexItemCompleted(params: unknown, timestamp?: string): AgentEvent | null {
  if (!isRecord(params)) return null;

  const completedAtMs = params.completedAtMs as number | undefined;
  const ts = timestamp ?? toIso(completedAtMs);
  const threadId = (params.threadId as string) ?? undefined;
  const item = params.item as Record<string, unknown> | undefined;
  if (!item || !isRecord(item)) return null;

  const itemType = item.type as string | undefined;
  const itemId = (item.id as string) ?? undefined;

  switch (itemType) {
    // ----- Reasoning / thought -----
    case "reasoning": {
      let text = "";
      // Try summary first (array of strings)
      const summary = item.summary as string[] | undefined;
      if (summary && summary.length > 0) {
        text = summary.filter(Boolean).join("\n");
      }
      // Fallback to content array
      if (!text) {
        const content = item.content as string[] | undefined;
        if (content && content.length > 0) {
          text = content.filter(Boolean).join("\n");
        }
      }
      if (!text) return null;
      return {
        kind: "thought",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        text,
        raw: params,
      };
    }

    // ----- Agent message -----
    case "agentMessage":
      return {
        kind: "assistant_message",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        text: (item.text as string) ?? "",
        raw: params,
      };

    // ----- User message -----
    case "userMessage": {
      const content = item.content as Array<Record<string, unknown>> | undefined;
      let text = "";
      if (content && content.length > 0) {
        text = content
          .map((c) => (c.text as string) ?? "")
          .filter(Boolean)
          .join("\n");
      }
      return {
        kind: "user_message",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        text,
        raw: params,
      };
    }

    // ----- Plan -----
    case "plan": {
      const planText = (item.text as string) ?? "";
      // Codex plans are a text blob; try to parse into entries
      const entries = parsePlanText(planText);
      return {
        kind: "plan",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        entries,
        raw: params,
      };
    }

    // ----- Command execution -----
    case "commandExecution": {
      const command = (item.command as string) ?? "";
      const exitCode = item.exitCode as number | null | undefined;
      const isError = (item.status as string) === "failed" || (exitCode != null && exitCode !== 0);
      const durationMs = (item.durationMs as number) ?? null;
      const output = (item.aggregatedOutput as string) ?? null;
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `cmd-${Date.now()}`,
        toolName: "command_execution",
        category: "bash_command",
        input: { command, cwd: item.cwd ?? undefined },
        output,
        isError,
        durationMs,
        raw: params,
      };
    }

    // ----- File change (apply_patch) -----
    case "fileChange": {
      const changes = item.changes as Array<Record<string, unknown>> | undefined;
      const paths = changes?.map((c) => (c.path as string) ?? "").filter(Boolean) ?? [];
      const isError =
        (item.status as string) === "failed" || (item.status as string) === "declined";
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `file-${Date.now()}`,
        toolName: "file_change",
        category: "file_operation",
        input: { paths },
        output: changes ? JSON.stringify(changes) : null,
        isError,
        durationMs: null,
        raw: params,
      };
    }

    // ----- Dynamic tool call (built-in Codex tools dispatched dynamically) -----
    case "dynamicToolCall": {
      const toolName = (item.tool as string) ?? "unknown";
      const args = item.arguments;
      const input = isRecord(args) ? args : typeof args === "string" ? safeParseJson(args) : {};
      const contentItems = item.contentItems as Array<Record<string, unknown>> | undefined;
      const output = contentItems
        ? contentItems
            .map((c) => (c.text as string) ?? "")
            .filter(Boolean)
            .join("\n") || null
        : null;
      const isError = (item.status as string) === "failed" || (item.success as boolean) === false;
      const durationMs = (item.durationMs as number) ?? null;
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `dyn-${Date.now()}`,
        toolName,
        category: resolveCategory(toolName, "dynamicToolCall"),
        input,
        output,
        isError,
        durationMs,
        raw: params,
      };
    }

    // ----- MCP tool call -----
    case "mcpToolCall": {
      const toolName = (item.tool as string) ?? "unknown";
      const server = (item.server as string) ?? "";
      const args = item.arguments;
      const input = isRecord(args) ? args : typeof args === "string" ? safeParseJson(args) : {};
      const result = item.result as Record<string, unknown> | undefined;
      const error = item.error as Record<string, unknown> | undefined;
      const isError = (item.status as string) === "failed" || error != null;
      const durationMs = (item.durationMs as number) ?? null;

      // Extract output from MCP result
      let output: string | unknown[] | null = null;
      if (result) {
        const contentArr = result.content as unknown[] | undefined;
        if (contentArr && contentArr.length > 0) {
          output = contentArr;
        }
      }
      if (error && !output) {
        output = (error.message as string) ?? JSON.stringify(error);
      }

      const qualifiedName = server ? `${server}/${toolName}` : toolName;
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `mcp-${Date.now()}`,
        toolName: qualifiedName,
        category: resolveCategory(toolName, "mcpToolCall"),
        input: { ...input, _server: server },
        output,
        isError,
        durationMs,
        raw: params,
      };
    }

    // ----- Collab agent tool call -----
    case "collabAgentToolCall": {
      const toolName = (item.tool as string) ?? "collabAgent";
      const isError = (item.status as string) === "failed";
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `collab-${Date.now()}`,
        toolName,
        category: "agent",
        input: {
          prompt: item.prompt ?? undefined,
          model: item.model ?? undefined,
          receiverThreadIds: item.receiverThreadIds ?? undefined,
        },
        output: JSON.stringify(item.agentsStates ?? null),
        isError,
        durationMs: null,
        raw: params,
      };
    }

    // ----- Web search -----
    case "webSearch": {
      const query = (item.query as string) ?? "";
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `web-${Date.now()}`,
        toolName: "web_search",
        category: "web",
        input: { query },
        output: null,
        isError: false,
        durationMs: null,
        raw: params,
      };
    }

    // ----- Context compaction -----
    case "contextCompaction":
      return {
        kind: "notification",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        text: "Context compacted",
        method: "item/completed",
        raw: params,
      };

    // ----- Hook prompt -----
    case "hookPrompt": {
      const fragments = item.fragments as Array<Record<string, unknown>> | undefined;
      const text =
        fragments
          ?.map((f) => (f.text as string) ?? "")
          .filter(Boolean)
          .join("\n") ?? "";
      if (!text) return null;
      return {
        kind: "notification",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        text: `[Hook] ${text}`,
        method: "item/completed",
        raw: params,
      };
    }

    // ----- Image generation -----
    case "imageGeneration":
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `img-${Date.now()}`,
        toolName: "image_generation",
        category: "unknown",
        input: {},
        output: (item.result as string) ?? null,
        isError: (item.status as string) === "failed",
        durationMs: null,
        raw: params,
      };

    // ----- Image view -----
    case "imageView":
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `imgview-${Date.now()}`,
        toolName: "image_view",
        category: "file_operation",
        input: { path: item.path ?? "" },
        output: null,
        isError: false,
        durationMs: null,
        raw: params,
      };

    // ----- Review mode -----
    case "enteredReviewMode":
      return {
        kind: "mode_update",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        mode: "review",
        raw: params,
      };

    case "exitedReviewMode":
      return {
        kind: "mode_update",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        mode: "normal",
        raw: params,
      };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Internal parse helpers
// ---------------------------------------------------------------------------

function parseItemStarted(p: Record<string, unknown>, ts: string): AgentEvent | null {
  const item = p.item as Record<string, unknown> | undefined;
  if (!item || !isRecord(item)) return null;
  const itemType = item.type as string | undefined;
  const itemId = (item.id as string) ?? undefined;
  const threadId = (p.threadId as string) ?? undefined;

  switch (itemType) {
    case "commandExecution":
      return {
        kind: "tool_use_requested",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `cmd-${Date.now()}`,
        toolName: "command_execution",
        category: "bash_command",
        input: { command: item.command ?? "" },
        raw: { method: "item/started", params: p },
      };

    case "dynamicToolCall": {
      const toolName = (item.tool as string) ?? "unknown";
      const args = item.arguments;
      const input = isRecord(args) ? args : typeof args === "string" ? safeParseJson(args) : {};
      return {
        kind: "tool_use_requested",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `dyn-${Date.now()}`,
        toolName,
        category: resolveCategory(toolName, "dynamicToolCall"),
        input,
        raw: { method: "item/started", params: p },
      };
    }

    case "mcpToolCall": {
      const toolName = (item.tool as string) ?? "unknown";
      const server = (item.server as string) ?? "";
      const args = item.arguments;
      const input = isRecord(args) ? args : typeof args === "string" ? safeParseJson(args) : {};
      const qualifiedName = server ? `${server}/${toolName}` : toolName;
      return {
        kind: "tool_use_requested",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `mcp-${Date.now()}`,
        toolName: qualifiedName,
        category: resolveCategory(toolName, "mcpToolCall"),
        input: { ...input, _server: server },
        raw: { method: "item/started", params: p },
      };
    }

    case "fileChange":
      return {
        kind: "tool_use_requested",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        eventId: itemId,
        toolCallId: itemId ?? `file-${Date.now()}`,
        toolName: "file_change",
        category: "file_operation",
        input: {},
        raw: { method: "item/started", params: p },
      };

    default:
      return null;
  }
}

function parseAgentMessageDelta(p: Record<string, unknown>, ts: string): AgentEvent | null {
  const delta = (p.delta as string) ?? "";
  if (!delta) return null;
  return {
    kind: "assistant_message_chunk",
    source: "codex",
    timestamp: ts,
    sessionId: (p.threadId as string) ?? undefined,
    eventId: (p.itemId as string) ?? undefined,
    text: delta,
    raw: { method: "item/agentMessage/delta", params: p },
  };
}

function parseReasoningDelta(p: Record<string, unknown>, ts: string): AgentEvent | null {
  const delta = (p.delta as string) ?? "";
  if (!delta) return null;
  return {
    kind: "thought_chunk",
    source: "codex",
    timestamp: ts,
    sessionId: (p.threadId as string) ?? undefined,
    eventId: (p.itemId as string) ?? undefined,
    text: delta,
    raw: { method: "item/reasoning/textDelta", params: p },
  };
}

/**
 * Parse a rawResponseItem/completed notification.
 *
 * These are raw Responses API items passed through by the Codex app-server.
 * Types: message, reasoning, local_shell_call, function_call, function_call_output,
 *        custom_tool_call, custom_tool_call_output, web_search_call, tool_search_call,
 *        tool_search_output, image_generation_call, compaction, other.
 */
function parseRawResponseItemCompleted(p: Record<string, unknown>, ts: string): AgentEvent | null {
  const item = p.item as Record<string, unknown> | undefined;
  if (!item || !isRecord(item)) return null;
  const itemType = item.type as string | undefined;
  const threadId = (p.threadId as string) ?? undefined;

  switch (itemType) {
    // ----- Message (role: assistant or user) -----
    case "message": {
      const role = (item.role as string) ?? "assistant";
      const content = item.content as Array<Record<string, unknown>> | undefined;
      const text =
        content
          ?.map((c) => (c.text as string) ?? "")
          .filter(Boolean)
          .join("\n") ?? "";
      if (role === "user") {
        return {
          kind: "user_message",
          source: "codex",
          timestamp: ts,
          sessionId: threadId,
          text,
          raw: { method: "rawResponseItem/completed", params: p },
        };
      }
      return {
        kind: "assistant_message",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        text,
        raw: { method: "rawResponseItem/completed", params: p },
      };
    }

    // ----- Reasoning -----
    case "reasoning": {
      const summary = item.summary as Array<Record<string, unknown>> | undefined;
      const content = item.content as Array<Record<string, unknown>> | undefined;
      let text = "";
      if (summary && summary.length > 0) {
        text = summary
          .map((s) => (s.text as string) ?? "")
          .filter(Boolean)
          .join("\n");
      }
      if (!text && content && content.length > 0) {
        text = content
          .map((c) => (c.text as string) ?? "")
          .filter(Boolean)
          .join("\n");
      }
      if (!text) return null;
      return {
        kind: "thought",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        text,
        raw: { method: "rawResponseItem/completed", params: p },
      };
    }

    // ----- Local shell call -----
    case "local_shell_call": {
      const action = item.action as Record<string, unknown> | undefined;
      const command = action?.command;
      const cmdStr = Array.isArray(command) ? command.join(" ") : String(command ?? "");
      const callId = (item.call_id as string) ?? (item.id as string) ?? `shell-${Date.now()}`;
      return {
        kind: "tool_use_requested",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        toolCallId: callId,
        toolName: "local_shell_call",
        category: "bash_command",
        input: {
          command: cmdStr,
          working_directory: action?.working_directory ?? undefined,
        },
        raw: { method: "rawResponseItem/completed", params: p },
      };
    }

    // ----- Function call (model invokes a tool) -----
    case "function_call": {
      const name = (item.name as string) ?? "unknown";
      const callId = (item.call_id as string) ?? (item.id as string) ?? `fn-${Date.now()}`;
      const argsRaw = item.arguments;
      const input =
        typeof argsRaw === "string" ? safeParseJson(argsRaw) : isRecord(argsRaw) ? argsRaw : {};
      return {
        kind: "tool_use_requested",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        toolCallId: callId,
        toolName: name,
        category: resolveCategory(name, "function_call"),
        input,
        raw: { method: "rawResponseItem/completed", params: p },
      };
    }

    // ----- Function call output (tool result returned) -----
    case "function_call_output": {
      const callId = (item.call_id as string) ?? `fnout-${Date.now()}`;
      const outputRaw = item.output;
      let output: string | unknown[] | null = null;
      if (typeof outputRaw === "string") {
        output = outputRaw;
      } else if (Array.isArray(outputRaw)) {
        output = outputRaw;
      }
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        toolCallId: callId,
        toolName: "unknown",
        category: "unknown",
        input: {},
        output,
        isError: false,
        durationMs: null,
        raw: { method: "rawResponseItem/completed", params: p },
      };
    }

    // ----- Custom tool call -----
    case "custom_tool_call": {
      const name = (item.name as string) ?? "unknown";
      const callId = (item.call_id as string) ?? (item.id as string) ?? `custom-${Date.now()}`;
      const inputRaw = item.input;
      const input =
        typeof inputRaw === "string" ? safeParseJson(inputRaw) : isRecord(inputRaw) ? inputRaw : {};
      return {
        kind: "tool_use_requested",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        toolCallId: callId,
        toolName: name,
        category: resolveCategory(name, "custom_tool_call"),
        input,
        raw: { method: "rawResponseItem/completed", params: p },
      };
    }

    // ----- Custom tool call output -----
    case "custom_tool_call_output": {
      const callId = (item.call_id as string) ?? `customout-${Date.now()}`;
      const outputRaw = item.output;
      let output: string | unknown[] | null = null;
      if (typeof outputRaw === "string") {
        output = outputRaw;
      } else if (Array.isArray(outputRaw)) {
        output = outputRaw;
      }
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        toolCallId: callId,
        toolName: (item.name as string) ?? "unknown",
        category: "unknown",
        input: {},
        output,
        isError: false,
        durationMs: null,
        raw: { method: "rawResponseItem/completed", params: p },
      };
    }

    // ----- Web search call -----
    case "web_search_call":
      return {
        kind: "tool_use_requested",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        toolCallId: (item.id as string) ?? `websearch-${Date.now()}`,
        toolName: "web_search",
        category: "web",
        input: { action: item.action ?? undefined },
        raw: { method: "rawResponseItem/completed", params: p },
      };

    // ----- Tool search call -----
    case "tool_search_call": {
      const callId = (item.call_id as string) ?? (item.id as string) ?? `toolsearch-${Date.now()}`;
      return {
        kind: "tool_use_requested",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        toolCallId: callId,
        toolName: "tool_search",
        category: "search",
        input: { execution: item.execution ?? undefined },
        raw: { method: "rawResponseItem/completed", params: p },
      };
    }

    // ----- Tool search output -----
    case "tool_search_output": {
      const callId = (item.call_id as string) ?? `toolsearchout-${Date.now()}`;
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        toolCallId: callId,
        toolName: "tool_search",
        category: "search",
        input: { execution: item.execution ?? undefined },
        output: JSON.stringify(item.tools ?? []),
        isError: false,
        durationMs: null,
        raw: { method: "rawResponseItem/completed", params: p },
      };
    }

    // ----- Image generation call -----
    case "image_generation_call":
      return {
        kind: "tool_result",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        toolCallId: (item.id as string) ?? `imggen-${Date.now()}`,
        toolName: "image_generation",
        category: "unknown",
        input: {},
        output: (item.result as string) ?? null,
        isError: (item.status as string) === "failed",
        durationMs: null,
        raw: { method: "rawResponseItem/completed", params: p },
      };

    // ----- Compaction / context_compaction / compaction_trigger -----
    case "compaction":
    case "context_compaction":
    case "compaction_trigger":
      return {
        kind: "notification",
        source: "codex",
        timestamp: ts,
        sessionId: threadId,
        text: "Context compacted",
        method: "rawResponseItem/completed",
        raw: { method: "rawResponseItem/completed", params: p },
      };

    // ----- Other / unknown -----
    case "other":
    default:
      return null;
  }
}

function parseTurnStarted(p: Record<string, unknown>, ts: string): AgentEvent {
  const turn = p.turn as Record<string, unknown> | undefined;
  const threadId = (p.threadId as string) ?? undefined;
  return {
    kind: "turn_started",
    source: "codex",
    timestamp: ts,
    sessionId: threadId,
    eventId: turn?.id as string | undefined,
    raw: { method: "turn/started", params: p },
  };
}

function parseTurnCompleted(p: Record<string, unknown>, ts: string): AgentEvent {
  const turn = p.turn as Record<string, unknown> | undefined;
  const threadId = (p.threadId as string) ?? undefined;
  const status = turn?.status as string | undefined;
  const error = turn?.error as Record<string, unknown> | undefined;
  const durationMs = (turn?.durationMs as number) ?? null;

  // Extract usage from turn/completed params.
  // The turn/completed notification itself may carry top-level usage.
  let usage: TokenUsage | null = null;
  const rawUsage = (p.usage ?? p.tokenUsage) as Record<string, unknown> | undefined;
  if (rawUsage) {
    usage = extractUsage(rawUsage);
  }

  // Check turn status for failure/interruption
  if (status === "failed" && error) {
    return {
      kind: "turn_failed",
      source: "codex",
      timestamp: ts,
      sessionId: threadId,
      eventId: turn?.id as string | undefined,
      error: (error.message as string) ?? "Unknown error",
      durationMs,
      raw: { method: "turn/completed", params: p },
    };
  }

  if (status === "interrupted") {
    return {
      kind: "turn_cancelled",
      source: "codex",
      timestamp: ts,
      sessionId: threadId,
      eventId: turn?.id as string | undefined,
      reason: "interrupted",
      raw: { method: "turn/completed", params: p },
    };
  }

  return {
    kind: "turn_completed",
    source: "codex",
    timestamp: ts,
    sessionId: threadId,
    eventId: turn?.id as string | undefined,
    usage,
    durationMs,
    raw: { method: "turn/completed", params: p },
  };
}

function parseTokenUsageUpdated(p: Record<string, unknown>, ts: string): AgentEvent {
  const tokenUsage = p.tokenUsage as Record<string, unknown> | undefined;
  const total = tokenUsage?.total as Record<string, unknown> | undefined;
  const last = tokenUsage?.last as Record<string, unknown> | undefined;
  const threadId = (p.threadId as string) ?? undefined;

  const usage: Partial<TokenUsage> = {};
  if (last) {
    usage.inputTokens = (last.inputTokens as number) ?? 0;
    usage.outputTokens = (last.outputTokens as number) ?? 0;
    usage.totalTokens = (last.totalTokens as number) ?? 0;
    usage.cacheReadTokens = (last.cachedInputTokens as number) ?? undefined;
  } else if (total) {
    usage.inputTokens = (total.inputTokens as number) ?? 0;
    usage.outputTokens = (total.outputTokens as number) ?? 0;
    usage.totalTokens = (total.totalTokens as number) ?? 0;
    usage.cacheReadTokens = (total.cachedInputTokens as number) ?? undefined;
  }

  const totalUsed = total?.totalTokens as number | undefined;

  return {
    kind: "usage",
    source: "codex",
    timestamp: ts,
    sessionId: threadId,
    usage,
    totalUsed,
    raw: { method: "thread/tokenUsage/updated", params: p },
  };
}

function parsePlanUpdate(p: Record<string, unknown>, ts: string): AgentEvent | null {
  const plan = (p.plan ?? p.text ?? p.delta) as string | Array<Record<string, unknown>> | undefined;
  if (!plan) return null;

  let entries: Array<{
    id?: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
    priority?: "high" | "medium" | "low";
  }> = [];

  if (typeof plan === "string") {
    entries = parsePlanText(plan);
  } else if (Array.isArray(plan)) {
    entries = plan.map((entry) => ({
      id: (entry.id as string) ?? undefined,
      title: (entry.title as string) ?? (entry.text as string) ?? "",
      status: normalizePlanStatus((entry.status as string) ?? "pending"),
    }));
  }

  if (entries.length === 0) return null;

  return {
    kind: "plan",
    source: "codex",
    timestamp: ts,
    sessionId: (p.threadId as string) ?? undefined,
    entries,
    raw: { method: "turn/plan/updated", params: p },
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function extractUsage(raw: Record<string, unknown>): TokenUsage | null {
  const inputTokens = (raw.inputTokens as number) ?? (raw.input_tokens as number) ?? 0;
  const outputTokens = (raw.outputTokens as number) ?? (raw.output_tokens as number) ?? 0;
  const totalTokens =
    (raw.totalTokens as number) ?? (raw.total_tokens as number) ?? inputTokens + outputTokens;
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens:
      (raw.cachedInputTokens as number) ?? (raw.cache_read_tokens as number) ?? undefined,
    cacheWriteTokens:
      (raw.cacheWriteTokens as number) ?? (raw.cache_write_tokens as number) ?? undefined,
  };
}

/**
 * Parse a plan text blob into structured entries.
 * Plans are typically formatted as markdown-like bullet lists:
 *   - [x] Step 1 (completed)
 *   - [ ] Step 2 (pending)
 *   - [~] Step 3 (in progress)
 * Or just plain numbered/bulleted lists.
 */
function parsePlanText(text: string): Array<{
  id?: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
}> {
  if (!text.trim()) return [];

  const lines = text.split("\n").filter((l) => l.trim());
  const entries: Array<{
    id?: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Match checkbox patterns: - [x] ..., - [ ] ..., - [~] ..., * [x] ...
    const checkboxMatch = trimmed.match(/^[-*]\s*\[([x~\s])\]\s*(.+)/i);
    if (checkboxMatch) {
      const marker = checkboxMatch[1]!.toLowerCase();
      const title = checkboxMatch[2]!.trim();
      let status: "pending" | "in_progress" | "completed" = "pending";
      if (marker === "x") status = "completed";
      else if (marker === "~") status = "in_progress";
      entries.push({ title, status });
      continue;
    }

    // Match numbered or bulleted plain lists: 1. ..., - ..., * ...
    const listMatch = trimmed.match(/^(?:\d+[.)]\s*|[-*]\s+)(.+)/);
    if (listMatch) {
      entries.push({ title: listMatch[1]!.trim(), status: "pending" });
      continue;
    }

    // If it's just a plain non-empty line, treat as an entry
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      entries.push({ title: trimmed, status: "pending" });
    }
  }

  return entries;
}

function normalizePlanStatus(
  status: string,
): "pending" | "in_progress" | "completed" | "failed" | "skipped" {
  switch (status) {
    case "completed":
    case "done":
      return "completed";
    case "in_progress":
    case "inProgress":
    case "running":
      return "in_progress";
    case "failed":
    case "error":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}
