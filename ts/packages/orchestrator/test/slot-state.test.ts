import { test } from "vitest";
import type { RetryEntry, RunningEntry } from "@symphony/domain";

import { assert } from "../../../test/assert.js";
import { transitionSlot, initialSlotState, isTerminalOrEmptyPhase } from "../src/slot-state.js";
import type { SlotState } from "../src/slot-state.js";

function makeRunningEntry(overrides: Partial<RunningEntry> = {}): RunningEntry {
  return {
    issue: {
      id: "issue-1",
      identifier: "MT-1",
      title: "Test",
      state: "Todo",
      labels: [],
      blockers: [],
    },
    identifier: "MT-1",
    slotIndex: 0,
    ensembleSize: 1,
    agentKind: "codex",
    workerHost: null,
    workspacePath: null,
    sessionId: null,
    resumeId: null,
    executorPid: null,
    turnCount: 0,
    startedAt: new Date("2025-01-01T00:00:00Z"),
    lastAgentEvent: null,
    lastAgentTimestamp: null,
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    lastReportedInputTokens: 0,
    lastReportedOutputTokens: 0,
    lastReportedTotalTokens: 0,
    retryAttempt: null,
    ...overrides,
  };
}

function makeRetryEntry(overrides: Partial<RetryEntry> = {}): RetryEntry {
  return {
    issueId: "issue-1",
    identifier: "MT-1",
    attempt: 1,
    dueAt: new Date("2025-01-01T01:00:00Z"),
    error: "agent exited",
    slotIndex: 0,
    ...overrides,
  };
}

// --- initialSlotState ---

test("initialSlotState returns idle", () => {
  assert.deepEqual(initialSlotState(), { phase: "idle" });
});

// --- idle phase transitions ---

test("idle + CLAIM -> running", () => {
  const state = initialSlotState();
  const entry = makeRunningEntry();
  const next = transitionSlot(state, { type: "CLAIM", entry });
  assert.equal(next.phase, "running");
  if (next.phase === "running") {
    assert.equal(next.entry, entry);
  }
});

test("idle + CLEANUP -> completed", () => {
  const state = initialSlotState();
  const next = transitionSlot(state, { type: "CLEANUP" });
  assert.deepEqual(next, { phase: "completed" });
});

test("idle + irrelevant events are no-ops", () => {
  const state = initialSlotState();
  const now = new Date("2025-01-01T00:00:00Z");
  assert.equal(
    transitionSlot(state, { type: "UPDATE", update: { type: "turn_completed" }, now }),
    state,
  );
  assert.equal(
    transitionSlot(state, { type: "FINISH_WITH_RETRY", retryEntry: makeRetryEntry() }),
    state,
  );
  assert.equal(transitionSlot(state, { type: "FINISH_NO_RETRY" }), state);
});

// --- running phase transitions ---

test("running + UPDATE returns a new state with updated entry fields", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const now = new Date("2025-01-01T00:05:00Z");
  const next = transitionSlot(state, {
    type: "UPDATE",
    update: {
      type: "turn_completed",
      sessionId: "s1",
      resumeId: "r1",
      executorPid: "123",
      workspacePath: "/tmp/ws",
    },
    now,
  });
  // Returns a new state (pure transition)
  assert.notEqual(next, state);
  assert.equal(next.phase, "running");
  if (next.phase === "running") {
    assert.notEqual(next.entry, entry); // new entry object
    assert.equal(next.entry.lastAgentEvent, "turn_completed");
    assert.equal(next.entry.sessionId, "s1");
    assert.equal(next.entry.resumeId, "r1");
    assert.equal(next.entry.executorPid, "123");
    assert.equal(next.entry.workspacePath, "/tmp/ws");
    assert.equal(next.entry.turnCount, 1);
    assert.equal(next.entry.lastAgentTimestamp?.getTime(), now.getTime());
  }
  // Original entry is not mutated
  assert.equal(entry.lastAgentEvent, null);
  assert.equal(entry.sessionId, null);
  assert.equal(entry.turnCount, 0);
});

test("running + UPDATE with turn_completed increments turnCount", () => {
  const entry = makeRunningEntry({ turnCount: 3 });
  const state: SlotState = { phase: "running", entry };
  const now = new Date("2025-01-01T00:05:00Z");
  const next = transitionSlot(state, { type: "UPDATE", update: { type: "turn_completed" }, now });
  if (next.phase === "running") {
    assert.equal(next.entry.turnCount, 4);
  }
  // Original not mutated
  assert.equal(entry.turnCount, 3);
});

test("running + UPDATE with non-turn event does not increment turnCount", () => {
  const entry = makeRunningEntry({ turnCount: 2 });
  const state: SlotState = { phase: "running", entry };
  const now = new Date("2025-01-01T00:05:00Z");
  const next = transitionSlot(state, { type: "UPDATE", update: { type: "usage" }, now });
  if (next.phase === "running") {
    assert.equal(next.entry.turnCount, 2);
  }
});

