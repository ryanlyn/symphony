import { test } from "vitest";
import { AGENT_UPDATE_TYPES } from "@symphony/domain";
import type { DispatchBlockEntry } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { RUNTIME_EVENT_TYPES, RUNTIME_RUN_OUTCOMES } from "@symphony/runtime-events";
import type {
  RuntimeBlockedEntry,
  RuntimeEvent,
  RuntimeRetryEntry,
  RuntimeRunHistoryEntry,
  RuntimeRunningEntry,
  RuntimeSnapshot,
} from "@symphony/runtime-events";

test("RUNTIME_EVENT_TYPES is a strict superset of AGENT_UPDATE_TYPES with no duplicates", () => {
  // Every AGENT_UPDATE_TYPE must appear in RUNTIME_EVENT_TYPES
  for (const agentType of AGENT_UPDATE_TYPES) {
    assert.ok(RUNTIME_EVENT_TYPES.includes(agentType));
  }

  // Check for no duplicate entries in the array
  const seen = new Set<string>();
  for (const t of RUNTIME_EVENT_TYPES) {
    assert.ok(!seen.has(t));
    seen.add(t);
  }

  // The runtime-specific types are exactly the difference between RUNTIME_EVENT_TYPES and AGENT_UPDATE_TYPES
  const agentSet = new Set<string>(AGENT_UPDATE_TYPES);
  const runtimeOnly = RUNTIME_EVENT_TYPES.filter((t) => !agentSet.has(t));

  // These are the known runtime-specific event types that must exist
  const expectedRuntimeSpecific = [
    "dry_run",
    "poll_error",
    "dispatch_skipped",
    "run_started",
    "dispatch_refresh_failed",
    "run_completed",
    "run_failed",
    "workflow_reloaded",
    "workflow_reload_failed",
    "reconcile_refresh_failed",
    "workspace_cleanup",
    "run_reconciled",
    "run_stalled",
    "startup_workspace_cleanup",
    "startup_workspace_cleanup_failed",
    "resume_state_invalidated",
    "resume_state_invalidation_failed",
    "retry_timer_due",
    "retry_timer_error",
    "refresh_error",
  ];

  // Every expected runtime-specific type is present
  for (const t of expectedRuntimeSpecific) {
    assert.ok(runtimeOnly.includes(t));
  }

  // And there are no unexpected extras in the runtime-only set
  assert.equal(runtimeOnly.length, expectedRuntimeSpecific.length);

  // Total length must equal AGENT_UPDATE_TYPES + runtime-specific (since no duplicates)
  assert.equal(
    RUNTIME_EVENT_TYPES.length,
    AGENT_UPDATE_TYPES.length + expectedRuntimeSpecific.length,
  );
});

test("RUNTIME_EVENT_TYPES starts with AGENT_UPDATE_TYPES in order then appends runtime types", () => {
  // The source builds RUNTIME_EVENT_TYPES as [...AGENT_UPDATE_TYPES, ...runtimeSpecific]
  // so the first N entries must exactly match AGENT_UPDATE_TYPES in order
  for (let i = 0; i < AGENT_UPDATE_TYPES.length; i++) {
    assert.equal(RUNTIME_EVENT_TYPES[i], AGENT_UPDATE_TYPES[i]);
  }

  // The remaining entries should all be runtime-specific (not in AGENT_UPDATE_TYPES)
  const agentSet = new Set<string>(AGENT_UPDATE_TYPES);
  for (let i = AGENT_UPDATE_TYPES.length; i < RUNTIME_EVENT_TYPES.length; i++) {
    assert.ok(!agentSet.has(RUNTIME_EVENT_TYPES[i]));
  }
});

test("RUNTIME_RUN_OUTCOMES contains exactly the four expected outcomes with no duplicates", () => {
  // Verify exact contents
  assert.equal(RUNTIME_RUN_OUTCOMES.length, 4);
  assert.ok(RUNTIME_RUN_OUTCOMES.includes("success"));
  assert.ok(RUNTIME_RUN_OUTCOMES.includes("failed"));
  assert.ok(RUNTIME_RUN_OUTCOMES.includes("stalled"));
  assert.ok(RUNTIME_RUN_OUTCOMES.includes("canceled"));

  // No duplicates
  const unique = new Set(RUNTIME_RUN_OUTCOMES);
  assert.equal(unique.size, RUNTIME_RUN_OUTCOMES.length);

  // Verify that all entries are non-empty strings (guards against accidental undefined/null)
  for (const outcome of RUNTIME_RUN_OUTCOMES) {
    assert.ok(typeof outcome === "string");
    assert.ok(outcome.length > 0);
  }
});

