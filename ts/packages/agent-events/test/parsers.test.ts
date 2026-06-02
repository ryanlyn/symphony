import { describe, it, expect } from "vitest";

import {
  parseCodexNotification,
  parseCodexItemCompleted,
  parseAcpSessionUpdate,
  parseAcpToolCallUpdate,
  detectToolCategory,
  TOOL_NAME_CATEGORIES,
} from "../src/index.js";

// =============================================================================
// Codex parser tests
// =============================================================================

describe("parseCodexNotification", () => {
  describe("reasoning items -> thought event", () => {
    it("parses a reasoning item with summary text", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        completedAtMs: 1717300000000,
        item: {
          type: "reasoning",
          id: "rs_abc123",
          summary: ["Analyzing the user request to determine the best approach"],
          content: [],
        },
      });

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("thought");
      expect(event!.source).toBe("codex");
      if (event!.kind === "thought") {
        expect(event!.text).toBe("Analyzing the user request to determine the best approach");
      }
    });

    it("parses a reasoning item with content fallback when summary is empty", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        item: {
          type: "reasoning",
          id: "rs_def456",
          summary: [],
          content: ["Deep internal reasoning about the problem"],
        },
      });

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("thought");
      if (event!.kind === "thought") {
        expect(event!.text).toBe("Deep internal reasoning about the problem");
      }
    });

    it("returns null for reasoning with empty summary and content", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        item: {
          type: "reasoning",
          id: "rs_empty",
          summary: [],
          content: [],
        },
      });

      expect(event).toBeNull();
    });
  });

  describe("agentMessage items -> assistant_message event", () => {
    it("parses an agentMessage item into an assistant_message event", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        completedAtMs: 1717300001000,
        item: {
          type: "agentMessage",
          id: "msg_agent_1",
          text: "I have completed the requested changes to your codebase.",
        },
      });

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("assistant_message");
      expect(event!.source).toBe("codex");
      if (event!.kind === "assistant_message") {
        expect(event!.text).toBe("I have completed the requested changes to your codebase.");
      }
    });

    it("handles empty text in agentMessage", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        item: {
          type: "agentMessage",
          id: "msg_agent_2",
        },
      });

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("assistant_message");
      if (event!.kind === "assistant_message") {
        expect(event!.text).toBe("");
      }
    });
  });

  describe("userMessage items -> user_message event", () => {
    it("parses a userMessage item into a user_message event", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        completedAtMs: 1717300002000,
        item: {
          type: "userMessage",
          id: "msg_user_1",
          content: [{ text: "Please fix the bug in auth.ts" }],
        },
      });

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("user_message");
      expect(event!.source).toBe("codex");
      if (event!.kind === "user_message") {
        expect(event!.text).toBe("Please fix the bug in auth.ts");
      }
    });

    it("handles userMessage with multiple content blocks", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        item: {
          type: "userMessage",
          id: "msg_user_2",
          content: [{ text: "First paragraph." }, { text: "Second paragraph." }],
        },
      });

      expect(event).not.toBeNull();
      if (event!.kind === "user_message") {
        expect(event!.text).toBe("First paragraph.\nSecond paragraph.");
      }
    });
  });

  describe("commandExecution items -> tool_result event (bash_command)", () => {
    it("parses a successful command execution", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        completedAtMs: 1717300003000,
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "npm run build",
          exitCode: 0,
          aggregatedOutput: "Build successful\nDone in 2.3s",
          durationMs: 2300,
          status: "completed",
        },
      });

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("tool_result");
      expect(event!.source).toBe("codex");
      if (event!.kind === "tool_result") {
        expect(event!.toolName).toBe("command_execution");
        expect(event!.category).toBe("bash_command");
        expect(event!.isError).toBe(false);
        expect(event!.durationMs).toBe(2300);
        expect(event!.output).toBe("Build successful\nDone in 2.3s");
        expect((event!.input as Record<string, unknown>).command).toBe("npm run build");
      }
    });

    it("marks a non-zero exit code as an error", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        item: {
          type: "commandExecution",
          id: "cmd_2",
          command: "npm test",
          exitCode: 1,
          aggregatedOutput: "FAIL: 3 tests failed",
          durationMs: 5000,
          status: "failed",
        },
      });

      expect(event).not.toBeNull();
      if (event!.kind === "tool_result") {
        expect(event!.isError).toBe(true);
        expect(event!.category).toBe("bash_command");
        expect(event!.durationMs).toBe(5000);
      }
    });
  });

  describe("dynamicToolCall items -> tool_result event with correct category", () => {
    it("parses a dynamic tool call with object arguments", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        completedAtMs: 1717300004000,
        item: {
          type: "dynamicToolCall",
          id: "dyn_1",
          tool: "linear_graphql",
          arguments: { query: "{ viewer { id name } }" },
          contentItems: [{ text: '{"data":{"viewer":{"id":"usr_123","name":"Alice"}}}' }],
          status: "completed",
          durationMs: 450,
        },
      });

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("tool_result");
      if (event!.kind === "tool_result") {
        expect(event!.toolName).toBe("linear_graphql");
        expect(event!.category).toBe("unknown");
        expect(event!.isError).toBe(false);
        expect(event!.durationMs).toBe(450);
        expect(event!.output).toBe('{"data":{"viewer":{"id":"usr_123","name":"Alice"}}}');
        expect((event!.input as Record<string, unknown>).query).toBe("{ viewer { id name } }");
      }
    });

    it("parses a dynamic tool call with JSON string arguments", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        item: {
          type: "dynamicToolCall",
          id: "dyn_2",
          tool: "Bash",
          arguments: '{"command":"ls -la"}',
          contentItems: [{ text: "total 32\ndrwxr-xr-x 5 user staff" }],
          status: "completed",
          durationMs: 100,
        },
      });

      expect(event).not.toBeNull();
      if (event!.kind === "tool_result") {
        expect(event!.toolName).toBe("Bash");
        expect(event!.category).toBe("bash_command");
        expect((event!.input as Record<string, unknown>).command).toBe("ls -la");
      }
    });

    it("marks failed dynamic tool calls as errors", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        item: {
          type: "dynamicToolCall",
          id: "dyn_3",
          tool: "WebFetch",
          arguments: { url: "https://example.com" },
          contentItems: [],
          status: "failed",
          success: false,
        },
      });

      expect(event).not.toBeNull();
      if (event!.kind === "tool_result") {
        expect(event!.isError).toBe(true);
        expect(event!.category).toBe("web");
      }
    });
  });

  describe("rawResponseItem/completed with function_call -> tool_use_requested event", () => {
    it("parses a function_call item", () => {
      const event = parseCodexNotification("rawResponseItem/completed", {
        threadId: "thread-1",
        item: {
          type: "function_call",
          name: "Read",
          call_id: "call_abc123",
          arguments: '{"file_path":"/home/user/project/src/main.ts"}',
        },
      });

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("tool_use_requested");
      expect(event!.source).toBe("codex");
      if (event!.kind === "tool_use_requested") {
        expect(event!.toolName).toBe("Read");
        expect(event!.toolCallId).toBe("call_abc123");
        expect(event!.category).toBe("file_operation");
        expect((event!.input as Record<string, unknown>).file_path).toBe(
          "/home/user/project/src/main.ts",
        );
      }
    });

    it("handles function_call with invalid JSON arguments gracefully", () => {
      const event = parseCodexNotification("rawResponseItem/completed", {
        threadId: "thread-1",
        item: {
          type: "function_call",
          name: "Bash",
          call_id: "call_def456",
          arguments: "not-valid-json{{{",
        },
      });

      expect(event).not.toBeNull();
      if (event!.kind === "tool_use_requested") {
        expect(event!.toolName).toBe("Bash");
        expect(event!.category).toBe("bash_command");
        // Should return empty object for unparseable args
        expect(event!.input).toEqual({});
      }
    });
  });

  describe("turn/started -> turn_started event", () => {
    it("parses turn/started notification", () => {
      const event = parseCodexNotification(
        "turn/started",
        {
          threadId: "thread-1",
          turn: { id: "turn-42", status: "inProgress" },
        },
        "2026-01-15T10:00:00Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("turn_started");
      expect(event!.source).toBe("codex");
      expect(event!.timestamp).toBe("2026-01-15T10:00:00Z");
      if (event!.kind === "turn_started") {
        expect(event!.sessionId).toBe("thread-1");
      }
    });
  });

  describe("turn/completed with usage -> turn_completed event", () => {
    it("parses turn/completed with token usage", () => {
      const event = parseCodexNotification(
        "turn/completed",
        {
          threadId: "thread-1",
          turn: { id: "turn-42", status: "completed", durationMs: 12500 },
          usage: {
            inputTokens: 5000,
            outputTokens: 1200,
            totalTokens: 6200,
            cachedInputTokens: 3000,
          },
        },
        "2026-01-15T10:00:12Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("turn_completed");
      if (event!.kind === "turn_completed") {
        expect(event!.durationMs).toBe(12500);
        expect(event!.usage).not.toBeNull();
        expect(event!.usage!.inputTokens).toBe(5000);
        expect(event!.usage!.outputTokens).toBe(1200);
        expect(event!.usage!.totalTokens).toBe(6200);
        expect(event!.usage!.cacheReadTokens).toBe(3000);
      }
    });

    it("parses turn/completed without usage", () => {
      const event = parseCodexNotification(
        "turn/completed",
        {
          threadId: "thread-1",
          turn: { id: "turn-43", status: "completed", durationMs: 500 },
        },
        "2026-01-15T10:01:00Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("turn_completed");
      if (event!.kind === "turn_completed") {
        expect(event!.usage).toBeNull();
      }
    });
  });

  describe("turn/completed with failed status -> turn_failed event", () => {
    it("parses a failed turn", () => {
      const event = parseCodexNotification(
        "turn/completed",
        {
          threadId: "thread-1",
          turn: {
            id: "turn-44",
            status: "failed",
            error: { message: "Rate limit exceeded" },
            durationMs: 200,
          },
        },
        "2026-01-15T10:02:00Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("turn_failed");
      if (event!.kind === "turn_failed") {
        expect(event!.error).toBe("Rate limit exceeded");
        expect(event!.durationMs).toBe(200);
      }
    });
  });

  describe("unknown methods -> null", () => {
    it("returns null for unknown method", () => {
      const event = parseCodexNotification("some/unknown/method", {
        data: "whatever",
      });
      expect(event).toBeNull();
    });

    it("returns null for intentionally skipped methods", () => {
      expect(parseCodexNotification("hook/started", {})).toBeNull();
      expect(parseCodexNotification("hook/completed", {})).toBeNull();
      expect(parseCodexNotification("skills/changed", {})).toBeNull();
      expect(parseCodexNotification("warning", {})).toBeNull();
    });
  });

  describe("malformed input handling", () => {
    it("returns null for non-record params in item/completed", () => {
      const event = parseCodexNotification("item/completed", null);
      expect(event).toBeNull();
    });

    it("returns null for item/completed without item field", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
      });
      expect(event).toBeNull();
    });

    it("returns null for item/completed with non-object item", () => {
      const event = parseCodexNotification("item/completed", {
        threadId: "thread-1",
        item: "not-an-object",
      });
      expect(event).toBeNull();
    });

    it("does not throw for completely invalid input", () => {
      expect(() => parseCodexNotification("item/completed", undefined)).not.toThrow();
      expect(() => parseCodexNotification("item/completed", 42)).not.toThrow();
      expect(() => parseCodexNotification("item/completed", [])).not.toThrow();
    });

    it("handles item/started with missing item gracefully", () => {
      const event = parseCodexNotification("item/started", { threadId: "t1" });
      expect(event).toBeNull();
    });
  });
});

