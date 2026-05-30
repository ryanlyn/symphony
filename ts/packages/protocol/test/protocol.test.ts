import { describe, test } from "vitest";

import { assert } from "../../../test/assert.js";

import { SESSION_UPDATE_KINDS } from "@symphony/protocol";
import type {
  StopReason,
  SessionUpdate,
  SessionUpdateKind,
  UsageUpdate,
  TurnUpdate,
  TurnResult,
  UsageTotals,
  SymphonyMeta,
  SessionUpdateBase,
} from "@symphony/protocol";

describe("SESSION_UPDATE_KINDS", () => {
  test("contains exactly the expected set of kinds in the expected order", () => {
    // This is a snapshot-style assertion: if any kind is added, removed,
    // or reordered, this test will fail and force a conscious update.
    assert.deepEqual(
      [...SESSION_UPDATE_KINDS],
      [
        "usage_update",
        "session_started",
        "turn_started",
        "turn_completed",
        "turn_failed",
        "turn_cancelled",
        "tool_call",
        "tool_result",
        "notification",
      ],
    );
  });

  test("has exactly 9 members", () => {
    assert.equal(SESSION_UPDATE_KINDS.length, 9);
  });

  test("contains no duplicate entries", () => {
    const unique = new Set(SESSION_UPDATE_KINDS);
    assert.equal(unique.size, SESSION_UPDATE_KINDS.length);
  });

  test("every entry is a non-empty string", () => {
    for (const kind of SESSION_UPDATE_KINDS) {
      assert.equal(typeof kind, "string");
      assert.ok(kind.length > 0);
    }
  });

  test("is declared as a readonly array (as const)", () => {
    // Verify the array is a standard JS array (as const is compile-time only)
    assert.ok(Array.isArray(SESSION_UPDATE_KINDS));
    // Verify it has the expected structure -- a plain array with string entries
    assert.equal(typeof SESSION_UPDATE_KINDS[0], "string");
    assert.equal(typeof SESSION_UPDATE_KINDS[SESSION_UPDATE_KINDS.length - 1], "string");
  });

  test("SessionUpdateKind type is derivable from the runtime array", () => {
    // Verify that the runtime array can be used to validate a kind string
    // This tests the pattern used in real code: checking if a value is a valid kind.
    const validKind: string = "usage_update";
    const invalidKind: string = "nonexistent_kind";

    const isValidKind = (k: string): k is SessionUpdateKind =>
      (SESSION_UPDATE_KINDS as readonly string[]).includes(k);

    assert.ok(isValidKind(validKind));
    assert.equal(isValidKind(invalidKind), false);
  });

  test("can be used to exhaustively enumerate all SessionUpdateKinds", () => {
    // Build a Set from the runtime constant and verify membership of
    // every documented kind. This ensures the runtime array stays in sync
    // with the expected protocol contract.
    const kindSet = new Set<string>(SESSION_UPDATE_KINDS);

    // These are the kinds that TurnUpdate declares in its `kind` union
    const turnUpdateKinds = [
      "session_started",
      "turn_started",
      "turn_completed",
      "turn_failed",
      "turn_cancelled",
      "tool_call",
      "tool_result",
      "notification",
    ];
    for (const k of turnUpdateKinds) {
      assert.ok(kindSet.has(k));
    }

    // UsageUpdate's kind
    assert.ok(kindSet.has("usage_update"));

    // Verify these account for all entries (no extra kinds beyond these two groups)
    const allExpected = new Set([...turnUpdateKinds, "usage_update"]);
    assert.equal(allExpected.size, kindSet.size);
    for (const k of kindSet) {
      assert.ok(allExpected.has(k));
    }
  });
});

describe("SessionUpdate type structure", () => {
  test("UsageUpdate requires a usage field with Partial<UsageTotals>", () => {
    // Verify that a UsageUpdate with partial usage (not all fields) is valid
    const update: UsageUpdate = {
      kind: "usage_update",
      usage: { inputTokens: 42 },
    };
    // The usage field should carry through exactly what was provided
    assert.equal(update.usage.inputTokens, 42);
    assert.equal(update.usage.outputTokens, undefined);
    assert.equal(update.usage.totalTokens, undefined);
    assert.equal(update.usage.secondsRunning, undefined);
  });

  test("UsageUpdate with empty usage object is valid (all fields optional via Partial)", () => {
    const update: UsageUpdate = {
      kind: "usage_update",
      usage: {},
    };
    assert.deepEqual(update.usage, {});
  });

  test("SessionUpdateBase optional fields default to undefined when omitted", () => {
    const base: SessionUpdateBase = { kind: "notification" };
    assert.equal(base.sessionId, undefined);
    assert.equal(base.agentKind, undefined);
    assert.equal(base.message, undefined);
    assert.equal(base.at, undefined);
    assert.equal(base._meta, undefined);
  });

  test("SessionUpdateBase carries all optional metadata fields correctly", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const base: SessionUpdateBase = {
      kind: "turn_started",
      sessionId: "sess-abc",
      agentKind: "code-agent",
      message: { text: "hello" },
      at: now,
      _meta: { executorPid: "pid-1", usage: { inputTokens: 5 } },
    };
    assert.equal(base.sessionId, "sess-abc");
    assert.equal(base.agentKind, "code-agent");
    assert.deepEqual(base.message, { text: "hello" });
    assert.equal(base.at, now);
    assert.equal(base._meta!.executorPid, "pid-1");
    assert.deepEqual(base._meta!.usage, { inputTokens: 5 });
  });

  test("TurnUpdate kind field only accepts non-usage_update kinds from SESSION_UPDATE_KINDS", () => {
    // Verify the TurnUpdate interface's kind is assignable from all non-usage kinds
    const turnKinds: TurnUpdate["kind"][] = [
      "session_started",
      "turn_started",
      "turn_completed",
      "turn_failed",
      "turn_cancelled",
      "tool_call",
      "tool_result",
      "notification",
    ];
    // Ensure all these are in SESSION_UPDATE_KINDS (runtime consistency)
    for (const k of turnKinds) {
      assert.ok(
        (SESSION_UPDATE_KINDS as readonly string[]).includes(k),
      );
    }
    // Verify usage_update is NOT one of TurnUpdate's kinds (it belongs to UsageUpdate)
    // This is enforced at compile time, but we verify the protocol constant segregation
    const usageKind = "usage_update";
    assert.ok(!turnKinds.includes(usageKind as TurnUpdate["kind"]));
  });

  test("SessionUpdate union accepts both UsageUpdate and TurnUpdate", () => {
    const updates: SessionUpdate[] = [
      { kind: "usage_update", usage: { totalTokens: 100 } },
      { kind: "turn_started", message: "starting" },
      { kind: "turn_completed" },
      { kind: "turn_failed", message: "timeout" },
      { kind: "notification", message: "info" },
    ];
    // Verify all are valid by checking they have kind fields that exist in SESSION_UPDATE_KINDS
    for (const u of updates) {
      assert.ok(
        (SESSION_UPDATE_KINDS as readonly string[]).includes(u.kind),
      );
    }
    assert.equal(updates.length, 5);
  });
});

