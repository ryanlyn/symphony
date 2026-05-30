import { test } from "vitest";
import fc from "fast-check";
import { defaultSettings, settingsForIssueState, parseConfig } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

// --- Helper arbitraries ---

/** Generates non-empty state names from safe characters (avoids blank after trim). */
const stateNameArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_- "), {
    minLength: 1,
    maxLength: 15,
  })
  .map((a) => a.join(""))
  .filter((s) => s.trim().length > 0);

/** Generates a positive integer suitable for timeout/concurrency fields. */
const positiveIntArb = fc.integer({ min: 1, max: 10_000_000 });

// ============================================================
// Invariant 1: When no override is present, the base settings
// SHALL remain unchanged.
// ============================================================

test("Invariant 1: no override present — base settings remain unchanged", () => {
  fc.assert(
    fc.property(stateNameArb, (state) => {
      // Create settings with empty statusOverrides (default)
      const settings = defaultSettings();
      // Ensure the map has no entry for any normalized state
      assert.equal(settings.statusOverrides.size, 0);

      const result = settingsForIssueState(settings, state);

      // Agent settings preserved
      assert.equal(result.agent.kind, settings.agent.kind);
      assert.equal(result.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);
      assert.equal(result.agent.maxTurns, settings.agent.maxTurns);
      assert.equal(result.agent.maxRetryBackoffMs, settings.agent.maxRetryBackoffMs);
      assert.equal(result.agent.ensembleSize, settings.agent.ensembleSize);

      // Codex settings preserved
      assert.equal(result.codex.command, settings.codex.command);
      assert.equal(result.codex.turnTimeoutMs, settings.codex.turnTimeoutMs);
      assert.equal(result.codex.readTimeoutMs, settings.codex.readTimeoutMs);
      assert.equal(result.codex.stallTimeoutMs, settings.codex.stallTimeoutMs);
      assert.equal(result.codex.threadSandbox, settings.codex.threadSandbox);

      // Claude settings preserved
      assert.equal(result.claude.command, settings.claude.command);
      assert.equal(result.claude.model, settings.claude.model);
      assert.equal(result.claude.permissionMode, settings.claude.permissionMode);
      assert.equal(result.claude.turnTimeoutMs, settings.claude.turnTimeoutMs);
      assert.equal(result.claude.stallTimeoutMs, settings.claude.stallTimeoutMs);
    }),
  );
});

test("Invariant 1: state present but NOT in overrides map — base settings remain unchanged", () => {
  fc.assert(
    fc.property(stateNameArb, positiveIntArb, (state, cap) => {
      const settings = defaultSettings();
      // Add an override for a DIFFERENT state
      settings.statusOverrides.set("__unrelated_state__", {
        agent: { maxConcurrentAgents: cap },
      });

      // Query a state that is NOT in the overrides map
      const normalizedQuery = state.trim().toLowerCase();
      if (normalizedQuery === "__unrelated_state__") return; // skip collision

      const result = settingsForIssueState(settings, state);

      // Should match base defaults
      assert.equal(result.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);
      assert.equal(result.codex.turnTimeoutMs, settings.codex.turnTimeoutMs);
      assert.equal(result.claude.model, settings.claude.model);
    }),
  );
});

// ============================================================
// Invariant 2: When override lookup is performed, it SHALL be
// case-insensitive.
// ============================================================

test("Invariant 2: override lookup is case-insensitive — upper/lower/mixed match", () => {
  fc.assert(
    fc.property(
      stateNameArb.filter((s) => /[a-z]/.test(s)),
      positiveIntArb,
      (state, maxTurns) => {
        const settings = defaultSettings();
        const normalizedKey = state.trim().toLowerCase();
        settings.statusOverrides.set(normalizedKey, {
          agent: { maxTurns },
        });

        // Look up with all-uppercase
        const upper = settingsForIssueState(settings, state.toUpperCase());
        assert.equal(upper.agent.maxTurns, maxTurns);

        // Look up with all-lowercase
        const lower = settingsForIssueState(settings, state.toLowerCase());
        assert.equal(lower.agent.maxTurns, maxTurns);

        // Look up with mixed case (first char upper, rest lower)
        const mixed = state.charAt(0).toUpperCase() + state.slice(1).toLowerCase();
        const mixedResult = settingsForIssueState(settings, mixed);
        assert.equal(mixedResult.agent.maxTurns, maxTurns);
      },
    ),
  );
});