test("running + REFRESH_ISSUE -> running with updated issue", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const updatedIssue = {
    id: "issue-1",
    identifier: "MT-1",
    title: "Updated Title",
    state: "InProgress",
    labels: ["urgent"],
    blockers: [],
  };
  const next = transitionSlot(state, { type: "REFRESH_ISSUE", issue: updatedIssue });
  // Returns a new state (pure transition)
  assert.notEqual(next, state);
  assert.equal(next.phase, "running");
  if (next.phase === "running") {
    assert.notEqual(next.entry, entry); // new entry object
    assert.deepEqual(next.entry.issue, updatedIssue);
    // Other fields remain unchanged
    assert.equal(next.entry.slotIndex, 0);
    assert.equal(next.entry.turnCount, 0);
  }
  // Original entry is not mutated
  assert.equal(entry.issue.title, "Test");
  assert.equal(entry.issue.state, "Todo");
});

test("idle + REFRESH_ISSUE is a no-op", () => {
  const state = initialSlotState();
  const issue = { id: "issue-1", identifier: "MT-1", title: "X", state: "Todo", labels: [], blockers: [] };
  const next = transitionSlot(state, { type: "REFRESH_ISSUE", issue });
  assert.equal(next, state);
});

test("retrying + REFRESH_ISSUE is a no-op", () => {
  const state: SlotState = { phase: "retrying", retry: makeRetryEntry() };
  const issue = { id: "issue-1", identifier: "MT-1", title: "X", state: "Todo", labels: [], blockers: [] };
  const next = transitionSlot(state, { type: "REFRESH_ISSUE", issue });
  assert.equal(next, state);
});

test("completed + REFRESH_ISSUE is a no-op", () => {
  const state: SlotState = { phase: "completed" };
  const issue = { id: "issue-1", identifier: "MT-1", title: "X", state: "Todo", labels: [], blockers: [] };
  const next = transitionSlot(state, { type: "REFRESH_ISSUE", issue });
  assert.equal(next, state);
});

test("running + FINISH_WITH_RETRY -> retrying", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const retryEntry = makeRetryEntry();
  const next = transitionSlot(state, { type: "FINISH_WITH_RETRY", retryEntry });
  assert.equal(next.phase, "retrying");
  if (next.phase === "retrying") {
    assert.equal(next.retry, retryEntry);
  }
});

test("running + FINISH_NO_RETRY -> idle", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const next = transitionSlot(state, { type: "FINISH_NO_RETRY" });
  assert.deepEqual(next, { phase: "idle" });
});

test("running + CLEANUP -> completed", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const next = transitionSlot(state, { type: "CLEANUP" });
  assert.deepEqual(next, { phase: "completed" });
});

test("running + CLAIM is a no-op (already running)", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const newEntry = makeRunningEntry({ slotIndex: 1 });
  const next = transitionSlot(state, { type: "CLAIM", entry: newEntry });
  assert.equal(next, state);
});

// --- retrying phase transitions ---

test("retrying + CLEANUP -> completed", () => {
  const state: SlotState = { phase: "retrying", retry: makeRetryEntry() };
  const next = transitionSlot(state, { type: "CLEANUP" });
  assert.deepEqual(next, { phase: "completed" });
});

test("retrying + CLAIM -> running (direct reclaim on retry)", () => {
  const state: SlotState = { phase: "retrying", retry: makeRetryEntry() };
  const entry = makeRunningEntry();
  const next = transitionSlot(state, { type: "CLAIM", entry });
  assert.equal(next.phase, "running");
  if (next.phase === "running") {
    assert.equal(next.entry, entry);
  }
});

test("retrying + irrelevant events are no-ops", () => {
  const state: SlotState = { phase: "retrying", retry: makeRetryEntry() };
  const now = new Date("2025-01-01T00:00:00Z");
  assert.equal(
    transitionSlot(state, { type: "UPDATE", update: { type: "turn_completed" }, now }),
    state,
  );
  assert.equal(
    transitionSlot(state, { type: "FINISH_WITH_RETRY", retryEntry: makeRetryEntry() }),
    state,
  );
  assert.equal(transitionSlot(state, { type: "FINISH_NO_RETRY" }), state);
});

// --- completed phase (terminal) ---

test("completed absorbs all events", () => {
  const state: SlotState = { phase: "completed" };
  const now = new Date("2025-01-01T00:00:00Z");
  assert.equal(transitionSlot(state, { type: "CLAIM", entry: makeRunningEntry() }), state);
  assert.equal(
    transitionSlot(state, { type: "UPDATE", update: { type: "turn_completed" }, now }),
    state,
  );
  assert.equal(
    transitionSlot(state, { type: "FINISH_WITH_RETRY", retryEntry: makeRetryEntry() }),
    state,
  );
  assert.equal(transitionSlot(state, { type: "FINISH_NO_RETRY" }), state);
  assert.equal(transitionSlot(state, { type: "CLEANUP" }), state);
});

