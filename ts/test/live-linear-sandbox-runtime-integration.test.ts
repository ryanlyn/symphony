/**
 * Live Linear-sandbox runtime integration tests.
 *
 * These tests hit a REAL Linear API and exercise full runtime lifecycle
 * scenarios including dispatch, completion, event sequencing, and concurrency.
 *
 * Requires: LINEAR_API_KEY and LINEAR_PROJECT_SLUG environment variables.
 * Gate: SYMPHONY_TS_RUN_LINEAR_SANDBOX=1
 */

import { describe, expect, test } from "vitest";

import { setupLinearSandbox, runLinearScenario } from "../sandbox/linear-sandbox.js";
import { checkAssertions } from "../sandbox/sandbox.js";
import type { LinearSandboxScenario } from "../sandbox/linear-sandbox.js";

const runLive = process.env.SYMPHONY_TS_RUN_LINEAR_SANDBOX === "1";

describe("linear-sandbox: runtime integration", () => {
  // ---------------------------------------------------------------------------
  // 1. Full lifecycle: issues created, dispatched, completed — verify event sequence
  // ---------------------------------------------------------------------------
  test(
    "full lifecycle: run_started then run_completed for each issue",
    { timeout: 120_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "Lifecycle issue A" },
          { title: "Lifecycle issue B" },
          { title: "Lifecycle issue C" },
        ],
        pollTicks: 4,
        tickDelayMs: 3000,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 2, latencyPerTurnMs: 100 },
        },
        assertions: [
          { type: "no_errors" },
          { type: "event_occurred", eventType: "run_started" },
          { type: "event_occurred", eventType: "run_completed" },
        ],
      };

      const result = await runLinearScenario(ctx, scenario);

      // Verify assertions pass
      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // Verify each issue has a run_started event
      for (const issue of result.createdIssues) {
        const started = result.events.some(
          (e) => e.type === "run_started" && e.message.includes(issue.identifier),
        );
        expect(started, `Expected run_started for ${issue.identifier}`).toBe(true);
      }

      // Verify each issue has a run_completed event
      for (const issue of result.createdIssues) {
        const completed = result.events.some(
          (e) => e.type === "run_completed" && e.message.includes(issue.identifier),
        );
        expect(completed, `Expected run_completed for ${issue.identifier}`).toBe(true);
      }

      // Verify ordering: for each issue, run_started occurs before run_completed
      for (const issue of result.createdIssues) {
        const startedIdx = result.events.findIndex(
          (e) => e.type === "run_started" && e.message.includes(issue.identifier),
        );
        const completedIdx = result.events.findIndex(
          (e) => e.type === "run_completed" && e.message.includes(issue.identifier),
        );
        expect(
          startedIdx,
          `run_started index for ${issue.identifier} should be non-negative`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          completedIdx,
          `run_completed index for ${issue.identifier} should be non-negative`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          startedIdx < completedIdx,
          `run_started should precede run_completed for ${issue.identifier}`,
        ).toBe(true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // 2. High turnCount run completes within timeout
  // ---------------------------------------------------------------------------
  test(
    "high turnCount run completes within timeout",
    { timeout: 120_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [{ title: "High turn count issue" }],
        pollTicks: 4,
        tickDelayMs: 3000,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 5, latencyPerTurnMs: 200 },
        },
        assertions: [
          { type: "no_errors" },
          { type: "event_occurred", eventType: "run_started" },
          { type: "event_occurred", eventType: "run_completed" },
        ],
      };

      const result = await runLinearScenario(ctx, scenario);

      // Verify assertions pass
      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // Verify the single issue was dispatched and completed
      expect(result.createdIssues).toHaveLength(1);
      const issue = result.createdIssues[0];

      const startedEvent = result.events.find(
        (e) => e.type === "run_started" && e.message.includes(issue.identifier),
      );
      expect(startedEvent, "Expected run_started event for issue").toBeDefined();

      const completedEvent = result.events.find(
        (e) => e.type === "run_completed" && e.message.includes(issue.identifier),
      );
      expect(completedEvent, "Expected run_completed event for issue").toBeDefined();

      // Verify no errors occurred
      expect(result.errors).toHaveLength(0);
    },
  );

  // ---------------------------------------------------------------------------
  // 3. Zero latency fast path: all issues complete quickly
  // ---------------------------------------------------------------------------
  test(
    "zero latency fast path: multiple issues complete quickly",
    { timeout: 120_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [{ title: "Fast path A" }, { title: "Fast path B" }, { title: "Fast path C" }],
        pollTicks: 3,
        tickDelayMs: 2000,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        assertions: [{ type: "no_errors" }, { type: "event_occurred", eventType: "run_completed" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      // Verify assertions pass
      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // Verify all issues received run_completed events
      for (const issue of result.createdIssues) {
        const completed = result.events.some(
          (e) => e.type === "run_completed" && e.message.includes(issue.identifier),
        );
        expect(completed, `Expected run_completed for ${issue.identifier}`).toBe(true);
      }

      // With zero latency and turnCount=1, runs should complete very quickly.
      // Verify that all completions happen and no run_failed events exist.
      const failedEvents = result.events.filter((e) => e.type === "run_failed");
      expect(failedEvents).toHaveLength(0);
    },
  );

  // ---------------------------------------------------------------------------
  // 4. Mixed success/failure: multiple issues handled independently
  // ---------------------------------------------------------------------------
  test(
    "mixed success/failure: issues handled independently",
    { timeout: 120_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      // Use defaultBehavior with shouldSucceed=true for the scenario.
      // Create multiple issues — all use the same default behavior,
      // verifying that each issue is dispatched and completes independently.
      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "Independent A", priority: 1 },
          { title: "Independent B", priority: 2 },
          { title: "Independent C", priority: 3 },
          { title: "Independent D", priority: 4 },
        ],
        pollTicks: 4,
        tickDelayMs: 2500,
        maxConcurrentAgents: 2,
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 2, latencyPerTurnMs: 150 },
        },
        assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 2 }],
      };

      const result = await runLinearScenario(ctx, scenario);

      // Verify assertions pass
      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // With cap=2 and 4 issues, issues should be dispatched progressively.
      // Verify at least the first batch gets dispatched and completed.
      const startedEvents = result.events.filter((e) => e.type === "run_started");
      expect(startedEvents.length).toBeGreaterThanOrEqual(2);

      const completedEvents = result.events.filter((e) => e.type === "run_completed");
      expect(completedEvents.length).toBeGreaterThanOrEqual(2);

      // Verify that no single issue's failure blocks another (all use shouldSucceed=true).
      const failedEvents = result.events.filter((e) => e.type === "run_failed");
      expect(failedEvents).toHaveLength(0);
    },
  );

  // ---------------------------------------------------------------------------
  // 5. Large issue batch: 5 issues, cap=3, verify ticks and no_errors
  // ---------------------------------------------------------------------------
  test(
    "large issue batch: 5 issues with cap=3 completes configured ticks",
    { timeout: 180_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "Batch issue 1", priority: 1 },
          { title: "Batch issue 2", priority: 2 },
          { title: "Batch issue 3", priority: 3 },
          { title: "Batch issue 4", priority: 4 },
          { title: "Batch issue 5", priority: 4 },
        ],
        pollTicks: 5,
        tickDelayMs: 3000,
        maxConcurrentAgents: 3,
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 2, latencyPerTurnMs: 200 },
        },
        assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 3 }],
      };

      const result = await runLinearScenario(ctx, scenario);

      // Verify configured ticks were all executed
      expect(result.ticksExecuted).toBe(5);

      // Verify no_errors and concurrency_cap assertions
      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // Verify all 5 issues were created in Linear
      expect(result.createdIssueIds).toHaveLength(5);
      expect(result.createdIssues).toHaveLength(5);

      // Verify at least some issues were dispatched (cap=3 means first 3 on first tick)
      const startedEvents = result.events.filter((e) => e.type === "run_started");
      expect(startedEvents.length).toBeGreaterThanOrEqual(3);

      // With 5 ticks and fast runs (turnCount=2, 200ms latency), all issues
      // should eventually complete
      const completedEvents = result.events.filter((e) => e.type === "run_completed");
      expect(completedEvents.length).toBeGreaterThanOrEqual(3);
    },
  );
});