test("Invariant 2: parseConfig normalizes state names in statusOverrides map keys", () => {
  fc.assert(
    fc.property(
      stateNameArb.filter((s) => /[a-z]/.test(s)),
      positiveIntArb,
      (state, maxTurns) => {
        // Use mixed case in the raw config
        const mixedCase = state.charAt(0).toUpperCase() + state.slice(1);
        const raw = {
          status_overrides: {
            [mixedCase]: {
              agent: { max_turns: maxTurns },
            },
          },
        };

        const settings = parseConfig(raw);
        // The key should be normalized (lowercased, trimmed) in the map
        const normalizedKey = state.trim().toLowerCase();
        const override = settings.statusOverrides.get(normalizedKey);
        assert.ok(override !== undefined);
        assert.equal(override!.agent?.maxTurns, maxTurns);
      },
    ),
  );
});

// ============================================================
// Invariant 3: When overrides are defined for different states,
// they SHALL apply independently.
// ============================================================

test("Invariant 3: overrides for different states apply independently", () => {
  fc.assert(
    fc.property(
      positiveIntArb,
      positiveIntArb,
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 51, max: 100 }),
      (timeoutA, timeoutB, turnsA, turnsB) => {
        const settings = defaultSettings();
        settings.statusOverrides.set("state_alpha", {
          agent: { maxTurns: turnsA },
          codex: { turnTimeoutMs: timeoutA },
        });
        settings.statusOverrides.set("state_beta", {
          agent: { maxTurns: turnsB },
          codex: { turnTimeoutMs: timeoutB },
        });

        const alpha = settingsForIssueState(settings, "state_alpha");
        const beta = settingsForIssueState(settings, "state_beta");

        // Each state gets its own override values
        assert.equal(alpha.agent.maxTurns, turnsA);
        assert.equal(alpha.codex.turnTimeoutMs, timeoutA);

        assert.equal(beta.agent.maxTurns, turnsB);
        assert.equal(beta.codex.turnTimeoutMs, timeoutB);

        // They don't bleed into each other
        if (turnsA !== turnsB) {
          assert.notEqual(alpha.agent.maxTurns, beta.agent.maxTurns);
        }
        if (timeoutA !== timeoutB) {
          assert.notEqual(alpha.codex.turnTimeoutMs, beta.codex.turnTimeoutMs);
        }
      },
    ),
  );
});

test("Invariant 3: one state override does not affect querying another state", () => {
  fc.assert(
    fc.property(positiveIntArb, (cap) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("overridden", {
        agent: { maxConcurrentAgents: cap },
      });

      // Query a state that has no override
      const unaffected = settingsForIssueState(settings, "not_overridden");
      // Should get the base default, not the override
      assert.equal(unaffected.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);

      // Query the overridden state
      const affected = settingsForIssueState(settings, "overridden");
      assert.equal(affected.agent.maxConcurrentAgents, cap);
    }),
  );
});

// ============================================================
// Invariant 4: When a partial override is applied, unmentioned
// fields SHALL be preserved.
// ============================================================

test("Invariant 4: partial agent override preserves unmentioned agent fields", () => {
  fc.assert(
    fc.property(positiveIntArb, (maxTurns) => {
      const settings = defaultSettings();
      // Only override maxTurns
      settings.statusOverrides.set("partial", {
        agent: { maxTurns },
      });

      const result = settingsForIssueState(settings, "partial");

      // Overridden field
      assert.equal(result.agent.maxTurns, maxTurns);

      // Unmentioned fields preserved from base
      assert.equal(result.agent.kind, settings.agent.kind);
      assert.equal(result.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);
      assert.equal(result.agent.maxRetryBackoffMs, settings.agent.maxRetryBackoffMs);
      assert.equal(result.agent.ensembleSize, settings.agent.ensembleSize);
    }),
  );
});

test("Invariant 4: partial codex override preserves unmentioned codex fields", () => {
  fc.assert(
    fc.property(positiveIntArb, (turnTimeoutMs) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("partial_codex", {
        codex: { turnTimeoutMs },
      });

      const result = settingsForIssueState(settings, "partial_codex");

      // Overridden field
      assert.equal(result.codex.turnTimeoutMs, turnTimeoutMs);

      // Unmentioned fields preserved
      assert.equal(result.codex.command, settings.codex.command);
      assert.equal(result.codex.readTimeoutMs, settings.codex.readTimeoutMs);
      assert.equal(result.codex.stallTimeoutMs, settings.codex.stallTimeoutMs);
      assert.equal(result.codex.threadSandbox, settings.codex.threadSandbox);
    }),
  );
});