// --- Multi-step lifecycle tests ---

test("full lifecycle: idle -> running -> retrying -> running -> idle", () => {
  let state: SlotState = initialSlotState();
  assert.equal(state.phase, "idle");

  // Claim: idle -> running
  const entry1 = makeRunningEntry();
  state = transitionSlot(state, { type: "CLAIM", entry: entry1 });
  assert.equal(state.phase, "running");
  if (state.phase === "running") assert.equal(state.entry, entry1);

  // Apply some updates while running (returns new state with new entry)
  const now = new Date("2025-01-01T00:05:00Z");
  state = transitionSlot(state, {
    type: "UPDATE",
    update: { type: "turn_completed", sessionId: "s1" },
    now,
  });
  assert.equal(state.phase, "running");
  if (state.phase === "running") {
    assert.equal(state.entry.turnCount, 1);
    assert.equal(state.entry.sessionId, "s1");
  }

  // Finish with retry: running -> retrying
  const retryEntry = makeRetryEntry({ attempt: 1 });
  state = transitionSlot(state, { type: "FINISH_WITH_RETRY", retryEntry });
  assert.equal(state.phase, "retrying");
  if (state.phase === "retrying") assert.equal(state.retry.attempt, 1);

  // Re-claim after retry: retrying -> running
  const entry2 = makeRunningEntry({ retryAttempt: 1 });
  state = transitionSlot(state, { type: "CLAIM", entry: entry2 });
  assert.equal(state.phase, "running");
  if (state.phase === "running") assert.equal(state.entry.retryAttempt, 1);

  // Finish without retry: running -> idle
  state = transitionSlot(state, { type: "FINISH_NO_RETRY" });
  assert.equal(state.phase, "idle");
});

test("full lifecycle: idle -> running -> retrying -> cleanup -> completed", () => {
  let state: SlotState = initialSlotState();

  // Claim
  state = transitionSlot(state, { type: "CLAIM", entry: makeRunningEntry() });
  assert.equal(state.phase, "running");

  // Fail with retry
  state = transitionSlot(state, { type: "FINISH_WITH_RETRY", retryEntry: makeRetryEntry() });
  assert.equal(state.phase, "retrying");

  // External cleanup (reconciliation removed the issue)
  state = transitionSlot(state, { type: "CLEANUP" });
  assert.equal(state.phase, "completed");

  // Terminal state absorbs further events
  state = transitionSlot(state, { type: "CLAIM", entry: makeRunningEntry() });
  assert.equal(state.phase, "completed");
});

test("full lifecycle: idle -> running -> multiple updates -> finish_with_retry -> claim -> finish_no_retry", () => {
  let state: SlotState = initialSlotState();

  const entry = makeRunningEntry();
  state = transitionSlot(state, { type: "CLAIM", entry });
  assert.equal(state.phase, "running");

  // Multiple turn completions
  const now = new Date("2025-01-01T00:10:00Z");
  for (let i = 0; i < 3; i++) {
    state = transitionSlot(state, { type: "UPDATE", update: { type: "turn_completed" }, now });
  }
  if (state.phase === "running") assert.equal(state.entry.turnCount, 3);

  // Fail -> retry
  state = transitionSlot(state, {
    type: "FINISH_WITH_RETRY",
    retryEntry: makeRetryEntry({ attempt: 1 }),
  });
  assert.equal(state.phase, "retrying");

  // Re-claim
  const entry2 = makeRunningEntry({ retryAttempt: 1, turnCount: 0 });
  state = transitionSlot(state, { type: "CLAIM", entry: entry2 });
  assert.equal(state.phase, "running");
  if (state.phase === "running") {
    assert.equal(state.entry.turnCount, 0); // fresh entry, not accumulated
    assert.equal(state.entry.retryAttempt, 1);
  }

  // Succeed
  state = transitionSlot(state, { type: "FINISH_NO_RETRY" });
  assert.equal(state.phase, "idle");
});

// --- isTerminalOrEmptyPhase ---

test("isTerminalOrEmptyPhase returns true for idle", () => {
  assert.equal(isTerminalOrEmptyPhase({ phase: "idle" }), true);
});

test("isTerminalOrEmptyPhase returns true for completed", () => {
  assert.equal(isTerminalOrEmptyPhase({ phase: "completed" }), true);
});

test("isTerminalOrEmptyPhase returns false for running", () => {
  assert.equal(isTerminalOrEmptyPhase({ phase: "running", entry: makeRunningEntry() }), false);
});

test("isTerminalOrEmptyPhase returns false for retrying", () => {
  assert.equal(isTerminalOrEmptyPhase({ phase: "retrying", retry: makeRetryEntry() }), false);
});
