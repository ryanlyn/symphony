import { test } from "vitest";
import fc from "fast-check";
import {
  shouldDispatchIssue,
  dispatchBlockReason,
  issueHasOpenBlockers,
  defaultSettings,
  slotKey,
} from "@symphony/cli";
import type { Issue, Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

// --- Helper arbitraries and factories ---

function makeSettings(overrides: Partial<{
  activeStates: string[];
  terminalStates: string[];
  maxConcurrentAgents: number;
  ensembleSize: number;
}> = {}): Settings {
  const s = defaultSettings();
  if (overrides.activeStates) s.tracker.activeStates = overrides.activeStates;
  if (overrides.terminalStates) s.tracker.terminalStates = overrides.terminalStates;
  if (overrides.maxConcurrentAgents !== undefined)
    s.agent.maxConcurrentAgents = overrides.maxConcurrentAgents;
  if (overrides.ensembleSize !== undefined) s.agent.ensembleSize = overrides.ensembleSize;
  return s;
}

function validIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "A valid test issue",
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

// --- Invariant 1: Missing required fields -> ineligible ---

test("invariant 1: missing required fields (id, identifier, title, state) SHALL be ineligible", () => {
  const requiredFields = ["id", "identifier", "title", "state"] as const;

  fc.assert(
    fc.property(
      fc.constantFrom(...requiredFields),
      fc.oneof(fc.constant(""), fc.constant(null as unknown as string)),
      (field, emptyValue) => {
        const issue = validIssue({ [field]: emptyValue });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

test("invariant 1: empty strings for required fields produce ineligibility regardless of other fields", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("id", "identifier", "title", "state"),
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.string({ minLength: 1, maxLength: 20 }),
      (field, randomLabel, randomDesc) => {
        const issue = validIssue({
          [field]: "",
          labels: [randomLabel],
          description: randomDesc,
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

// --- Invariant 2: Terminal state -> ineligible ---

test("invariant 2: terminal state issues SHALL be ineligible", () => {
  const defaultTerminalStates = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

  fc.assert(
    fc.property(
      fc.constantFrom(...defaultTerminalStates),
      fc.constantFrom("completed", "canceled" as const),
      (terminalState, stateType) => {
        const issue = validIssue({ state: terminalState, stateType });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

test("invariant 2: terminal state ineligibility is case-insensitive", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("done", "DONE", "Done", "dOnE", "closed", "CLOSED"),
      (terminalState) => {
        const issue = validIssue({ state: terminalState, stateType: "completed" });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

// --- Invariant 3: Non-active state -> ineligible ---

test("invariant 3: non-active state issues SHALL be ineligible", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter(
        (s) =>
          s.trim().toLowerCase() !== "todo" &&
          s.trim().toLowerCase() !== "in progress",
      ),
      (nonActiveState) => {
        const issue = validIssue({ state: nonActiveState, stateType: "unstarted" });
        const settings = makeSettings({
          activeStates: ["Todo", "In Progress"],
          terminalStates: ["Done"],
        });
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

// --- Invariant 4: Not assigned to this worker -> ineligible ---

test("invariant 4: issues not assigned to this worker SHALL be ineligible", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.integer({ min: 0, max: 10 }),
      (_unusedBool, runningCount) => {
        const issue = validIssue({ assignedToWorker: false });
        const settings = makeSettings();
        const state = { runningCount, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

test("invariant 4: assignedToWorker=false always blocks even when all else is valid", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Todo", "In Progress"),
      (activeState) => {
        const issue = validIssue({
          state: activeState,
          stateType: "unstarted",
          assignedToWorker: false,
          blockers: [],
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

// --- Invariant 5: Unstarted issue with non-terminal blocker -> ineligible ---

test("invariant 5: unstarted issue with a non-terminal blocker SHALL be ineligible", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter(
        (s) => {
          const lower = s.trim().toLowerCase();
          return (
            lower !== "closed" &&
            lower !== "cancelled" &&
            lower !== "canceled" &&
            lower !== "duplicate" &&
            lower !== "done"
          );
        },
      ),
      (blockerState) => {
        const issue = validIssue({
          state: "Todo",
          stateType: "unstarted",
          blockers: [{ state: blockerState, stateType: null }],
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueHasOpenBlockers(issue, settings), true);
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

test("invariant 5: multiple blockers with at least one non-terminal blocks dispatch", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 3 }),
      (numTerminalBlockers) => {
        const terminalBlockers = Array.from({ length: numTerminalBlockers }, () => ({
          state: "Done",
          stateType: "completed" as const,
        }));
        const nonTerminalBlocker = { state: "In Progress", stateType: null };
        const issue = validIssue({
          state: "Todo",
          stateType: "unstarted",
          blockers: [...terminalBlockers, nonTerminalBlocker],
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueHasOpenBlockers(issue, settings), true);
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

// --- Invariant 6: Non-unstarted issue with blockers -> still eligible ---

test("invariant 6: non-unstarted issue with blockers SHALL still be eligible", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("started" as const),
      fc.array(
        fc.record({
          state: fc.constantFrom("Todo", "In Progress", "Review"),
          stateType: fc.constant(null as null),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      (stateType, blockers) => {
        const issue = validIssue({
          state: "In Progress",
          stateType,
          blockers,
          assignedToWorker: true,
        });
        const settings = makeSettings({
          activeStates: ["Todo", "In Progress"],
        });
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueHasOpenBlockers(issue, settings), false);
        assert.equal(shouldDispatchIssue(issue, settings, state), true);
      },
    ),
  );
});

// --- Invariant 7: Unstarted issue with only terminal blockers -> eligible ---

test("invariant 7: unstarted issue with only terminal blockers SHALL be eligible", () => {
  const defaultTerminalStates = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          state: fc.constantFrom(...defaultTerminalStates),
          stateType: fc.constant(null as null),
        }),
        { minLength: 1, maxLength: 4 },
      ),
      (blockers) => {
        const issue = validIssue({
          state: "Todo",
          stateType: "unstarted",
          blockers,
          assignedToWorker: true,
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueHasOpenBlockers(issue, settings), false);
        assert.equal(shouldDispatchIssue(issue, settings, state), true);
      },
    ),
  );
});

// --- Invariant 8: Global concurrency cap reached -> SHALL not dispatch ---

test("invariant 8: global concurrency cap reached SHALL not dispatch new work", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 50 }),
      fc.nat({ max: 10 }),
      (cap, extra) => {
        const issue = validIssue({
          state: "Todo",
          stateType: "unstarted",
          blockers: [],
          assignedToWorker: true,
        });
        const settings = makeSettings({ maxConcurrentAgents: cap });
        const runningCount = cap + extra;
        const state = { runningCount, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

test("invariant 8: dispatchBlockReason returns global_concurrency_cap when at limit", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 50 }),
      (cap) => {
        const issue = validIssue({
          state: "Todo",
          stateType: "unstarted",
          blockers: [],
          assignedToWorker: true,
        });
        const settings = makeSettings({ maxConcurrentAgents: cap });
        const state = { runningCount: cap, claimedSlots: new Set<string>() };
        assert.equal(dispatchBlockReason(issue, settings, state), "global_concurrency_cap");
      },
    ),
  );
});

// --- Invariant 9: Per-state concurrency cap reached -> SHALL not dispatch ---

test("invariant 9: per-state concurrency cap reached SHALL not dispatch new work in that state", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 20 }),
      fc.nat({ max: 5 }),
      (perStateCap, extra) => {
        const issue = validIssue({
          state: "Todo",
          stateType: "unstarted",
          blockers: [],
          assignedToWorker: true,
        });
        const settings = makeSettings({ maxConcurrentAgents: 100 });
        settings.statusOverrides.set("todo", { agent: { maxConcurrentAgents: perStateCap } });
        const runningByState = new Map([["Todo", perStateCap + extra]]);
        const state = { runningCount: 0, runningByState, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
        assert.equal(dispatchBlockReason(issue, settings, state), "local_concurrency_cap");
      },
    ),
  );
});

// --- Invariant 10: All ensemble slots claimed -> ineligible ---

test("invariant 10: all ensemble slots claimed SHALL make the dispatch ineligible", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 5 }),
      (ensembleSize) => {
        const issueId = "issue-ensemble";
        const issue = validIssue({
          id: issueId,
          state: "Todo",
          stateType: "unstarted",
          blockers: [],
          assignedToWorker: true,
        });
        const settings = makeSettings({ ensembleSize });
        const claimed = new Set<string>();
        for (let i = 0; i < ensembleSize; i++) {
          claimed.add(slotKey(issueId, i));
        }
        const state = { runningCount: 0, claimedSlots: claimed };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

test("invariant 10: ensemble label overrides settings and all slots claimed blocks dispatch", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2, max: 5 }),
      (ensembleSize) => {
        const issueId = "issue-ensemble-label";
        const issue = validIssue({
          id: issueId,
          state: "Todo",
          stateType: "unstarted",
          blockers: [],
          assignedToWorker: true,
          labels: [`ensemble:${ensembleSize}`],
        });
        // Set settings ensemble to 1 - but label overrides
        const settings = makeSettings({ ensembleSize: 1 });
        const claimed = new Set<string>();
        for (let i = 0; i < ensembleSize; i++) {
          claimed.add(slotKey(issueId, i));
        }
        const state = { runningCount: 0, claimedSlots: claimed };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
  );
});

test("invariant 10: partially claimed ensemble slots still allow dispatch", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2, max: 5 }),
      (ensembleSize) => {
        const issueId = "issue-partial-ensemble";
        const issue = validIssue({
          id: issueId,
          state: "Todo",
          stateType: "unstarted",
          blockers: [],
          assignedToWorker: true,
        });
        const settings = makeSettings({ ensembleSize });
        // Claim all but the last slot
        const claimed = new Set<string>();
        for (let i = 0; i < ensembleSize - 1; i++) {
          claimed.add(slotKey(issueId, i));
        }
        const state = { runningCount: 0, claimedSlots: claimed };
        assert.equal(shouldDispatchIssue(issue, settings, state), true);
      },
    ),
  );
});