test("RUNTIME_EVENT_TYPES entries are all non-empty lowercase snake_case strings", () => {
  const snakeCasePattern = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
  for (const eventType of RUNTIME_EVENT_TYPES) {
    assert.ok(typeof eventType === "string");
    assert.ok(eventType.length > 0);
    assert.match(eventType, snakeCasePattern);
  }
});

test("RUNTIME_RUN_OUTCOMES entries are all non-empty lowercase strings", () => {
  for (const outcome of RUNTIME_RUN_OUTCOMES) {
    assert.ok(typeof outcome === "string");
    assert.ok(outcome.length > 0);
    assert.equal(outcome, outcome.toLowerCase());
  }
});

test("RuntimeRunHistoryEntry serialization preserves undefined fields as absent in JSON", () => {
  // This tests a real serialization boundary concern: optional fields set to undefined
  // should not appear as keys in JSON (which is important for wire formats)
  const entry: RuntimeRunHistoryEntry = {
    id: "run-001",
    issueId: "issue-1",
    issueIdentifier: "MT-1",
    slotIndex: 0,
    agentKind: "codex",
    outcome: "success",
    turnCount: 5,
    startedAt: "2026-05-26T00:00:00.000Z",
    endedAt: "2026-05-26T00:05:00.000Z",
    // optional fields left as undefined
    error: undefined,
    issueTitle: undefined,
    sessionId: undefined,
  };

  const serialized = JSON.stringify(entry);
  const parsed = JSON.parse(serialized);

  // undefined fields are dropped by JSON.stringify - this is the actual contract
  assert.ok(!("error" in parsed));
  assert.ok(!("issueTitle" in parsed));
  assert.ok(!("sessionId" in parsed));

  // Required fields survive serialization
  assert.equal(parsed.id, "run-001");
  assert.equal(parsed.issueId, "issue-1");
  assert.equal(parsed.outcome, "success");
  assert.equal(parsed.turnCount, 5);
  assert.equal(parsed.slotIndex, 0);
});

test("RuntimeRunHistoryEntry serialization preserves null fields as null in JSON", () => {
  // null (as opposed to undefined) is preserved in JSON - this matters for fields
  // like sessionId/resumeId which can be explicitly null vs absent
  const entry: RuntimeRunHistoryEntry = {
    id: "run-002",
    issueId: "issue-2",
    issueIdentifier: "MT-2",
    slotIndex: 1,
    agentKind: "claude",
    outcome: "failed",
    turnCount: 0,
    startedAt: "2026-05-26T00:00:00.000Z",
    endedAt: "2026-05-26T00:01:00.000Z",
    sessionId: null,
    resumeId: null,
    lastEvent: null,
    lastEventAt: null,
    retryAttempt: null,
  };

  const serialized = JSON.stringify(entry);
  const parsed = JSON.parse(serialized);

  // null fields are preserved in JSON (unlike undefined)
  assert.equal(parsed.sessionId, null);
  assert.equal(parsed.resumeId, null);
  assert.equal(parsed.lastEvent, null);
  assert.equal(parsed.lastEventAt, null);
  assert.equal(parsed.retryAttempt, null);
});

test("RuntimeSnapshot recentEvents preserves event ordering through serialization", () => {
  // Tests that the event array preserves insertion order - important for timeline views
  const events: RuntimeEvent[] = [
    { type: "run_started", message: "First", at: "2026-05-26T00:00:00.000Z" },
    { type: "run_completed", message: "Second", at: "2026-05-26T00:01:00.000Z" },
    { type: "run_failed", message: "Third", at: "2026-05-26T00:02:00.000Z" },
  ];

  const snapshot: RuntimeSnapshot = {
    appStatus: "running",
    workflowPath: "/tmp/workflow.yaml",
    poll: {
      status: "idle",
      candidates: 0,
      eligible: 0,
      lastPollAt: null,
      nextPollAt: null,
      lastError: null,
    },
    running: [],
    retrying: [],
    blocked: [],
    runHistory: [],
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
    logFile: null,
    recentEvents: events,
  };

  const roundTripped = JSON.parse(JSON.stringify(snapshot));

  // Verify order is preserved
  assert.equal(roundTripped.recentEvents.length, 3);
  assert.equal(roundTripped.recentEvents[0].type, "run_started");
  assert.equal(roundTripped.recentEvents[1].type, "run_completed");
  assert.equal(roundTripped.recentEvents[2].type, "run_failed");

  // Verify all fields survive
  assert.equal(roundTripped.recentEvents[0].message, "First");
  assert.equal(roundTripped.recentEvents[2].at, "2026-05-26T00:02:00.000Z");
});