describe("parseCodexItemCompleted (direct call)", () => {
  it("returns null for null params", () => {
    expect(parseCodexItemCompleted(null)).toBeNull();
  });

  it("returns null for unknown item type", () => {
    const event = parseCodexItemCompleted({
      threadId: "t1",
      item: { type: "someNewType", id: "x" },
    });
    expect(event).toBeNull();
  });
});

// =============================================================================
// ACP parser tests
// =============================================================================

describe("parseAcpSessionUpdate", () => {
  describe("agent_message_chunk -> assistant_message_chunk event", () => {
    it("parses agent_message_chunk with text content", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Here is my analysis of the code:" },
          },
        },
        "2026-01-15T10:00:00Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("assistant_message_chunk");
      expect(event!.source).toBe("claude");
      if (event!.kind === "assistant_message_chunk") {
        expect(event!.text).toBe("Here is my analysis of the code:");
        expect(event!.sessionId).toBe("sess-abc");
      }
    });

    it("handles agent_message_chunk with empty content", () => {
      const event = parseAcpSessionUpdate({
        sessionId: "sess-abc",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
        },
      });

      expect(event).not.toBeNull();
      if (event!.kind === "assistant_message_chunk") {
        expect(event!.text).toBe("");
      }
    });
  });

  describe("user_message_chunk -> user_message_chunk event", () => {
    it("parses user_message_chunk with text content", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "Fix the authentication bug" },
          },
        },
        "2026-01-15T10:00:01Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("user_message_chunk");
      if (event!.kind === "user_message_chunk") {
        expect(event!.text).toBe("Fix the authentication bug");
      }
    });
  });

  describe("agent_thought_chunk -> thought_chunk event", () => {
    it("parses agent_thought_chunk with text content", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "I need to check the auth middleware first" },
          },
        },
        "2026-01-15T10:00:02Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("thought_chunk");
      expect(event!.source).toBe("claude");
      if (event!.kind === "thought_chunk") {
        expect(event!.text).toBe("I need to check the auth middleware first");
      }
    });
  });

  describe("tool_call with _meta.claudeCode.toolName -> tool_use_requested event", () => {
    it("extracts tool name from _meta.claudeCode.toolName", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc_001",
            kind: "execute",
            rawInput: { command: "git status" },
            _meta: {
              claudeCode: {
                toolName: "Bash",
              },
            },
          },
        },
        "2026-01-15T10:00:03Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("tool_use_requested");
      if (event!.kind === "tool_use_requested") {
        expect(event!.toolName).toBe("Bash");
        expect(event!.category).toBe("bash_command");
        expect(event!.toolCallId).toBe("tc_001");
        expect(event!.input).toEqual({ command: "git status" });
        expect(event!.toolKind).toBe("execute");
      }
    });
  });

  describe("tool_call without _meta but with title -> uses title as name", () => {
    it("falls back to title when _meta is not present", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc_002",
            title: "Read",
            kind: "read",
            rawInput: { file_path: "/home/user/project/main.ts" },
          },
        },
        "2026-01-15T10:00:04Z",
      );

      expect(event).not.toBeNull();
      if (event!.kind === "tool_use_requested") {
        expect(event!.toolName).toBe("Read");
        expect(event!.category).toBe("file_operation");
      }
    });

    it("falls back to kind when both _meta and title are missing", () => {
      const event = parseAcpSessionUpdate({
        sessionId: "sess-abc",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc_003",
          kind: "execute",
          rawInput: {},
        },
      });

      expect(event).not.toBeNull();
      if (event!.kind === "tool_use_requested") {
        expect(event!.toolName).toBe("execute");
      }
    });
  });

  describe("tool_call_update with status completed -> tool_result event", () => {
    it("parses completed tool_call_update with output", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc_001",
            status: "completed",
            _meta: { claudeCode: { toolName: "Bash" } },
            kind: "execute",
            rawInput: { command: "echo hello" },
            rawOutput: "hello\n",
          },
        },
        "2026-01-15T10:00:05Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("tool_result");
      if (event!.kind === "tool_result") {
        expect(event!.toolCallId).toBe("tc_001");
        expect(event!.toolName).toBe("Bash");
        expect(event!.category).toBe("bash_command");
        expect(event!.isError).toBe(false);
        expect(event!.output).toBe("hello\n");
        expect(event!.input).toEqual({ command: "echo hello" });
      }
    });

    it("parses completed tool_call_update with content array", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc_010",
            status: "completed",
            title: "Read",
            kind: "read",
            content: [{ type: "content", content: { text: "file contents here" } }],
          },
        },
        "2026-01-15T10:00:06Z",
      );

      expect(event).not.toBeNull();
      if (event!.kind === "tool_result") {
        expect(event!.toolName).toBe("Read");
        expect(event!.output).toBe("file contents here");
      }
    });
  });

  describe("tool_call_update with status failed -> tool_call_failed event", () => {
    it("parses failed tool_call_update", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc_004",
            status: "failed",
            _meta: { claudeCode: { toolName: "WebFetch" } },
            kind: "web",
            rawOutput: "Connection timeout after 30s",
          },
        },
        "2026-01-15T10:00:07Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("tool_call_failed");
      if (event!.kind === "tool_call_failed") {
        expect(event!.toolCallId).toBe("tc_004");
        expect(event!.toolName).toBe("WebFetch");
        expect(event!.category).toBe("web");
        expect(event!.error).toBe("Connection timeout after 30s");
      }
    });

    it("uses generic error message when no output is available", () => {
      const event = parseAcpSessionUpdate({
        sessionId: "sess-abc",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc_005",
          status: "failed",
          title: "Bash",
        },
      });

      expect(event).not.toBeNull();
      if (event!.kind === "tool_call_failed") {
        expect(event!.error).toBe("Tool call failed");
      }
    });
  });

  describe("tool_call_update with terminal content -> extracts terminal output", () => {
    it("extracts terminal output from content blocks", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc_006",
            status: "completed",
            title: "Bash",
            kind: "execute",
            content: [{ type: "terminal", output: "$ npm run build\n> tsc --build\nDone." }],
          },
        },
        "2026-01-15T10:00:08Z",
      );

      expect(event).not.toBeNull();
      if (event!.kind === "tool_result") {
        expect(event!.output).toBe("$ npm run build\n> tsc --build\nDone.");
      }
    });
  });

  describe("usage_update -> usage event", () => {
    it("parses usage_update with used and size fields", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "usage_update",
            used: 45000,
            size: 128000,
          },
        },
        "2026-01-15T10:00:09Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("usage");
      if (event!.kind === "usage") {
        expect(event!.usage.totalTokens).toBe(45000);
        expect(event!.usage.inputTokens).toBe(128000);
        expect(event!.totalUsed).toBe(45000);
      }
    });

    it("handles usage_update with only used field", () => {
      const event = parseAcpSessionUpdate({
        sessionId: "sess-abc",
        update: {
          sessionUpdate: "usage_update",
          used: 12000,
        },
      });

      expect(event).not.toBeNull();
      if (event!.kind === "usage") {
        expect(event!.usage.totalTokens).toBe(12000);
        expect(event!.totalUsed).toBe(12000);
      }
    });
  });

  describe("plan -> plan event", () => {
    it("parses plan update with entries", () => {
      const event = parseAcpSessionUpdate(
        {
          sessionId: "sess-abc",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "Read the source file", status: "completed" },
              { content: "Identify the bug", status: "in_progress" },
              { content: "Apply the fix", status: "pending", priority: "high" },
              { content: "Run tests", status: "pending" },
            ],
          },
        },
        "2026-01-15T10:00:10Z",
      );

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("plan");
      if (event!.kind === "plan") {
        expect(event!.entries).toHaveLength(4);
        expect(event!.entries[0]).toEqual({
          title: "Read the source file",
          status: "completed",
          priority: undefined,
        });
        expect(event!.entries[1]).toEqual({
          title: "Identify the bug",
          status: "in_progress",
          priority: undefined,
        });
        expect(event!.entries[2]).toEqual({
          title: "Apply the fix",
          status: "pending",
          priority: "high",
        });
      }
    });

    it("handles plan with no entries", () => {
      const event = parseAcpSessionUpdate({
        sessionId: "sess-abc",
        update: {
          sessionUpdate: "plan",
        },
      });

      expect(event).not.toBeNull();
      if (event!.kind === "plan") {
        expect(event!.entries).toEqual([]);
      }
    });
  });

  describe("unknown sessionUpdate -> unknown event", () => {
    it("returns unknown event for unrecognized sessionUpdate kind", () => {
      const event = parseAcpSessionUpdate({
        sessionId: "sess-abc",
        update: {
          sessionUpdate: "some_future_update_type",
          payload: { data: 123 },
        },
      });

      expect(event).not.toBeNull();
      expect(event!.kind).toBe("unknown");
      if (event!.kind === "unknown") {
        expect(event!.data).toBeDefined();
      }
    });
  });

  describe("malformed input handling", () => {
    it("returns null for null input", () => {
      expect(parseAcpSessionUpdate(null)).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(parseAcpSessionUpdate("not-an-object")).toBeNull();
      expect(parseAcpSessionUpdate(42)).toBeNull();
      expect(parseAcpSessionUpdate([])).toBeNull();
    });

    it("returns null when update field is missing", () => {
      expect(parseAcpSessionUpdate({ sessionId: "sess-1" })).toBeNull();
    });

    it("returns null when update is not an object", () => {
      expect(parseAcpSessionUpdate({ sessionId: "sess-1", update: "bad" })).toBeNull();
    });

    it("returns null when sessionUpdate field is missing from update", () => {
      expect(
        parseAcpSessionUpdate({
          sessionId: "sess-1",
          update: { someOtherField: "value" },
        }),
      ).toBeNull();
    });

    it("does not throw for completely invalid payloads", () => {
      expect(() => parseAcpSessionUpdate(undefined)).not.toThrow();
      expect(() => parseAcpSessionUpdate({})).not.toThrow();
      expect(() => parseAcpSessionUpdate({ update: null })).not.toThrow();
    });
  });
});