test("Invariant 4: partial claude override preserves unmentioned claude fields", () => {
  fc.assert(
    fc.property(positiveIntArb, (turnTimeoutMs) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("partial_claude", {
        claude: { turnTimeoutMs },
      });

      const result = settingsForIssueState(settings, "partial_claude");

      // Overridden field
      assert.equal(result.claude.turnTimeoutMs, turnTimeoutMs);

      // Unmentioned fields preserved
      assert.equal(result.claude.command, settings.claude.command);
      assert.equal(result.claude.model, settings.claude.model);
      assert.equal(result.claude.permissionMode, settings.claude.permissionMode);
      assert.equal(result.claude.stallTimeoutMs, settings.claude.stallTimeoutMs);
      assert.equal(result.claude.strictMcpConfig, settings.claude.strictMcpConfig);
    }),
  );
});

test("Invariant 4: override with only agent section leaves codex and claude untouched", () => {
  fc.assert(
    fc.property(positiveIntArb, (maxTurns) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("agent_only", {
        agent: { maxTurns },
      });

      const result = settingsForIssueState(settings, "agent_only");

      // Codex entirely untouched
      assert.equal(result.codex.command, settings.codex.command);
      assert.equal(result.codex.turnTimeoutMs, settings.codex.turnTimeoutMs);
      assert.equal(result.codex.readTimeoutMs, settings.codex.readTimeoutMs);

      // Claude entirely untouched
      assert.equal(result.claude.command, settings.claude.command);
      assert.equal(result.claude.model, settings.claude.model);
      assert.equal(result.claude.turnTimeoutMs, settings.claude.turnTimeoutMs);
    }),
  );
});

// ============================================================
// Invariant 5: When nested map fields are overridden, they
// SHALL be deep-merged.
// ============================================================

test("Invariant 5: codex approvalPolicy deep-merged — override keys merge, base keys preserved", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), (sandboxApproval, rules) => {
      const settings = defaultSettings();
      // Base approvalPolicy is a map: { reject: { sandbox_approval: true, rules: true, mcp_elicitations: true } }
      settings.statusOverrides.set("deep_merge", {
        codex: {
          approvalPolicy: { reject: { sandbox_approval: sandboxApproval, rules } },
        },
      });

      const result = settingsForIssueState(settings, "deep_merge");
      const policy = result.codex.approvalPolicy;

      // Must be a record (deep-merged), not replaced wholesale
      assert.ok(typeof policy === "object" && policy !== null && !Array.isArray(policy));
      const policyMap = policy as Record<string, unknown>;
      const reject = policyMap.reject as Record<string, unknown>;
      assert.ok(reject !== undefined);

      // Overridden keys reflect the override values
      assert.equal(reject.sandbox_approval, sandboxApproval);
      assert.equal(reject.rules, rules);

      // Key NOT mentioned in override but present in base is preserved
      assert.equal(reject.mcp_elicitations, true);
    }),
  );
});

test("Invariant 5: codex turnSandboxPolicy deep-merged when both base and override are maps", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.string({ minLength: 1, maxLength: 10 }),
      (baseValue, overrideValue) => {
        const settings = defaultSettings();
        // Set base turnSandboxPolicy to a map
        settings.codex.turnSandboxPolicy = {
          baseKey: baseValue,
          sharedKey: "from_base",
        };
        settings.statusOverrides.set("sandbox_merge", {
          codex: {
            turnSandboxPolicy: { overrideKey: overrideValue, sharedKey: "from_override" },
          },
        });

        const result = settingsForIssueState(settings, "sandbox_merge");
        const policy = result.codex.turnSandboxPolicy;

        assert.ok(policy !== null && typeof policy === "object");
        const policyMap = policy as Record<string, unknown>;

        // Base-only key preserved
        assert.equal(policyMap.baseKey, baseValue);
        // Override-only key present
        assert.equal(policyMap.overrideKey, overrideValue);
        // Shared key takes override value (deep merge replaces leaf)
        assert.equal(policyMap.sharedKey, "from_override");
      },
    ),
  );
});

test("Invariant 5: deep merge via parseConfig round-trip preserves unmentioned nested keys", () => {
  fc.assert(
    fc.property(fc.boolean(), (mcp) => {
      const raw = {
        status_overrides: {
          "in progress": {
            codex: {
              approval_policy: {
                reject: { mcp_elicitations: mcp },
              },
            },
          },
        },
      };

      const settings = parseConfig(raw);
      const effective = settingsForIssueState(settings, "in progress");
      const policy = effective.codex.approvalPolicy as Record<string, unknown>;
      const reject = policy.reject as Record<string, unknown>;

      // Override value applied
      assert.equal(reject.mcp_elicitations, mcp);

      // Unmentioned keys from base default preserved
      assert.equal(reject.sandbox_approval, true);
      assert.equal(reject.rules, true);
    }),
  );
});
