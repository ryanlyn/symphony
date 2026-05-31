import { describe, expect, test } from "vitest";

import { setupLinearSandbox, runLinearScenario } from "../sandbox/linear-sandbox.js";
import { checkAssertions } from "../sandbox/sandbox.js";
import type { LinearSandboxScenario } from "../sandbox/linear-sandbox.js";

const runLive = process.env.SYMPHONY_TS_RUN_LINEAR_SANDBOX === "1";

describe("linear-sandbox: state transition scenarios", () => {
  test(
    "issue already in Done state is never dispatched",
    { timeout: 120_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      // Create an issue directly in the Done state
      const marker = `done-skip-${Date.now()}`;
      const doneIssue = await ctx.client.createIssue({
        teamId: ctx.team.id,
        projectId: ctx.project.id,
        stateId: ctx.states.done.id,
        title: `[${marker}] Already done issue`,
        description: "This issue starts in Done and should never be dispatched",
        assigneeId: ctx.viewerId,
      });

      try {
        // Run scenario with no pre-created issues (empty array).
        // The runtime should see the Done issue during polling but skip it.
        const scenario: LinearSandboxScenario = {
          issues: [],
          pollTicks: 3,
          tickDelayMs: 2000,
          maxConcurrentAgents: 5,
          runnerConfig: {
            defaultBehavior: { turnCount: 1, latencyPerTurnMs: 100 },
          },
          assertions: [],
        };

        const result = await runLinearScenario(ctx, scenario);

        // Verify the Done issue's identifier never appears in run_started events
        const dispatchesForDoneIssue = result.events.filter(
          (e) => e.type === "run_started" && e.message.includes(doneIssue.identifier),
        );
        expect(dispatchesForDoneIssue).toHaveLength(0);
      } finally {
        await ctx.client.archiveIssue(doneIssue.id).catch(() => {});
      }
    },
  );

  test("issue in Todo state IS dispatched", { timeout: 120_000, skip: !runLive }, async () => {
    const ctx = await setupLinearSandbox();

    // Use the standard scenario flow: issues created in Todo state by default
    const scenario: LinearSandboxScenario = {
      issues: [{ title: "Todo dispatch target" }],
      pollTicks: 3,
      tickDelayMs: 2000,
      maxConcurrentAgents: 5,
      runnerConfig: {
        defaultBehavior: { turnCount: 1, latencyPerTurnMs: 100 },
      },
      assertions: [{ type: "no_errors" }],
    };

    const result = await runLinearScenario(ctx, scenario);

    const assertionResults = checkAssertions(result, scenario.assertions!);
    for (const r of assertionResults) {
      expect(r.passed, r.message).toBe(true);
    }

    // Verify run_started fires for this issue
    const startEvents = result.events.filter((e) => e.type === "run_started");
    expect(startEvents.length).toBeGreaterThan(0);

    // Verify our specific issue was dispatched (its title is prefixed with marker)
    const dispatched = startEvents.some((e) => e.message.includes("Todo dispatch target"));
    expect(dispatched).toBe(true);
  });

  test(
    "issue moved to Done before scenario runs is not dispatched",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Create an issue in Todo, immediately move it to Done, then run the scenario.
      // The runtime should see it as Done and never dispatch it.
      const ctx = await setupLinearSandbox();

      const marker = `moved-done-${Date.now()}`;
      const issue = await ctx.client.createIssue({
        teamId: ctx.team.id,
        projectId: ctx.project.id,
        stateId: ctx.states.todo.id,
        title: `[${marker}] Moved to Done before run`,
        description: "Created in Todo then moved to Done before polling starts",
        assigneeId: ctx.viewerId,
      });

      try {
        // Move to Done immediately
        await ctx.client.updateIssueState(issue.id, ctx.states.done.id);

        // Run scenario with empty issues array and enough ticks to detect any errant dispatch
        const scenario: LinearSandboxScenario = {
          issues: [],
          pollTicks: 3,
          tickDelayMs: 2000,
          maxConcurrentAgents: 5,
          runnerConfig: {
            defaultBehavior: { turnCount: 1, latencyPerTurnMs: 100 },
          },
          assertions: [],
        };

        const result = await runLinearScenario(ctx, scenario);

        // Verify zero dispatches for the issue that was moved to Done
        const dispatchesForIssue = result.events.filter(
          (e) => e.type === "run_started" && e.message.includes(issue.identifier),
        );
        expect(dispatchesForIssue).toHaveLength(0);
      } finally {
        await ctx.client.archiveIssue(issue.id).catch(() => {});
      }
    },
  );

  test(
    "mixed states: only Todo issue is dispatched, Done issue is skipped",
    { timeout: 120_000, skip: !runLive },
    async () => {
      const ctx = await setupLinearSandbox();

      const marker = `mixed-${Date.now()}`;

      // Create one issue in Done state (should be skipped)
      const doneIssue = await ctx.client.createIssue({
        teamId: ctx.team.id,
        projectId: ctx.project.id,
        stateId: ctx.states.done.id,
        title: `[${marker}] Already done - skip me`,
        description: "In Done state, must not be dispatched",
        assigneeId: ctx.viewerId,
      });

      // Create one issue in Todo state (should be dispatched)
      const todoIssue = await ctx.client.createIssue({
        teamId: ctx.team.id,
        projectId: ctx.project.id,
        stateId: ctx.states.todo.id,
        title: `[${marker}] In Todo - dispatch me`,
        description: "In Todo state, should be dispatched",
        assigneeId: ctx.viewerId,
      });

      try {
        // Run scenario with no scenario-created issues; we rely on manually created ones
        const scenario: LinearSandboxScenario = {
          issues: [],
          pollTicks: 3,
          tickDelayMs: 2000,
          maxConcurrentAgents: 5,
          runnerConfig: {
            defaultBehavior: { turnCount: 1, latencyPerTurnMs: 100 },
          },
          assertions: [],
        };

        const result = await runLinearScenario(ctx, scenario);

        // The Done issue should NOT have been dispatched
        const doneDispatches = result.events.filter(
          (e) => e.type === "run_started" && e.message.includes(doneIssue.identifier),
        );
        expect(doneDispatches).toHaveLength(0);

        // The Todo issue SHOULD have been dispatched
        const todoDispatches = result.events.filter(
          (e) => e.type === "run_started" && e.message.includes(todoIssue.identifier),
        );
        expect(todoDispatches.length).toBeGreaterThan(0);
      } finally {
        await ctx.client.archiveIssue(doneIssue.id).catch(() => {});
        await ctx.client.archiveIssue(todoIssue.id).catch(() => {});
      }
    },
  );
});
