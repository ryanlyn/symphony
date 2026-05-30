import { test } from "vitest";
import fc from "fast-check";
import { defaultSettings, parseConfig } from "@symphony/config";
import { slotKey } from "@symphony/dispatch";
import type { Issue, Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { Orchestrator } from "@symphony/orchestrator";

// --- Helpers ---

function makeClock(baseMs: number) {
  let now = baseMs;
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Test issue",
    state: "Todo",
    stateType: "unstarted",
    description: null,
    branchName: null,
    url: null,
    priority: 1,
    createdAt: null,
    updatedAt: null,
    labels: [],
    blockers: [],
    assigneeId: null,
    assignedToWorker: true,
    ...overrides,
  };
}

function makeSettings(overrides: { maxConcurrent?: number; ensembleSize?: number } = {}): Settings {
  const s = defaultSettings();
  if (overrides.maxConcurrent !== undefined) s.agent.maxConcurrentAgents = overrides.maxConcurrent;
  if (overrides.ensembleSize !== undefined) s.agent.ensembleSize = overrides.ensembleSize;
  return s;
}

// ============================================================================
// DISPATCH CONCURRENCY
// ============================================================================

// INVARIANT: When the global concurrency cap is evaluated, the count of entries in the running map SHALL be compared against the configured limit.
test("global concurrency cap blocks claim when running map reaches limit", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 10 }), (cap) => {
      const clock = makeClock(1000000);
      const settings = makeSettings({ maxConcurrent: cap });
      const orch = new Orchestrator(settings, clock);

      for (let i = 0; i < cap; i++) {
        const issue = makeIssue({ id: `issue-${i}`, identifier: `T-${i}` });
        const entry = orch.claim(issue);
        assert.ok(entry !== null);
      }

      const extra = makeIssue({ id: "issue-extra", identifier: "T-EXTRA" });
      assert.equal(orch.claim(extra), null);
    }),
    { numRuns: 50 },
  );
});

// INVARIANT: When a per-state concurrency cap is evaluated, only running entries in that specific state SHALL count toward the state limit.
test("per-state cap only counts entries in that state", () => {
  const settings = parseConfig({
    status_overrides: { todo: { agent: { max_concurrent_agents: 1 } } },
  });
  settings.agent.maxConcurrentAgents = 10;
  const clock = makeClock(1000000);
  const orch = new Orchestrator(settings, clock);

  const todoIssue = makeIssue({ id: "todo-1", identifier: "T-1", state: "Todo" });
  const inProgressIssue = makeIssue({
    id: "ip-1",
    identifier: "T-2",
    state: "In Progress",
    stateType: "started",
  });

  assert.ok(orch.claim(todoIssue) !== null);
  assert.ok(orch.claim(inProgressIssue) !== null);

  const todoIssue2 = makeIssue({ id: "todo-2", identifier: "T-3", state: "Todo" });
  assert.equal(orch.claim(todoIssue2), null);
});

// INVARIANT: When both global and state-specific caps exist, both SHALL be satisfied for dispatch to proceed.
test("both global and state-specific caps must be satisfied", () => {
  const settings = parseConfig({
    agent: { max_concurrent_agents: 2 },
    status_overrides: { todo: { agent: { max_concurrent_agents: 1 } } },
  });
  const clock = makeClock(1000000);
  const orch = new Orchestrator(settings, clock);

  const todo1 = makeIssue({ id: "t1", identifier: "T-1", state: "Todo" });
  assert.ok(orch.claim(todo1) !== null);

  const todo2 = makeIssue({ id: "t2", identifier: "T-2", state: "Todo" });
  assert.equal(orch.claim(todo2), null);
});