describe("parseAcpToolCallUpdate (direct call)", () => {
  it("returns null for null input", () => {
    expect(parseAcpToolCallUpdate(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseAcpToolCallUpdate("bad")).toBeNull();
  });

  it("parses in_progress status as tool_call_update", () => {
    const event = parseAcpToolCallUpdate(
      {
        toolCallId: "tc_100",
        status: "in_progress",
        _meta: { claudeCode: { toolName: "Bash" } },
        kind: "execute",
        content: [{ type: "terminal", output: "running..." }],
      },
      "2026-01-15T10:05:00Z",
      "sess-xyz",
    );

    expect(event).not.toBeNull();
    expect(event!.kind).toBe("tool_call_update");
    if (event!.kind === "tool_call_update") {
      expect(event!.toolCallId).toBe("tc_100");
      expect(event!.toolName).toBe("Bash");
      expect(event!.category).toBe("bash_command");
      expect(event!.status).toBe("in_progress");
      expect(event!.partialOutput).toBe("running...");
    }
  });

  it("parses pending status with no tool name as partial update", () => {
    const event = parseAcpToolCallUpdate({
      toolCallId: "tc_101",
      status: "pending",
    });

    expect(event).not.toBeNull();
    if (event!.kind === "tool_call_update") {
      expect(event!.toolName).toBeUndefined();
      expect(event!.category).toBeUndefined();
      expect(event!.status).toBe("pending");
    }
  });
});

// =============================================================================
// Tool category tests
// =============================================================================

describe("detectToolCategory", () => {
  describe("known tools map to correct categories", () => {
    it("Bash -> bash_command", () => {
      expect(detectToolCategory("Bash")).toBe("bash_command");
    });

    it("Read -> file_operation", () => {
      expect(detectToolCategory("Read")).toBe("file_operation");
    });

    it("Write -> file_operation", () => {
      expect(detectToolCategory("Write")).toBe("file_operation");
    });

    it("Edit -> file_operation", () => {
      expect(detectToolCategory("Edit")).toBe("file_operation");
    });

    it("NotebookEdit -> file_operation", () => {
      expect(detectToolCategory("NotebookEdit")).toBe("file_operation");
    });

    it("Agent -> agent", () => {
      expect(detectToolCategory("Agent")).toBe("agent");
    });

    it("WebFetch -> web", () => {
      expect(detectToolCategory("WebFetch")).toBe("web");
    });

    it("WebSearch -> web", () => {
      expect(detectToolCategory("WebSearch")).toBe("web");
    });

    it("Grep -> search", () => {
      expect(detectToolCategory("Grep")).toBe("search");
    });

    it("Glob -> search", () => {
      expect(detectToolCategory("Glob")).toBe("search");
    });

    it("ToolSearch -> search", () => {
      expect(detectToolCategory("ToolSearch")).toBe("search");
    });

    it("Skill -> skill", () => {
      expect(detectToolCategory("Skill")).toBe("skill");
    });

    it("Task -> plan_mode", () => {
      expect(detectToolCategory("Task")).toBe("plan_mode");
    });

    it("TaskCreate -> plan_mode", () => {
      expect(detectToolCategory("TaskCreate")).toBe("plan_mode");
    });

    it("TaskUpdate -> plan_mode", () => {
      expect(detectToolCategory("TaskUpdate")).toBe("plan_mode");
    });

    it("TaskGet -> plan_mode", () => {
      expect(detectToolCategory("TaskGet")).toBe("plan_mode");
    });

    it("TaskList -> plan_mode", () => {
      expect(detectToolCategory("TaskList")).toBe("plan_mode");
    });

    it("EnterWorktree -> plan_mode", () => {
      expect(detectToolCategory("EnterWorktree")).toBe("plan_mode");
    });

    it("ExitWorktree -> plan_mode", () => {
      expect(detectToolCategory("ExitWorktree")).toBe("plan_mode");
    });

    it("TodoWrite -> todo", () => {
      expect(detectToolCategory("TodoWrite")).toBe("todo");
    });

    it("TodoRead -> todo", () => {
      expect(detectToolCategory("TodoRead")).toBe("todo");
    });
  });

  describe("unknown tools map to unknown", () => {
    it("returns unknown for unrecognized tool names", () => {
      expect(detectToolCategory("linear_graphql")).toBe("unknown");
      expect(detectToolCategory("custom_mcp_tool")).toBe("unknown");
      expect(detectToolCategory("my_special_tool")).toBe("unknown");
      expect(detectToolCategory("")).toBe("unknown");
    });
  });

  describe("TOOL_NAME_CATEGORIES exhaustiveness", () => {
    it("all entries in TOOL_NAME_CATEGORIES are callable via detectToolCategory", () => {
      for (const [toolName, expectedCategory] of Object.entries(TOOL_NAME_CATEGORIES)) {
        expect(detectToolCategory(toolName)).toBe(expectedCategory);
      }
    });
  });
});
