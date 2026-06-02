/**
 * JSONL trace parser for Symphony AgentUpdate events.
 *
 * Each line in a trace file is a JSON object with at minimum:
 *   { type, issueId, issueIdentifier, timestamp, message, usage, ... }
 *
 * This module maps raw AgentUpdate types to DisplayEvent types for the frontend.
 * It delegates individual line parsing to the canonical @symphony/agent-events parsers
 * and converts the resulting AgentEvent types back to DisplayEvent for the frontend.
 */

import type { AgentEvent } from "@symphony/agent-events";
import {
  detectToolCategory as canonicalDetectToolCategory,
  parseCodexNotification,
  parseAcpSessionUpdate,
} from "@symphony/agent-events";

import type {
  DisplayEvent,
  ToolCallDisplayEvent,
  ToolCategory,
  TokenUsage,
} from "./models/display-events.js";

// Re-export detectToolCategory delegating to canonical implementation
export function detectToolCategory(toolName: string): ToolCategory {
  return canonicalDetectToolCategory(toolName);
}

/**
 * Represents a raw trace line as emitted by TraceEmitter.
 */
interface RawTraceLine {
  type: string;
  issueId: string;
  issueIdentifier: string;
  timestamp: string | null;
  message?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  workspacePath?: string | null;
  sessionId?: string | null;
  executorPid?: string | null;
  canonicalEvent?: unknown;
}

interface PendingToolCall {
  event: ToolCallDisplayEvent;
  toolUseId: string;
  startTs: string;
}

/** Tracks a turn_started event and whether it has been consumed by a completion/failure/cancellation. */
interface TurnStartedRecord {
  timestamp: string;
  consumed: boolean;
}

/**
 * Parse a single JSONL line into a RawTraceLine, or null if invalid.
 */
function parseLine(line: string): RawTraceLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null) return null;
    return obj as unknown as RawTraceLine;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Canonical AgentEvent -> DisplayEvent converter
// ---------------------------------------------------------------------------

/**
 * Convert a canonical AgentEvent to a DisplayEvent for the frontend.
 * Returns null if the event type does not have a DisplayEvent representation.
 */