// INVARIANT: When worker host capacity is tracked, each host's running count SHALL be computed from the running map entries assigned to that host.
test("worker host capacity is computed from running entries per host", () => {
  const settings = defaultSettings();
  settings.agent.maxConcurrentAgents = 10;
  settings.worker.sshHosts = ["host-a", "host-b"];
  settings.worker.maxConcurrentAgentsPerHost = 1;
  const clock = makeClock(1000000);
  const orch = new Orchestrator(settings, clock);

  const issue1 = makeIssue({ id: "i1", identifier: "T-1" });
  const issue2 = makeIssue({ id: "i2", identifier: "T-2" });
  const entry1 = orch.claim(issue1);
  const entry2 = orch.claim(issue2);
  assert.ok(entry1 !== null);
  assert.ok(entry2 !== null);
  assert.notEqual(entry1!.workerHost, entry2!.workerHost);

  const issue3 = makeIssue({ id: "i3", identifier: "T-3" });
  assert.equal(orch.claim(issue3), null);
});

// INVARIANT: When host selection is performed, the least-loaded host below the cap SHALL be selected deterministically (first in config order on tie).
test("least-loaded host is selected; first in config order on tie", () => {
  const settings = defaultSettings();
  settings.agent.maxConcurrentAgents = 10;
  settings.worker.sshHosts = ["host-a", "host-b", "host-c"];
  settings.worker.maxConcurrentAgentsPerHost = 3;
  const clock = makeClock(1000000);
  const orch = new Orchestrator(settings, clock);

  const entry1 = orch.claim(makeIssue({ id: "i1", identifier: "T-1" }));
  assert.equal(entry1!.workerHost, "host-a");

  const entry2 = orch.claim(makeIssue({ id: "i2", identifier: "T-2" }));
  assert.equal(entry2!.workerHost, "host-b");

  const entry3 = orch.claim(makeIssue({ id: "i3", identifier: "T-3" }));
  assert.equal(entry3!.workerHost, "host-c");

  const entry4 = orch.claim(makeIssue({ id: "i4", identifier: "T-4" }));
  assert.equal(entry4!.workerHost, "host-a");
});

// ============================================================================
// CLAIM LIFECYCLE
// ============================================================================

// INVARIANT: While a slot is claimed, it SHALL NOT be claimable by another dispatch.
test("claimed slot is not claimable by another dispatch", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 5 }), (ensembleSize) => {
      const settings = makeSettings({ maxConcurrent: 20, ensembleSize });
      const clock = makeClock(1000000);
      const orch = new Orchestrator(settings, clock);
      const issue = makeIssue();

      for (let i = 0; i < ensembleSize; i++) {
        const entry = orch.claim(issue);
        assert.ok(entry !== null);
        assert.equal(entry!.slotIndex, i);
      }
      assert.equal(orch.claim(issue), null);
    }),
    { numRuns: 50 },
  );
});

// INVARIANT: When a claim succeeds, any existing retry entry for that issue SHALL be removed.
test("successful claim removes existing retry entry for that issue", () => {
  const clock = makeClock(1000000);
  const settings = makeSettings({ maxConcurrent: 10 });
  const orch = new Orchestrator(settings, clock);
  const issue = makeIssue();

  const entry = orch.claim(issue);
  assert.ok(entry !== null);
  clock.advance(1000);
  orch.finish(issue.id, 0, true, undefined, "continuation");

  const snap1 = orch.snapshot();
  assert.equal(snap1.retrying.length, 1);

  clock.advance(10000);
  const entry2 = orch.claim(issue);
  assert.ok(entry2 !== null);

  const snap2 = orch.snapshot();
  assert.equal(snap2.retrying.filter((r) => r.issueId === issue.id).length, 0);
});