describe("TurnResult", () => {
  test("requires stopReason and sessionId fields", () => {
    const result: TurnResult = {
      stopReason: "end_turn",
      sessionId: "sess-xyz",
    };
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.sessionId, "sess-xyz");
    assert.equal(result._meta, undefined);
  });

  test("_meta.usage carries Partial<UsageTotals> allowing any subset of fields", () => {
    const result: TurnResult = {
      stopReason: "max_tokens",
      sessionId: "sess-1",
      _meta: {
        usage: { inputTokens: 200, outputTokens: 100 },
      },
    };
    // Verify partial usage -- totalTokens and secondsRunning are omitted
    assert.equal(result._meta!.usage!.inputTokens, 200);
    assert.equal(result._meta!.usage!.outputTokens, 100);
    assert.equal(result._meta!.usage!.totalTokens, undefined);
    assert.equal(result._meta!.usage!.secondsRunning, undefined);
  });

  test("_meta fields are all independently optional", () => {
    // SymphonyMeta has executorPid, rateLimits, usage -- all optional
    const withPidOnly: TurnResult = {
      stopReason: "cancelled",
      sessionId: "sess-2",
      _meta: { executorPid: "proc-42" },
    };
    assert.equal(withPidOnly._meta!.executorPid, "proc-42");
    assert.equal(withPidOnly._meta!.usage, undefined);
    assert.equal(withPidOnly._meta!.rateLimits, undefined);

    // executorPid can be null per the type definition
    const withNullPid: TurnResult = {
      stopReason: "refusal",
      sessionId: "sess-3",
      _meta: { executorPid: null },
    };
    assert.equal(withNullPid._meta!.executorPid, null);
  });

  test("stopReason accepts all defined StopReason values", () => {
    const stopReasons: StopReason[] = [
      "end_turn",
      "max_tokens",
      "max_turn_requests",
      "refusal",
      "cancelled",
    ];
    // Verify all are assignable and produce valid TurnResult objects
    const results: TurnResult[] = stopReasons.map((reason, i) => ({
      stopReason: reason,
      sessionId: `sess-${i}`,
    }));
    assert.equal(results.length, 5);
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].stopReason, stopReasons[i]);
      assert.equal(results[i].sessionId, `sess-${i}`);
    }
  });
});

describe("SymphonyMeta", () => {
  test("usage field accepts empty partial", () => {
    const meta: SymphonyMeta = { usage: {} };
    assert.deepEqual(meta.usage, {});
    assert.equal(meta.executorPid, undefined);
  });

  test("rateLimits field accepts arbitrary data", () => {
    const meta: SymphonyMeta = {
      rateLimits: { requestsPerMinute: 60, tokensPerMinute: 100000 },
    };
    assert.deepEqual(meta.rateLimits, {
      requestsPerMinute: 60,
      tokensPerMinute: 100000,
    });
  });
});

describe("UsageTotals", () => {
  test("all fields are numeric and independently settable", () => {
    const usage: UsageTotals = {
      inputTokens: 1500,
      outputTokens: 750,
      totalTokens: 2250,
      secondsRunning: 12,
    };
    // Verify totalTokens is not auto-computed -- it is a plain data field
    // Users can set it to any value independent of input + output
    assert.equal(usage.totalTokens, 2250);
    assert.equal(usage.inputTokens + usage.outputTokens, 2250);

    // Verify that totalTokens does NOT need to equal input + output
    const inconsistent: UsageTotals = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 999, // deliberately not sum of input + output
      secondsRunning: 1,
    };
    assert.equal(inconsistent.totalTokens, 999);
    assert.notEqual(
      inconsistent.totalTokens,
      inconsistent.inputTokens + inconsistent.outputTokens,
    );
  });

  test("Partial<UsageTotals> allows any subset of fields", () => {
    const partial: Partial<UsageTotals> = { secondsRunning: 7 };
    assert.equal(partial.secondsRunning, 7);
    assert.equal(partial.inputTokens, undefined);
    assert.equal(partial.outputTokens, undefined);
    assert.equal(partial.totalTokens, undefined);
  });
});