test("RuntimeBlockedEntry reason field is constrained to known DispatchBlockReason values", () => {
  // Verify that all three known block reasons produce valid entries
  const reasons: DispatchBlockEntry["reason"][] = [
    "global_concurrency_cap",
    "local_concurrency_cap",
    "worker_host_capacity",
  ];

  const entries: RuntimeBlockedEntry[] = reasons.map((reason) => ({
    issueId: `issue-${reason}`,
    identifier: `MT-${reason}`,
    state: "Todo",
    reason,
  }));

  // Verify each entry's reason is one of the known values
  for (const entry of entries) {
    assert.ok(reasons.includes(entry.reason));
  }

  // Verify entries are distinct (not sharing references)
  assert.notEqual(entries[0].reason, entries[1].reason);
  assert.notEqual(entries[1].reason, entries[2].reason);

  // RuntimeBlockedEntry is a type alias for DispatchBlockEntry - verify assignment compatibility
  const asDispatch: DispatchBlockEntry = entries[0];
  const asBlocked: RuntimeBlockedEntry = asDispatch;
  assert.equal(asBlocked.issueId, asDispatch.issueId);
  assert.equal(asBlocked.reason, asDispatch.reason);
});

test("RuntimeBlockedEntry workerHost is optional and defaults to undefined when omitted", () => {
  const withoutHost: RuntimeBlockedEntry = {
    issueId: "issue-1",
    identifier: "MT-1",
    state: "Todo",
    reason: "global_concurrency_cap",
  };

  const withNullHost: RuntimeBlockedEntry = {
    issueId: "issue-2",
    identifier: "MT-2",
    state: "InProgress",
    reason: "worker_host_capacity",
    workerHost: null,
  };

  const withHost: RuntimeBlockedEntry = {
    issueId: "issue-3",
    identifier: "MT-3",
    state: "InProgress",
    reason: "local_concurrency_cap",
    workerHost: "worker-1.local",
  };

  // Without workerHost, the field should not exist in JSON
  const serializedWithout = JSON.parse(JSON.stringify(withoutHost));
  assert.ok(!("workerHost" in serializedWithout));

  // With null workerHost, it should be preserved as null
  const serializedNull = JSON.parse(JSON.stringify(withNullHost));
  assert.equal(serializedNull.workerHost, null);

  // With a value, it should be preserved
  const serializedWith = JSON.parse(JSON.stringify(withHost));
  assert.equal(serializedWith.workerHost, "worker-1.local");
});

test("RuntimeRetryEntry attempt must be a positive integer", () => {
  const retry: RuntimeRetryEntry = {
    issueId: "issue-3",
    identifier: "MT-3",
    attempt: 1,
    dueAt: "2026-05-26T02:00:00.000Z",
  };

  // attempt should be a positive integer
  assert.ok(Number.isInteger(retry.attempt));
  assert.ok(retry.attempt > 0);

  // dueAt should be a valid ISO string that can be parsed as a date
  const parsed = new Date(retry.dueAt);
  assert.ok(!isNaN(parsed.getTime()));
  assert.equal(parsed.toISOString(), retry.dueAt);
});

test("RuntimeRetryEntry optional fields serialize correctly across the JSON boundary", () => {
  const minimal: RuntimeRetryEntry = {
    issueId: "issue-min",
    identifier: "MT-MIN",
    attempt: 1,
    dueAt: "2026-05-26T00:00:00.000Z",
  };

  const full: RuntimeRetryEntry = {
    issueId: "issue-full",
    identifier: "MT-FULL",
    attempt: 3,
    dueAt: "2026-05-26T02:00:00.000Z",
    error: "OOM killed",
    slotIndex: 2,
    workerHost: "worker-3.local",
    workspacePath: "/tmp/workspace/MT-FULL",
  };

  const minParsed = JSON.parse(JSON.stringify(minimal));
  const fullParsed = JSON.parse(JSON.stringify(full));

  // Minimal entry should not have optional fields
  assert.ok(!("error" in minParsed));
  assert.ok(!("slotIndex" in minParsed));
  assert.ok(!("workerHost" in minParsed));
  assert.ok(!("workspacePath" in minParsed));

  // Full entry should have all fields
  assert.equal(fullParsed.error, "OOM killed");
  assert.equal(fullParsed.slotIndex, 2);
  assert.equal(fullParsed.workerHost, "worker-3.local");
  assert.equal(fullParsed.workspacePath, "/tmp/workspace/MT-FULL");

  // Required fields present in both
  assert.equal(minParsed.issueId, "issue-min");
  assert.equal(minParsed.attempt, 1);
  assert.equal(fullParsed.issueId, "issue-full");
  assert.equal(fullParsed.attempt, 3);
});