// INVARIANT: When a worker finishes, its slot key SHALL be removed from both running and claimed.
test("finish removes slot from both running and claimed", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 4 }),
      fc.integer({ min: 2, max: 5 }),
      (slotIdx, ensembleSize) => {
        const slot = slotIdx % ensembleSize;
        const clock = makeClock(1000000);
        const settings = makeSettings({ maxConcurrent: 20, ensembleSize });
        const orch = new Orchestrator(settings, clock);
        const issue = makeIssue();

        for (let i = 0; i <= slot; i++) {
          orch.claim(issue);
        }

        clock.advance(5000);
        orch.finish(issue.id, slot, true);

        const key = slotKey(issue.id, slot);
        assert.equal(orch.state.running.has(key), false);
        assert.equal(orch.state.claimed.has(key), false);
      },
    ),
    { numRuns: 50 },
  );
});

// INVARIANT: When all ensemble slots for an issue are claimed, the issue SHALL be ineligible for further dispatch.
test("all ensemble slots claimed makes issue ineligible", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 5 }), (ensembleSize) => {
      const clock = makeClock(1000000);
      const settings = makeSettings({ maxConcurrent: 20, ensembleSize });
      const orch = new Orchestrator(settings, clock);
      const issue = makeIssue();

      for (let i = 0; i < ensembleSize; i++) {
        assert.ok(orch.claim(issue) !== null);
      }

      assert.equal(orch.claim(issue), null);
      assert.equal(orch.eligibleIssues([issue]).length, 0);
    }),
    { numRuns: 50 },
  );
});

// INVARIANT: When a retry becomes due, stale claims (claimed but not running) SHALL be released before re-dispatch.
test("stale claims are released when retry becomes due", () => {
  const clock = makeClock(1000000);
  const settings = makeSettings({ maxConcurrent: 10, ensembleSize: 2 });
  const orch = new Orchestrator(settings, clock);
  const issue = makeIssue();

  const entry0 = orch.claim(issue);
  const entry1 = orch.claim(issue);
  assert.ok(entry0 !== null);
  assert.ok(entry1 !== null);

  clock.advance(5000);
  orch.finish(issue.id, 0, true, undefined, "continuation");

  assert.equal(orch.state.claimed.has(slotKey(issue.id, 1)), true);
  assert.equal(orch.state.running.has(slotKey(issue.id, 1)), true);

  clock.advance(5000);
  orch.finish(issue.id, 1, true, undefined, "continuation");

  clock.advance(10000);
  const eligible = orch.eligibleIssues([issue]);
  assert.ok(eligible.length > 0);

  const reclaimed = orch.claim(issue);
  assert.ok(reclaimed !== null);
});

// ============================================================================
// RUNNING ENTRY UPDATES
// ============================================================================

// INVARIANT: When an update targets an unknown slot key, the system SHALL silently ignore it.
test("update to unknown slot key is silently ignored", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.integer({ min: 0, max: 100 }),
      (issueId, slotIndex) => {
        const clock = makeClock(1000000);
        const settings = makeSettings();
        const orch = new Orchestrator(settings, clock);

        const stateBefore = JSON.stringify(orch.snapshot());
        orch.applyUpdate(issueId, slotIndex, { type: "turn_completed" });
        const stateAfter = JSON.stringify(orch.snapshot());

        assert.equal(stateBefore, stateAfter);
      },
    ),
    { numRuns: 200 },
  );
});

// INVARIANT: When a turn_completed event is received, the turn count SHALL increment by exactly one.
test("turn_completed increments turn count by exactly one", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), (numTurns) => {
      const clock = makeClock(1000000);
      const settings = makeSettings({ maxConcurrent: 10 });
      const orch = new Orchestrator(settings, clock);
      const issue = makeIssue();

      const entry = orch.claim(issue);
      assert.ok(entry !== null);
      assert.equal(entry!.turnCount, 0);

      for (let i = 0; i < numTurns; i++) {
        orch.applyUpdate(issue.id, 0, { type: "turn_completed" });
      }

      const running = orch.state.running.get(slotKey(issue.id, 0));
      assert.equal(running!.turnCount, numTurns);
    }),
    { numRuns: 50 },
  );
});

