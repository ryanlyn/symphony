import { describe, expect, test } from "vitest";
import type { Issue } from "@symphony/cli";
import type { RuntimeEvent } from "@symphony/runtime";

import { setupLinearSandbox, runLinearScenario } from "../sandbox/linear-sandbox.js";
import { checkAssertions } from "../sandbox/sandbox.js";
import type { LinearSandboxScenario, LinearSandboxResult } from "../sandbox/linear-sandbox.js";

const runLive = process.env.SYMPHONY_TS_RUN_LINEAR_SANDBOX === "1";

/** Map an issue identifier from a run_started event to its title via createdIssues. */
function issueForEvent(event: RuntimeEvent, createdIssues: Issue[]): Issue | undefined {
  return createdIssues.find((i) => event.message.startsWith(i.identifier));
}

/** Get ordered titles from run_started events using the issue identifier -> title mapping. */
function dispatchedTitles(result: LinearSandboxResult): string[] {
  return result.events
    .filter((e) => e.type === "run_started")
    .map((e) => issueForEvent(e, result.createdIssues)?.title ?? "")
    .filter(Boolean);
}

describe("linear-sandbox: concurrency", () => {
  test(
    "strict cap=1 never exceeds one concurrent dispatch across 3 issues",
    { timeout: 120_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "Cap1 issue A", priority: 1 },
          { title: "Cap1 issue B", priority: 2 },
          { title: "Cap1 issue C", priority: 3 },
        ],
        pollTicks: 4,
        tickDelayMs: 2500,
        maxConcurrentAgents: 1,
        runnerConfig: {
          defaultBehavior: { turnCount: 2, latencyPerTurnMs: 500 },
        },
        assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 1 }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // Verify at least one issue was dispatched
      const startEvents = result.events.filter((e) => e.type === "run_started");
      expect(startEvents.length).toBeGreaterThanOrEqual(1);
    },
  );

  test(
    "cap=3 with 5 issues never exceeds 3 concurrent dispatches",
    { timeout: 120_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "Cap3 issue A", priority: 1 },
          { title: "Cap3 issue B", priority: 2 },
          { title: "Cap3 issue C", priority: 3 },
          { title: "Cap3 issue D", priority: 4 },
          { title: "Cap3 issue E", priority: 4 },
        ],
        pollTicks: 4,
        tickDelayMs: 2500,
        maxConcurrentAgents: 3,
        runnerConfig: {
          defaultBehavior: { turnCount: 3, latencyPerTurnMs: 600 },
        },
        assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 3 }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // Verify multiple issues were dispatched
      const startEvents = result.events.filter((e) => e.type === "run_started");
      expect(startEvents.length).toBeGreaterThanOrEqual(3);
    },
  );

  test(
    "all issues eventually dispatched under cap=2 with fast-finishing runs",
    { timeout: 180_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "FastAll issue A", priority: 1 },
          { title: "FastAll issue B", priority: 2 },
          { title: "FastAll issue C", priority: 3 },
          { title: "FastAll issue D", priority: 4 },
        ],
        pollTicks: 5,
        tickDelayMs: 2500,
        maxConcurrentAgents: 2,
        runnerConfig: {
          defaultBehavior: { turnCount: 1, latencyPerTurnMs: 200 },
        },
        assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 2 }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // All 4 unique issue titles should appear in run_started events
      const titles = dispatchedTitles(result);
      const uniqueIssueNames = new Set(
        titles.map((t) => {
          const match = t.match(/(FastAll issue [ABCD])/);
          return match?.[1];
        }),
      );
      expect(uniqueIssueNames.size).toBe(4);
    },
  );

  test(
    "high cap dispatches all issues immediately when cap >= issue count",
    { timeout: 120_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "HighCap issue A" },
          { title: "HighCap issue B" },
          { title: "HighCap issue C" },
        ],
        pollTicks: 2,
        tickDelayMs: 2000,
        maxConcurrentAgents: 10,
        runnerConfig: {
          defaultBehavior: { turnCount: 2, latencyPerTurnMs: 300 },
        },
        assertions: [{ type: "no_errors" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // With cap=10 and only 3 issues, all should dispatch within the first ticks
      const startEvents = result.events.filter((e) => e.type === "run_started");
      expect(startEvents.length).toBeGreaterThanOrEqual(3);

      // Verify all 3 unique issues were dispatched
      const titles = dispatchedTitles(result);
      const uniqueIssueNames = new Set(
        titles.map((t) => {
          const match = t.match(/(HighCap issue [ABC])/);
          return match?.[1];
        }),
      );
      expect(uniqueIssueNames.size).toBe(3);
    },
  );

  test(
    "mixed priorities under cap=2 dispatches highest priority issues first",
    { timeout: 120_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "MixPri low", priority: 4 },
          { title: "MixPri urgent", priority: 1 },
          { title: "MixPri medium", priority: 3 },
          { title: "MixPri high", priority: 2 },
        ],
        pollTicks: 3,
        tickDelayMs: 2500,
        maxConcurrentAgents: 2,
        runnerConfig: {
          defaultBehavior: { turnCount: 3, latencyPerTurnMs: 600 },
        },
        assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 2 }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // First two dispatched should be priority 1 (urgent) and priority 2 (high)
      const titles = dispatchedTitles(result);
      expect(titles.length).toBeGreaterThanOrEqual(2);

      const firstTwo = titles.slice(0, 2);
      const hasUrgent = firstTwo.some((t) => t.includes("MixPri urgent"));
      const hasHigh = firstTwo.some((t) => t.includes("MixPri high"));
      expect(hasUrgent).toBe(true);
      expect(hasHigh).toBe(true);
    },
  );
});