test("RuntimeRunningEntry usageTotals totalTokens equals inputTokens + outputTokens by convention", () => {
  // While not enforced at the type level, the contract is that totalTokens = input + output
  // This test documents and verifies that convention
  const running: RuntimeRunningEntry = {
    issueId: "issue-2",
    issueIdentifier: "MT-2",
    title: "Deploy the service",
    state: "InProgress",
    slotIndex: 0,
    ensembleSize: 1,
    agentKind: "claude",
    turnCount: 5,
    startedAt: "2026-05-26T01:00:00.000Z",
    usageTotals: { inputTokens: 150, outputTokens: 250, totalTokens: 400, secondsRunning: 30 },
  };

  assert.equal(
    running.usageTotals.totalTokens,
    running.usageTotals.inputTokens + running.usageTotals.outputTokens,
  );
  assert.ok(running.usageTotals.secondsRunning >= 0);
  assert.ok(running.usageTotals.inputTokens >= 0);
  assert.ok(running.usageTotals.outputTokens >= 0);
});

test("RuntimeSnapshot arrays can hold heterogeneous entries simultaneously", () => {
  // A realistic snapshot has multiple running/retrying/blocked entries at once
  const snapshot: RuntimeSnapshot = {
    appStatus: "running",
    workflowPath: "/workflow.yaml",
    poll: {
      status: "checking",
      candidates: 10,
      eligible: 5,
      lastPollAt: "2026-05-26T00:00:00.000Z",
      nextPollAt: "2026-05-26T00:01:00.000Z",
      lastError: null,
    },
    running: [
      {
        issueId: "i1",
        issueIdentifier: "MT-1",
        title: "Task 1",
        state: "InProgress",
        slotIndex: 0,
        ensembleSize: 2,
        agentKind: "codex",
        turnCount: 3,
        startedAt: "2026-05-26T00:00:00.000Z",
        usageTotals: { inputTokens: 100, outputTokens: 50, totalTokens: 150, secondsRunning: 10 },
      },
      {
        issueId: "i1",
        issueIdentifier: "MT-1",
        title: "Task 1",
        state: "InProgress",
        slotIndex: 1,
        ensembleSize: 2,
        agentKind: "codex",
        turnCount: 2,
        startedAt: "2026-05-26T00:00:01.000Z",
        usageTotals: { inputTokens: 80, outputTokens: 40, totalTokens: 120, secondsRunning: 9 },
      },
    ],
    retrying: [
      {
        issueId: "i2",
        identifier: "MT-2",
        attempt: 2,
        dueAt: "2026-05-26T00:05:00.000Z",
        error: "timeout",
      },
    ],
    blocked: [
      { issueId: "i3", identifier: "MT-3", state: "Todo", reason: "global_concurrency_cap" },
      {
        issueId: "i4",
        identifier: "MT-4",
        state: "Todo",
        reason: "worker_host_capacity",
        workerHost: "w1",
      },
    ],
    runHistory: [
      {
        id: "r1",
        issueId: "i5",
        issueIdentifier: "MT-5",
        slotIndex: 0,
        agentKind: "claude",
        outcome: "success",
        turnCount: 10,
        startedAt: "2026-05-25T00:00:00.000Z",
        endedAt: "2026-05-25T00:10:00.000Z",
      },
    ],
    usageTotals: { inputTokens: 500, outputTokens: 300, totalTokens: 800, secondsRunning: 120 },
    rateLimits: null,
    logFile: "/tmp/log",
    recentEvents: [
      { type: "run_started", message: "Started MT-1", at: "2026-05-26T00:00:00.000Z" },
    ],
  };

  // Ensemble: two running entries for the same issue with different slots
  assert.equal(snapshot.running.length, 2);
  assert.equal(snapshot.running[0].issueId, snapshot.running[1].issueId);
  assert.notEqual(snapshot.running[0].slotIndex, snapshot.running[1].slotIndex);
  assert.equal(snapshot.running[0].ensembleSize, 2);
  assert.equal(snapshot.running[1].ensembleSize, 2);

  // Blocked entries can have different reasons
  assert.equal(snapshot.blocked.length, 2);
  assert.notEqual(snapshot.blocked[0].reason, snapshot.blocked[1].reason);

  // Aggregate usageTotals should be >= sum of individual running entries
  const runningInputSum = snapshot.running.reduce((acc, r) => acc + r.usageTotals.inputTokens, 0);
  assert.ok(snapshot.usageTotals.inputTokens >= runningInputSum);

  // Serialization round-trip preserves structure
  const parsed = JSON.parse(JSON.stringify(snapshot));
  assert.equal(parsed.running.length, 2);
  assert.equal(parsed.retrying.length, 1);
  assert.equal(parsed.blocked.length, 2);
  assert.equal(parsed.runHistory.length, 1);
  assert.equal(parsed.recentEvents.length, 1);
  assert.equal(parsed.appStatus, "running");
  assert.equal(parsed.poll.status, "checking");
});