// INVARIANT: When usage totals are updated via watermark, entry totals SHALL never decrease.
test("usage updates never decrease entry totals", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          inputTokens: fc.integer({ min: -1000, max: 10000 }),
          outputTokens: fc.integer({ min: -1000, max: 10000 }),
          totalTokens: fc.integer({ min: -1000, max: 10000 }),
        }),
        { minLength: 1, maxLength: 10 },
      ),
      (updates) => {
        const clock = makeClock(1000000);
        const settings = makeSettings({ maxConcurrent: 10 });
        const orch = new Orchestrator(settings, clock);
        const issue = makeIssue();

        orch.claim(issue);
        let prevInput = 0;
        let prevOutput = 0;
        let prevTotal = 0;

        for (const usage of updates) {
          orch.applyUpdate(issue.id, 0, { type: "usage", usage });
          const entry = orch.state.running.get(slotKey(issue.id, 0))!;
          assert.ok(entry.usageTotals.inputTokens >= prevInput);
          assert.ok(entry.usageTotals.outputTokens >= prevOutput);
          assert.ok(entry.usageTotals.totalTokens >= prevTotal);
          prevInput = entry.usageTotals.inputTokens;
          prevOutput = entry.usageTotals.outputTokens;
          prevTotal = entry.usageTotals.totalTokens;
        }
      },
    ),
    { numRuns: 200 },
  );
});

// INVARIANT: When global usage totals are updated, only positive deltas SHALL be added.
test("global usage totals never decrease", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          inputTokens: fc.integer({ min: -500, max: 5000 }),
          outputTokens: fc.integer({ min: -500, max: 5000 }),
          totalTokens: fc.integer({ min: -500, max: 5000 }),
        }),
        { minLength: 1, maxLength: 10 },
      ),
      (updates) => {
        const clock = makeClock(1000000);
        const settings = makeSettings({ maxConcurrent: 10 });
        const orch = new Orchestrator(settings, clock);
        const issue = makeIssue();

        orch.claim(issue);
        let prevGlobalInput = 0;
        let prevGlobalOutput = 0;
        let prevGlobalTotal = 0;

        for (const usage of updates) {
          orch.applyUpdate(issue.id, 0, { type: "usage", usage });
          assert.ok(orch.state.usageTotals.inputTokens >= prevGlobalInput);
          assert.ok(orch.state.usageTotals.outputTokens >= prevGlobalOutput);
          assert.ok(orch.state.usageTotals.totalTokens >= prevGlobalTotal);
          prevGlobalInput = orch.state.usageTotals.inputTokens;
          prevGlobalOutput = orch.state.usageTotals.outputTokens;
          prevGlobalTotal = orch.state.usageTotals.totalTokens;
        }
      },
    ),
    { numRuns: 200 },
  );
});

// INVARIANT: When a running entry is refreshed, all slots for that issue SHALL see the same updated issue state.
test("refreshRunningIssue updates all slots for that issue", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 5 }), (ensembleSize) => {
      const clock = makeClock(1000000);
      const settings = makeSettings({ maxConcurrent: 20, ensembleSize });
      const orch = new Orchestrator(settings, clock);
      const issue = makeIssue();

      for (let i = 0; i < ensembleSize; i++) {
        orch.claim(issue);
      }

      const updatedIssue = makeIssue({ state: "In Progress", stateType: "started" });
      orch.refreshRunningIssue(updatedIssue);

      for (let i = 0; i < ensembleSize; i++) {
        const entry = orch.state.running.get(slotKey(issue.id, i));
        assert.equal(entry!.issue.state, "In Progress");
      }
    }),
    { numRuns: 50 },
  );
});

// ============================================================================
// ORCHESTRATOR COMPLETION
// ============================================================================

