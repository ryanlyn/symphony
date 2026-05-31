import { describe, expect, test } from "vitest";
import type { Issue } from "@symphony/cli";
import type { RuntimeEvent } from "@symphony/runtime";

import { setupLinearSandbox, runLinearScenario } from "../sandbox/linear-sandbox.js";
import { checkAssertions } from "../sandbox/sandbox.js";
import type { LinearSandboxScenario, LinearSandboxResult } from "../sandbox/linear-sandbox.js";

const runLive = process.env.SYMPHONY_TS_RUN_LINEAR_SANDBOX === "1";

/** Count run_started events for a specific issue by matching its identifier in the event message. */
function countStartsForIssue(result: LinearSandboxResult, issue: Issue): number {
  return result.events.filter(
    (e: RuntimeEvent) => e.type === "run_started" && e.message.includes(issue.identifier),
  ).length;
}

describe("linear-sandbox: retry and backoff", () => {
  test(
    "failed issue is retried across poll ticks",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: a failed run triggers run_failed, and the issue is retried
      // (run_started emitted multiple times) across subsequent poll ticks.
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [{ title: "Retry on failure target" }],
        pollTicks: 5,
        tickDelayMs: 3000,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: {
            shouldSucceed: false,
            errorMessage: "transient network error",
            turnCount: 1,
            latencyPerTurnMs: 100,
          },
        },
        assertions: [
          { type: "event_occurred", eventType: "run_failed" },
          { type: "event_occurred", eventType: "run_started" },
        ],
      };

      const result = await runLinearScenario(ctx, scenario);

      // Verify assertions pass
      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // The issue should have been started multiple times (initial + retries)
      const startEvents = result.events.filter((e) => e.type === "run_started");
      expect(startEvents.length).toBeGreaterThanOrEqual(2);

      // Verify the specific issue was retried using identifier-based matching
      const issueStarts = countStartsForIssue(result, result.createdIssues[0]);
      expect(issueStarts).toBeGreaterThanOrEqual(2);

      // Each start should correspond to a failure (since shouldSucceed=false)
      const failEvents = result.events.filter((e) => e.type === "run_failed");
      expect(failEvents.length).toBeGreaterThanOrEqual(1);

      // The number of starts should be >= failures (each failure eventually retries)
      expect(startEvents.length).toBeGreaterThanOrEqual(failEvents.length);
    },
  );

  test(
    "continuation retry re-dispatches a successfully completed issue",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: a successful run with turnCount=1 triggers continuation retry,
      // meaning the issue is re-dispatched (run_started emitted again) on subsequent ticks.
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [{ title: "Continuation retry subject" }],
        pollTicks: 5,
        tickDelayMs: 2500,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: {
            shouldSucceed: true,
            turnCount: 1,
            latencyPerTurnMs: 100,
          },
        },
        assertions: [{ type: "no_errors" }, { type: "event_occurred", eventType: "run_started" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // With continuation retries enabled and 5 ticks, the issue should be
      // dispatched multiple times as each successful completion triggers a re-run
      const startEvents = result.events.filter((e) => e.type === "run_started");
      expect(startEvents.length).toBeGreaterThanOrEqual(2);

      // There should be no run_failed events since all runs succeed
      const failEvents = result.events.filter((e) => e.type === "run_failed");
      expect(failEvents).toHaveLength(0);
    },
  );

  test(
    "retry respects backoff by limiting dispatch frequency",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: backoff prevents immediate re-dispatch after failure.
      // With short total time (few ticks, moderate delay), the number of retries
      // should be bounded -- not every tick produces a new run_started.
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [{ title: "Backoff limited issue" }],
        pollTicks: 4,
        tickDelayMs: 2500,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: {
            shouldSucceed: false,
            errorMessage: "persistent failure for backoff test",
            turnCount: 1,
            latencyPerTurnMs: 100,
          },
        },
        assertions: [{ type: "event_occurred", eventType: "run_failed" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // With backoff, the number of run_started events should be limited.
      // Without backoff, we'd see one attempt per tick (4 starts for 4 ticks).
      // With exponential backoff and maxRetryBackoffMs=5000, later retries are delayed
      // so we expect fewer than pollTicks total attempts.
      const startEvents = result.events.filter((e) => e.type === "run_started");
      const failEvents = result.events.filter((e) => e.type === "run_failed");

      // At minimum the issue was dispatched once (the initial attempt)
      expect(startEvents.length).toBeGreaterThanOrEqual(1);

      // Backoff should prevent retrying on every single tick.
      // With 4 ticks at 2500ms each (10s total) and maxRetryBackoffMs=5000,
      // exponential backoff means we should see at most 3 starts (initial + 2 retries)
      expect(startEvents.length).toBeLessThanOrEqual(3);

      // Verify failures happened
      expect(failEvents.length).toBeGreaterThanOrEqual(1);
    },
  );

  test(
    "multiple failing issues do not crash the orchestrator",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: even when all issues fail, the orchestrator's errors array
      // remains empty (run failures are events, not orchestrator errors).
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "All-fail issue A" },
          { title: "All-fail issue B" },
          { title: "All-fail issue C" },
        ],
        pollTicks: 4,
        tickDelayMs: 2500,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: {
            shouldSucceed: false,
            errorMessage: "every issue fails in this scenario",
            turnCount: 1,
            latencyPerTurnMs: 100,
          },
        },
        assertions: [{ type: "no_errors" }, { type: "event_occurred", eventType: "run_failed" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // The errors array on the result should be empty -- run failures are
      // captured as events, not as orchestrator-level errors
      expect(result.errors).toHaveLength(0);

      // All issues completed their ticks without crashing
      expect(result.ticksExecuted).toBe(4);

      // There should be run_failed events for each issue that was attempted
      const failEvents = result.events.filter((e) => e.type === "run_failed");
      expect(failEvents.length).toBeGreaterThanOrEqual(3);

      // Each issue should have been started at least once
      const startEvents = result.events.filter((e) => e.type === "run_started");
      expect(startEvents.length).toBeGreaterThanOrEqual(3);
    },
  );

  test(
    "failed issue retries do not exceed retry cap",
    { timeout: 180_000, skip: !runLive },
    async () => {
      // Invariant: retries are capped so an issue cannot retry indefinitely.
      // Over many ticks, the retry count should plateau once the cap is reached.
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [{ title: "Retry cap subject" }],
        pollTicks: 5,
        tickDelayMs: 3000,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: {
            shouldSucceed: false,
            errorMessage: "failure to test retry cap",
            turnCount: 1,
            latencyPerTurnMs: 100,
          },
        },
        assertions: [{ type: "event_occurred", eventType: "run_failed" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // Count total run_started events for this issue
      const startEvents = result.events.filter((e) => e.type === "run_started");

      // The retry cap (configured at maxRetryBackoffMs=5000 with exponential backoff)
      // combined with the total scenario time (5 ticks * 3000ms = 15s) should
      // result in a bounded number of attempts. We verify it does not exceed
      // a reasonable upper bound (initial + retries with backoff).
      expect(startEvents.length).toBeGreaterThanOrEqual(1);
      expect(startEvents.length).toBeLessThanOrEqual(5);

      // Verify we got failures
      const failEvents = result.events.filter((e) => e.type === "run_failed");
      expect(failEvents.length).toBeGreaterThanOrEqual(1);
      expect(failEvents.length).toBeLessThanOrEqual(startEvents.length);
    },
  );
});
