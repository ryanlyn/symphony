import { test } from "vitest";
import fc from "fast-check";
import { unsafeBrand } from "@symphony/domain";
import type { Concurrency, PositiveTimeoutMs } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import {
  normalizeStateName,
  normalizeRouteName,
  defaultSettings,
  settingsForIssueState,
  parseConfig,
} from "@symphony/config";

// --- normalizeStateName ---

test("normalizeStateName — idempotent", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 30 }), (input) => {
      const once = normalizeStateName(input);
      const twice = normalizeStateName(once);
      assert.equal(twice, once);
    }),
  );
});

test("normalizeStateName — case folding", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (input) => {
      assert.equal(
        normalizeStateName(input.toUpperCase()),
        normalizeStateName(input.toLowerCase()),
      );
    }),
  );
});

test("normalizeStateName — trims whitespace", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (input) => {
      assert.equal(normalizeStateName(`  ${input}  `), normalizeStateName(input));
    }),
  );
});

// --- normalizeRouteName ---

test("normalizeRouteName — null and undefined produce empty string", () => {
  fc.assert(
    fc.property(fc.oneof(fc.constant(null), fc.constant(undefined)), (input) => {
      assert.equal(normalizeRouteName(input), "");
    }),
  );
});

test("normalizeRouteName — idempotent", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 30 }), (input) => {
      const once = normalizeRouteName(input);
      const twice = normalizeRouteName(once);
      assert.equal(twice, once);
    }),
  );
});

test("normalizeRouteName — case folding", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (input) => {
      assert.equal(
        normalizeRouteName(input.toUpperCase()),
        normalizeRouteName(input.toLowerCase()),
      );
    }),
  );
});

test("normalizeRouteName — trims whitespace", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (input) => {
      assert.equal(normalizeRouteName(`  ${input}  `), normalizeRouteName(input));
    }),
  );
});

// --- settingsForIssueState with status overrides ---

test("settingsForIssueState — no override returns base settings unchanged", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnop"), { minLength: 1, maxLength: 10 })
        .map((a) => a.join("")),
      (state) => {
        const settings = defaultSettings();
        const result = settingsForIssueState(settings, state);
        assert.equal(result.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);
        assert.equal(result.codex.turnTimeoutMs, settings.codex.turnTimeoutMs);
      },
    ),
  );
});

test("settingsForIssueState — state name lookup is case insensitive", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghij"), { minLength: 1, maxLength: 10 })
        .map((a) => a.join("")),
      fc.integer({ min: 1, max: 5 }).map((n) => unsafeBrand<Concurrency>(n)),
      (state, cap) => {
        const settings = defaultSettings();
        settings.statusOverrides.set(state.toLowerCase(), {
          agent: { maxConcurrentAgents: cap },
        });
        const upper = settingsForIssueState(settings, state.toUpperCase());
        const lower = settingsForIssueState(settings, state.toLowerCase());
        assert.equal(upper.agent.maxConcurrentAgents, cap);
        assert.equal(lower.agent.maxConcurrentAgents, cap);
      },
    ),
  );
});

test("settingsForIssueState — override isolation between states", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10 }).map((n) => unsafeBrand<Concurrency>(n)),
      fc.integer({ min: 11, max: 20 }).map((n) => unsafeBrand<Concurrency>(n)),
      (capA, capB) => {
        const settings = defaultSettings();
        settings.statusOverrides.set("todo", { agent: { maxConcurrentAgents: capA } });
        settings.statusOverrides.set("review", { agent: { maxConcurrentAgents: capB } });
        const todo = settingsForIssueState(settings, "Todo");
        const review = settingsForIssueState(settings, "Review");
        assert.equal(todo.agent.maxConcurrentAgents, capA);
        assert.equal(review.agent.maxConcurrentAgents, capB);
      },
    ),
  );
});

test("settingsForIssueState — partial override preserves unmentioned fields", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100_000, max: 9_000_000 }).map((n) => unsafeBrand<PositiveTimeoutMs>(n)),
      (timeout) => {
        const settings = defaultSettings();
        settings.statusOverrides.set("review", { codex: { turnTimeoutMs: timeout } });
        const result = settingsForIssueState(settings, "review");
        assert.equal(result.codex.turnTimeoutMs, timeout);
        assert.equal(result.codex.readTimeoutMs, settings.codex.readTimeoutMs);
        assert.equal(result.codex.stallTimeoutMs, settings.codex.stallTimeoutMs);
      },
    ),
  );
});

// --- parseConfig deep merge for status_overrides ---

test("parseConfig — status_overrides deep merges codex approval_policy", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), (sandbox, rules) => {
      const raw = {
        tracker: { kind: "memory", project_slug: "test" },
        status_overrides: {
          "in progress": {
            codex: {
              approval_policy: {
                reject: { sandbox_approval: sandbox, rules },
              },
            },
          },
        },
      };
      const settings = parseConfig(raw);
      const effective = settingsForIssueState(settings, "in progress");
      const policy = effective.codex.approvalPolicy as Record<string, unknown> | null;
      assert.ok(policy !== null && typeof policy === "object");
      const reject = (policy as { reject?: Record<string, unknown> }).reject;
      assert.ok(reject !== undefined);
      assert.equal(reject!.sandbox_approval, sandbox);
      assert.equal(reject!.rules, rules);
    }),
  );
});