// INVARIANT: When an issue is cleaned up, all running entries, all claimed slots, and the retry entry SHALL be removed.
test("cleanupIssue removes all running entries, claimed slots, and retry entry", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 4 }), (ensembleSize) => {
      const clock = makeClock(1000000);
      const settings = makeSettings({ maxConcurrent: 20, ensembleSize });
      const orch = new Orchestrator(settings, clock);
      const issue = makeIssue();

      for (let i = 0; i < ensembleSize; i++) {
        orch.claim(issue);
      }

      clock.advance(1000);
      orch.finish(issue.id, 0, true, undefined, "continuation");

      orch.cleanupIssue(issue.id);

      for (let i = 0; i < ensembleSize; i++) {
        assert.equal(orch.state.running.has(slotKey(issue.id, i)), false);
        assert.equal(orch.state.claimed.has(slotKey(issue.id, i)), false);
      }
      assert.equal(orch.state.retryAttempts.has(issue.id), false);
    }),
    { numRuns: 50 },
  );
});

// INVARIANT: When a worker finishes, runtime seconds SHALL be computed as elapsed time since startedAt.
test("finish adds elapsed seconds to cumulative usageTotals.secondsRunning", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1000, max: 300000 }), (elapsedMs) => {
      const clock = makeClock(1000000);
      const settings = makeSettings({ maxConcurrent: 10 });
      const orch = new Orchestrator(settings, clock);
      const issue = makeIssue();

      orch.claim(issue);
      const secondsBefore = orch.state.usageTotals.secondsRunning;

      clock.advance(elapsedMs);
      orch.finish(issue.id, 0, true);

      const expectedAdded = elapsedMs / 1000;
      const actualAdded = orch.state.usageTotals.secondsRunning - secondsBefore;
      assert.ok(Math.abs(actualAdded - expectedAdded) < 0.001);
    }),
    { numRuns: 200 },
  );
});

// INVARIANT: When a worker finishes normally, the system SHALL schedule a continuation retry.
test("normal finish schedules a retry entry", () => {
  const clock = makeClock(1000000);
  const settings = makeSettings({ maxConcurrent: 10 });
  const orch = new Orchestrator(settings, clock);
  const issue = makeIssue();

  orch.claim(issue);
  clock.advance(5000);
  orch.finish(issue.id, 0, true, undefined, "continuation");

  const snap = orch.snapshot();
  assert.equal(snap.retrying.length, 1);
  assert.equal(snap.retrying[0]!.issueId, issue.id);
});

test("abnormal finish (normal=false) does NOT schedule a retry", () => {
  const clock = makeClock(1000000);
  const settings = makeSettings({ maxConcurrent: 10 });
  const orch = new Orchestrator(settings, clock);
  const issue = makeIssue();

  orch.claim(issue);
  clock.advance(5000);
  orch.finish(issue.id, 0, false, "error occurred");

  const snap = orch.snapshot();
  assert.equal(snap.retrying.length, 0);
});

// INVARIANT: When a snapshot is produced, it SHALL return defensive copies that do not alias internal state.
test("snapshot returns defensive copies that do not alias internal state", () => {
  const clock = makeClock(1000000);
  const settings = makeSettings({ maxConcurrent: 10 });
  const orch = new Orchestrator(settings, clock);
  const issue = makeIssue();

  orch.claim(issue);
  clock.advance(5000);
  orch.finish(issue.id, 0, true, undefined, "continuation");

  const snap1 = orch.snapshot();
  const snap2 = orch.snapshot();

  assert.ok(snap1.running !== snap2.running);
  assert.ok(snap1.retrying !== snap2.retrying);
  assert.ok(snap1.blocked !== snap2.blocked);
  assert.ok(snap1.usageTotals !== snap2.usageTotals);

  snap1.usageTotals.inputTokens = 999999;
  assert.notEqual(orch.state.usageTotals.inputTokens, 999999);

  if (snap1.retrying.length > 0) {
    snap1.retrying.push(snap1.retrying[0]!);
    assert.notEqual(snap1.retrying.length, snap2.retrying.length);
  }
});