export function canonicalEventToDisplay(event: AgentEvent): DisplayEvent | null {
  switch (event.kind) {
    case "thought":
      return {
        kind: "thought",
        text: event.text,
        timestamp: event.timestamp,
        durationMs: event.durationMs,
      };

    case "thought_chunk":
      return {
        kind: "thought",
        text: event.text,
        timestamp: event.timestamp,
      };

    case "assistant_message":
      return {
        kind: "message",
        text: event.text,
        timestamp: event.timestamp,
      };

    case "assistant_message_chunk":
      return {
        kind: "message",
        text: event.text,
        timestamp: event.timestamp,
      };

    case "user_message":
      return {
        kind: "message",
        text: event.text,
        timestamp: event.timestamp,
      };

    case "user_message_chunk":
      return {
        kind: "message",
        text: event.text,
        timestamp: event.timestamp,
      };

    case "tool_use_requested":
      return {
        kind: "tool_call",
        category: event.category,
        toolName: event.toolName,
        input: event.input,
        output: null,
        isError: false,
        durationMs: null,
        nestedEvents: [],
        timestamp: event.timestamp,
      };

    case "tool_result":
      return {
        kind: "tool_call",
        category: event.category,
        toolName: event.toolName,
        input: event.input,
        output: event.output,
        isError: event.isError,
        durationMs: event.durationMs,
        nestedEvents: [],
        timestamp: event.timestamp,
      };

    case "tool_call_failed":
      return {
        kind: "tool_call",
        category: event.category,
        toolName: event.toolName,
        input: event.input,
        output: event.error,
        isError: true,
        durationMs: event.durationMs,
        nestedEvents: [],
        timestamp: event.timestamp,
      };

    case "tool_call_update":
      // tool_call_update is a partial update; return null and let the orchestration handle it
      return null;

    case "turn_started":
      return {
        kind: "turn_started",
        turnIndex: event.turnIndex ?? 0,
        timestamp: event.timestamp,
      };

    case "turn_completed":
      return {
        kind: "turn_completed",
        usage: event.usage
          ? {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              totalTokens: event.usage.totalTokens,
            }
          : null,
        durationMs: event.durationMs ?? null,
        timestamp: event.timestamp,
      };

    case "turn_failed":
      return {
        kind: "turn_failed",
        text: `Turn failed: ${event.error}`,
        timestamp: event.timestamp,
      };

    case "turn_cancelled":
      return {
        kind: "turn_failed",
        text: `Turn cancelled: ${event.reason ?? "unknown"}`,
        timestamp: event.timestamp,
      };

    case "notification":
      return {
        kind: "notification",
        text: event.text,
        timestamp: event.timestamp,
      };

    case "plan":
    case "mode_update":
    case "config_update":
    case "session_info_update":
      return {
        kind: "notification",
        text:
          event.kind === "plan"
            ? `Plan: ${event.entries.map((e) => e.title).join(", ")}`
            : event.kind === "mode_update"
              ? `Mode: ${event.mode}`
              : event.kind === "session_info_update"
                ? `Session info updated${event.title ? `: ${event.title}` : ""}`
                : `Config updated: ${(event as { configId: string }).configId}`,
        timestamp: event.timestamp,
      };

    // Events without a useful display representation
    case "session_started":
    case "session_ended":
    case "turn_input_required":
    case "usage":
    case "rate_limit":
    case "approval_required":
    case "approval_auto_approved":
    case "tool_input_auto_answered":
    case "workspace_prepared":
    case "fs_write":
    case "process_exit":
    case "stderr":
    case "malformed":
    case "unknown":
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers for extracting data from trace line messages
// ---------------------------------------------------------------------------

/**
 * Extract text from an ACP SessionNotification message.
 * ACP wraps content in: {sessionId, update: {sessionUpdate, content: {type: "text", text: "..."}}}
 */
function extractAcpText(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const rec = msg as Record<string, unknown>;
  const update = rec.update as Record<string, unknown> | undefined;
  if (!update) return null;
  const content = update.content as Record<string, unknown> | undefined;
  if (content && typeof content.text === "string") return content.text;
  return null;
}

/**
 * Determine if a message payload is in ACP format (has sessionId + update.sessionUpdate).
 */
function isAcpMessage(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  const rec = msg as Record<string, unknown>;
  if (!rec.update || typeof rec.update !== "object") return false;
  const update = rec.update as Record<string, unknown>;
  return typeof update.sessionUpdate === "string";
}

/**
 * Determine if a message payload is in Codex notification format (has method + params).
 */
function isCodexNotification(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  const rec = msg as Record<string, unknown>;
  return typeof rec.method === "string" && rec.params !== undefined;
}

/**
 * Try to parse a trace line message using canonical parsers.
 * Returns the canonical AgentEvent if successful, null otherwise.
 */
function tryCanonicalParse(msg: unknown, ts: string): AgentEvent | null {
  if (typeof msg !== "object" || msg === null) return null;

  // Try ACP format first
  if (isAcpMessage(msg)) {
    return parseAcpSessionUpdate(msg, ts);
  }

  // Try Codex notification format
  if (isCodexNotification(msg)) {
    const rec = msg as Record<string, unknown>;
    const method = rec.method as string;
    const params = rec.params;
    return parseCodexNotification(method, params, ts);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Canonical event fast path
// ---------------------------------------------------------------------------

/**
 * Attempt to handle a pre-parsed canonical AgentEvent, maintaining orchestration
 * state (turn tracking, pending tool calls). Returns true if the event was handled.
 */
function handleCanonicalEvent(
  ce: AgentEvent,
  ts: string,
  events: DisplayEvent[],
  pendingToolCalls: Map<string, PendingToolCall>,
  turnStartedRecords: TurnStartedRecord[],
  turnIndex: number,
): boolean {
  switch (ce.kind) {
    case "turn_started": {
      turnStartedRecords.push({ timestamp: ts, consumed: false });
      events.push({ kind: "turn_started", turnIndex: turnIndex + 1, timestamp: ts });
      return true;
    }

    case "turn_completed": {
      let durationMs: number | null = null;
      for (let i = turnStartedRecords.length - 1; i >= 0; i--) {
        const record = turnStartedRecords[i];
        if (record !== undefined && !record.consumed) {
          record.consumed = true;
          const startMs = new Date(record.timestamp).getTime();
          const endMs = new Date(ts).getTime();
          if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) durationMs = endMs - startMs;
          break;
        }
      }
      let usage: TokenUsage | null = null;
      if (ce.usage) {
        usage = {
          inputTokens: ce.usage.inputTokens,
          outputTokens: ce.usage.outputTokens,
          totalTokens: ce.usage.totalTokens,
        };
      }
      events.push({ kind: "turn_completed", usage, durationMs, timestamp: ts });
      return true;
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
      const text =
        ce.kind === "turn_failed"
          ? `Turn failed: ${ce.error}`
          : `Turn cancelled: ${ce.reason ?? "unknown"}`;
      events.push({ kind: "turn_failed", text, timestamp: ts });
      return true;
    }

    case "tool_use_requested": {
      const toolCall: ToolCallDisplayEvent = {
        kind: "tool_call",
        category: ce.category,
        toolName: ce.toolName,
        input: ce.input,
        output: null,
        isError: false,
        durationMs: null,
        nestedEvents: [],
        timestamp: ts,
      };
      pendingToolCalls.set(ce.toolCallId, {
        event: toolCall,
        toolUseId: ce.toolCallId,
        startTs: ts,
      });
      return true;
    }

    case "tool_result": {
      const pending = pendingToolCalls.get(ce.toolCallId);
      if (pending) {
        pendingToolCalls.delete(ce.toolCallId);
        const toolCall = pending.event;
        if (ce.output !== null) toolCall.output = ce.output;
        toolCall.isError = ce.isError;
        const startMs = new Date(pending.startTs).getTime();
        const endMs = new Date(ts).getTime();
        toolCall.durationMs = Number.isNaN(startMs) || Number.isNaN(endMs) ? null : endMs - startMs;
        events.push(toolCall);
      } else {
        events.push({
          kind: "tool_call",
          category: ce.category,
          toolName: ce.toolName,
          input: ce.input,
          output: ce.output,
          isError: ce.isError,
          durationMs: ce.durationMs,
          nestedEvents: [],
          timestamp: ts,
        });
      }
      return true;
    }

    case "tool_call_failed": {
      const pending = pendingToolCalls.get(ce.toolCallId);
      if (pending) {
        pendingToolCalls.delete(ce.toolCallId);
        const toolCall = pending.event;
        toolCall.output = ce.error;
        toolCall.isError = true;
        const startMs = new Date(pending.startTs).getTime();
        const endMs = new Date(ts).getTime();
        toolCall.durationMs = Number.isNaN(startMs) || Number.isNaN(endMs) ? null : endMs - startMs;
        events.push(toolCall);
      } else {
        events.push({
          kind: "tool_call",
          category: ce.category,
          toolName: ce.toolName,
          input: ce.input,
          output: ce.error,
          isError: true,
          durationMs: ce.durationMs,
          nestedEvents: [],
          timestamp: ts,
        });
      }
      return true;
    }

    case "tool_call_update": {
      const pending = ce.toolCallId ? pendingToolCalls.get(ce.toolCallId) : undefined;
      if (pending && ce.partialOutput != null) {
        if (typeof pending.event.output === "string") {
          pending.event.output += ce.partialOutput;
        } else {
          pending.event.output = ce.partialOutput;
        }
      }
      return true;
    }

    case "thought":
    case "thought_chunk":
    case "assistant_message":
    case "assistant_message_chunk":
    case "user_message":
    case "user_message_chunk": {
      const display = canonicalEventToDisplay(ce);
      if (display) events.push(display);
      return true;
    }

    case "plan":
    case "mode_update":
    case "config_update":
    case "session_info_update":
    case "notification": {
      const display = canonicalEventToDisplay(ce);
      if (display) events.push(display);
      return true;
    }

    // Events without display representation — handled (skipped) by the fast path
    case "session_started":
    case "session_ended":
    case "turn_input_required":
    case "usage":
    case "rate_limit":
    case "approval_required":
    case "approval_auto_approved":
    case "tool_input_auto_answered":
    case "workspace_prepared":
    case "fs_write":
    case "process_exit":
    case "stderr":
    case "malformed":
    case "unknown":
      return true;

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Main trace file parser
// ---------------------------------------------------------------------------

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
    const msg = raw.message;

    // Fast path: use pre-parsed canonical event when available
    if (
      raw.canonicalEvent &&
      typeof raw.canonicalEvent === "object" &&
      "kind" in raw.canonicalEvent
    ) {
      const ce = raw.canonicalEvent as AgentEvent;
      if (handleCanonicalEvent(ce, ts, events, pendingToolCalls, turnStartedRecords, turnIndex)) {
        if (ce.kind === "turn_started") turnIndex++;
        continue;
      }
    }

    switch (raw.type) {
      case "agent_thought": {
        // Try canonical parse for ACP messages
        const canonical = tryCanonicalParse(msg, ts);
        if (canonical) {
          const display = canonicalEventToDisplay(canonical);
          if (display && display.kind === "thought" && display.text.trim()) {
            events.push(display);
            break;
          }
        }
        // Fallback: extract text directly
        const text =
          typeof msg === "string"
            ? msg
            : (extractAcpText(msg) ??
              (typeof msg === "object" && msg !== null
                ? (((msg as Record<string, unknown>).text as string) ?? "")
                : ""));
        if (text && text.trim()) events.push({ kind: "thought", text, timestamp: ts });
        break;
      }

      case "assistant_message": {
        const canonical = tryCanonicalParse(msg, ts);
        if (canonical) {
          const display = canonicalEventToDisplay(canonical);
          if (display && display.kind === "message" && display.text.trim()) {
            events.push(display);
            break;
          }
        }
        const text =
          typeof msg === "string"
            ? msg
            : (extractAcpText(msg) ??
              (typeof msg === "object" && msg !== null
                ? (((msg as Record<string, unknown>).text as string) ?? "")
                : ""));
        if (text && text.trim()) events.push({ kind: "message", text, timestamp: ts });
        break;
      }

      case "user_message": {
        const canonical = tryCanonicalParse(msg, ts);
        if (canonical) {
          const display = canonicalEventToDisplay(canonical);
          if (display && display.kind === "message" && display.text) {
            events.push(display);
            break;
          }
        }
        const text =
          typeof msg === "string"
            ? msg
            : (extractAcpText(msg) ??
              (typeof msg === "object" && msg !== null
                ? (((msg as Record<string, unknown>).text as string) ?? "")
                : ""));
        if (text) events.push({ kind: "message", text, timestamp: ts });
        break;
      }

      case "tool_use_requested": {
        // Try canonical ACP parse
        const canonical = tryCanonicalParse(msg, ts);
        if (canonical && canonical.kind === "tool_use_requested") {
          const toolCall: ToolCallDisplayEvent = {
            kind: "tool_call",
            category: canonical.category,
            toolName: canonical.toolName,
            input: canonical.input,
            output: null,
            isError: false,
            durationMs: null,
            nestedEvents: [],
            timestamp: ts,
          };
          pendingToolCalls.set(canonical.toolCallId, {
            event: toolCall,
            toolUseId: canonical.toolCallId,
            startTs: ts,
          });
          break;
        }

        // Fallback: direct extraction from message payload
        const payload =
          typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : {};

        // Try extracting ACP tool call info via canonical parser
        const acpCanonical = isAcpMessage(msg) ? parseAcpSessionUpdate(msg, ts) : null;
        if (acpCanonical && acpCanonical.kind === "tool_use_requested") {
          const toolCall: ToolCallDisplayEvent = {
            kind: "tool_call",
            category: acpCanonical.category,
            toolName: acpCanonical.toolName,
            input: acpCanonical.input,
            output: null,
            isError: false,
            durationMs: null,
            nestedEvents: [],
            timestamp: ts,
          };
          pendingToolCalls.set(acpCanonical.toolCallId, {
            event: toolCall,
            toolUseId: acpCanonical.toolCallId,
            startTs: ts,
          });
          break;
        }

        const toolName = (payload.name as string) ?? (payload.toolName as string) ?? "unknown";
        const toolUseId =
          (payload.id as string) ??
          (payload.toolUseId as string) ??
          `tool-${Date.now()}-${Math.random()}`;
        const input = (payload.input as Record<string, unknown>) ?? {};

        const toolCall: ToolCallDisplayEvent = {
          kind: "tool_call",
          category: detectToolCategory(toolName),
          toolName,
          input,
          output: null,
          isError: false,
          durationMs: null,
          nestedEvents: [],
          timestamp: ts,
        };
        pendingToolCalls.set(toolUseId, { event: toolCall, toolUseId, startTs: ts });
        break;
      }

      case "tool_call_update": {
        // Try canonical parse for ACP tool_call_update
        const canonical = tryCanonicalParse(msg, ts);
        if (canonical && canonical.kind === "tool_call_update") {
          const pending = pendingToolCalls.get(canonical.toolCallId);
          if (
            pending &&
            canonical.partialOutput !== null &&
            canonical.partialOutput !== undefined
          ) {
            if (typeof pending.event.output === "string") {
              pending.event.output = pending.event.output + canonical.partialOutput;
            } else {
              pending.event.output = canonical.partialOutput;
            }
          }
          break;
        }

        // Fallback: direct extraction
        const payload =
          typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : {};
        const acpUpdate = (payload.update as Record<string, unknown>) ?? undefined;
        const toolUseId =
          (acpUpdate?.toolCallId as string) ??
          (payload.id as string) ??
          (payload.toolUseId as string) ??
          "";
        const pending = pendingToolCalls.get(toolUseId);
        if (pending) {
          const partialOutput = (payload.output as string | null) ?? null;
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
        const payload =
          typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : {};

        // Try canonical ACP parse for tool_call_update with completed/failed status
        const canonical = tryCanonicalParse(msg, ts);
        if (
          canonical &&
          (canonical.kind === "tool_result" || canonical.kind === "tool_call_failed")
        ) {
          const toolCallId = canonical.toolCallId;
          const pendingAcp = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
          if (pendingAcp) {
            pendingToolCalls.delete(toolCallId);
            const toolCall = pendingAcp.event;
            if (canonical.kind === "tool_result" && canonical.output !== null) {
              toolCall.output = canonical.output;
            } else if (canonical.kind === "tool_call_failed") {
              toolCall.output = canonical.error;
            }
            toolCall.isError =
              canonical.kind === "tool_call_failed" || raw.type === "tool_call_failed";
            const startMs = new Date(pendingAcp.startTs).getTime();
            const endMs = new Date(ts).getTime();
            toolCall.durationMs =
              Number.isNaN(startMs) || Number.isNaN(endMs) ? null : endMs - startMs;
            events.push(toolCall);
          } else {
            // No pending tool call; emit from canonical event directly
            const display = canonicalEventToDisplay(canonical);
            if (display) {
              events.push(display);
            }
          }
          break;
        }

        // Handle Codex request/result format
        const request = payload.request as Record<string, unknown> | undefined;
        const result = payload.result as Record<string, unknown> | undefined;
        if (request && typeof request === "object") {
          const params = request.params as Record<string, unknown> | undefined;
          const toolName = (params?.tool as string) ?? "unknown";
          const callId = (params?.callId as string) ?? "";
          const input = (params?.arguments as Record<string, unknown>) ?? {};
          const output =
            (result?.output as string | null) ??
            ((result?.contentItems as Array<Record<string, unknown>> | undefined)?.[0]?.text as
              | string
              | null) ??
            null;
          const isError = raw.type === "tool_call_failed" || (result?.success as boolean) === false;

          // Try to match against a pending tool call by callId
          const pendingCodex = callId ? pendingToolCalls.get(callId) : undefined;
          if (pendingCodex) {
            pendingToolCalls.delete(callId);
            const toolCall = pendingCodex.event;
            if (output !== null) {
              toolCall.output = output;
            }
            toolCall.isError = isError;
            const startMs = new Date(pendingCodex.startTs).getTime();
            const endMs = new Date(ts).getTime();
            toolCall.durationMs =
              Number.isNaN(startMs) || Number.isNaN(endMs) ? null : endMs - startMs;
            events.push(toolCall);
          } else {
            events.push({
              kind: "tool_call",
              category: detectToolCategory(toolName),
              toolName,
              input,
              output,
              isError,
              durationMs: null,
              nestedEvents: [],
              timestamp: ts,
            });
          }
          break;
        }

        // Original handling for Claude format
        const toolUseId = (payload.id as string) ?? (payload.toolUseId as string) ?? "";
        const pending = pendingToolCalls.get(toolUseId);

        if (pending) {
          pendingToolCalls.delete(toolUseId);
          const toolCall = pending.event;
          // Only overwrite accumulated partial output if the result provides explicit output
          const resultOutput =
            (payload.output as string | unknown[] | null) ??
            (payload.content as string | unknown[] | null) ??
            null;
          if (resultOutput !== null) {
            toolCall.output = resultOutput;
          }
          toolCall.isError =
            raw.type === "tool_call_failed" || (payload.is_error as boolean) === true;
          const startMs = new Date(pending.startTs).getTime();
          const endMs = new Date(ts).getTime();
          toolCall.durationMs =
            Number.isNaN(startMs) || Number.isNaN(endMs) ? null : endMs - startMs;
          events.push(toolCall);
        } else {
          // No pending tool call found; emit as standalone
          const toolName = (payload.name as string) ?? (payload.toolName as string) ?? "unknown";
          events.push({
            kind: "tool_call",
            category: detectToolCategory(toolName),
            toolName,
            input: {},
            output:
              (payload.output as string | unknown[] | null) ??
              (payload.content as string | unknown[] | null) ??
              null,
            isError: raw.type === "tool_call_failed" || (payload.is_error as boolean) === true,
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
        // Try to compute duration from the most recent unconsumed turn_started
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
        // Mark the most recent unconsumed turn_started as consumed
        for (let i = turnStartedRecords.length - 1; i >= 0; i--) {
          const record = turnStartedRecords[i];
          if (record !== undefined && !record.consumed) {
            record.consumed = true;
            break;
          }
        }
        events.push({
          kind: "turn_failed",
          text: `Turn ${raw.type}: ${typeof msg === "string" ? msg : JSON.stringify(msg ?? "")}`,
          timestamp: ts,
        });
        break;
      }

      case "notification": {
        if (typeof msg !== "object" || msg === null) break;
        const method = (msg as Record<string, unknown>).method as string | undefined;
        const params = (msg as Record<string, unknown>).params as
          | Record<string, unknown>
          | undefined;
        if (!method || !params) break;

        // Delegate to canonical Codex notification parser
        const canonical = parseCodexNotification(method, params, ts);
        if (canonical) {
          // Handle turn lifecycle from notification - needs orchestration state
          if (canonical.kind === "turn_started") {
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
            break;
          }

          if (canonical.kind === "turn_completed") {
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
            const display = canonicalEventToDisplay(canonical);
            if (display && display.kind === "turn_completed") {
              display.durationMs = durationMs;
              events.push(display);
            } else {
              events.push({ kind: "turn_completed", usage: null, durationMs, timestamp: ts });
            }
            break;
          }

          if (canonical.kind === "turn_failed") {
            for (let i = turnStartedRecords.length - 1; i >= 0; i--) {
              const record = turnStartedRecords[i];
              if (record !== undefined && !record.consumed) {
                record.consumed = true;
                break;
              }
            }
          }

          // For tool results from item/completed, handle pending tool call resolution
          if (canonical.kind === "tool_result" || canonical.kind === "tool_call_failed") {
            const toolCallId = canonical.toolCallId;
            const pendingTool = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
            if (pendingTool) {
              pendingToolCalls.delete(toolCallId);
              const toolCall = pendingTool.event;
              if (canonical.kind === "tool_result" && canonical.output !== null) {
                toolCall.output = canonical.output;
              } else if (canonical.kind === "tool_call_failed") {
                toolCall.output = canonical.error;
              }
              toolCall.isError = canonical.kind === "tool_call_failed";
              const startMs = new Date(pendingTool.startTs).getTime();
              const endMs = new Date(ts).getTime();
              toolCall.durationMs =
                Number.isNaN(startMs) || Number.isNaN(endMs) ? null : endMs - startMs;
              events.push(toolCall);
              break;
            }
          }

          // For tool_use_requested from item/started, add to pending
          if (canonical.kind === "tool_use_requested") {
            const toolCall: ToolCallDisplayEvent = {
              kind: "tool_call",
              category: canonical.category,
              toolName: canonical.toolName,
              input: canonical.input,
              output: null,
              isError: false,
              durationMs: null,
              nestedEvents: [],
              timestamp: ts,
            };
            pendingToolCalls.set(canonical.toolCallId, {
              event: toolCall,
              toolUseId: canonical.toolCallId,
              startTs: ts,
            });
            break;
          }

          // For thought/message events, validate the canonical output does not contain
          // serialization artifacts (the canonical parser may not handle all
          // summary/content array-of-objects variants).
          if (canonical.kind === "thought" || canonical.kind === "assistant_message") {
            const text = canonical.text;
            if (text && !text.includes("[object Object]")) {
              const display = canonicalEventToDisplay(canonical);
              if (display) {
                events.push(display);
                break;
              }
            }
            // Fallback to local item/completed parsing for reasoning
            if (method === "item/completed") {
              const fallbackDisplay = parseItemCompletedLocal(params, ts);
              if (fallbackDisplay) {
                events.push(fallbackDisplay);
              }
            }
            break;
          }

          // For all other canonical events, convert directly
          const display = canonicalEventToDisplay(canonical);
          if (display) {
            events.push(display);
          }
          break;
        }

        // Fallback: try local item/completed parser for unhandled notification methods
        if (method === "item/completed") {
          const fallbackDisplay = parseItemCompletedLocal(params, ts);
          if (fallbackDisplay) {
            events.push(fallbackDisplay);
          }
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

  return mergeConsecutiveTextEvents(events);
}

/**
 * Local fallback parser for item/completed notifications.
 * Handles the array-of-objects format for summary/content fields where each
 * element is an object with a `.text` property (e.g., {type: "summary_text", text: "..."}).
 * This covers cases where the canonical parser may not handle all variants.
 */
function parseItemCompletedLocal(params: Record<string, unknown>, ts: string): DisplayEvent | null {
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

function mergeConsecutiveTextEvents(events: DisplayEvent[]): DisplayEvent[] {
  if (events.length === 0) return events;
  const merged: DisplayEvent[] = [];

  for (const event of events) {
    if (event.kind !== "thought" && event.kind !== "message") {
      merged.push(event);
      continue;
    }
    if (!event.text.trim()) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === event.kind) {
      (prev as { text: string }).text += event.text;
    } else {
      merged.push({ ...event });
    }
  }

  return merged;
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
