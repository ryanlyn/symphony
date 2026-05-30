import { test } from "vitest";
import fc from "fast-check";
import { buildPrompt } from "@symphony/prompt";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { parseWorkflowContent } from "@symphony/workflow";

// --- Helpers ---

/**
 * Constructs a minimal valid Issue for use with buildPrompt.
 */
function minimalIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Test Issue",
    state: "Todo",
    stateType: null,
    description: null,
    branchName: null,
    url: null,
    priority: null,
    createdAt: null,
    updatedAt: null,
    labels: [],
    blockers: [],
    assigneeId: null,
    assignedToWorker: true,
    ...overrides,
  };
}

/**
 * Wraps a YAML scalar/array/value into front matter delimiters so that
 * parseWorkflowContent parses it as YAML.
 */
function wrapFrontMatter(yamlContent: string, body = ""): string {
  return `---\n${yamlContent}\n---\n${body}`;
}

// --- Arbitrary generators ---

/** Generates YAML scalars that are NOT maps: strings, numbers, booleans, arrays. */
const nonMapYamlArb = fc.oneof(
  // Plain strings that YAML will parse as scalars
  fc.constantFrom("hello", "true", "false", "null", "42", "3.14", "~"),
  // Integers as YAML scalars
  fc.integer({ min: -1000, max: 1000 }).map(String),
  // Floats as YAML scalars
  fc.double({ min: -1000, max: 1000, noNaN: true }).map(String),
  // YAML arrays: [a, b, c]
  fc
    .array(fc.constantFrom("a", "1", "true", "null"), { minLength: 1, maxLength: 5 })
    .map((items) => `[${items.join(", ")}]`),
  // YAML flow sequence on its own line
  fc
    .array(fc.constantFrom("x", "y", "z"), { minLength: 1, maxLength: 3 })
    .map((items) => `- ${items.join("\n- ")}`),
);

/**
 * Generates variable names that are NOT part of the standard Liquid context
 * provided by buildPrompt (which only exposes: issue, attempt, ensemble).
 */
const alphaChars = "abcdefghijklmnopqrstuvwxyz".split("");
const unknownVariableNameArb = fc
  .array(fc.constantFrom(...alphaChars), { minLength: 1, maxLength: 15 })
  .map((chars) => chars.join(""))
  .filter((name) => !["issue", "attempt", "ensemble"].includes(name));

// --- Invariant 1: YAML front matter not a map produces a typed error ---

test("invariant 1: parseWorkflowContent SHALL produce a typed error when YAML front matter is not a map", () => {
  fc.assert(
    fc.property(nonMapYamlArb, fc.string({ maxLength: 50 }), (yamlValue, body) => {
      const content = wrapFrontMatter(yamlValue, body);
      let threw = false;
      let errorMessage = "";
      try {
        parseWorkflowContent(content);
      } catch (err: unknown) {
        threw = true;
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      // The system SHALL produce a typed error (either parse error or not-a-map error)
      // when the YAML front matter resolves to a non-map value.
      // Some scalar strings may parse as valid YAML maps (unlikely with our generators),
      // but any non-map parse result must throw.
      if (threw) {
        // The error must be one of the two workflow-specific errors
        const isTypedError =
          errorMessage.includes("workflow_front_matter_not_a_map") ||
          errorMessage.includes("workflow_parse_error");
        assert.ok(isTypedError);
      }
      // If it did not throw, it means YAML parsed the content as a valid map
      // (e.g. "hello" can become {hello: null} in YAML block context) - that's acceptable.
      // The invariant is: when it IS not a map, it SHALL error. So we verify the result
      // if it didn't throw.
      if (!threw) {
        const result = parseWorkflowContent(content);
        // If no error, the config must be a plain object (map) - never an array or scalar
        assert.ok(typeof result.config === "object" && result.config !== null);
        assert.ok(!Array.isArray(result.config));
      }
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: explicit non-map YAML types (null literal) SHALL produce workflow_front_matter_not_a_map error", () => {
  // "null" as the only YAML content parses to JavaScript null
  const content = wrapFrontMatter("null", "body text");
  assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
});

test("invariant 1: YAML array front matter SHALL produce workflow_front_matter_not_a_map error", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 10, unit: "grapheme" }), {
        minLength: 1,
        maxLength: 5,
      }),
      (items) => {
        // Generate a YAML array using flow syntax
        const yamlArray = `[${items.map((i) => JSON.stringify(i)).join(", ")}]`;
        const content = wrapFrontMatter(yamlArray, "body");
        assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
      },
    ),
    { numRuns: 100 },
  );
});

test("invariant 1: YAML numeric scalar front matter SHALL produce workflow_front_matter_not_a_map error", () => {
  fc.assert(
    fc.property(fc.integer({ min: -10000, max: 10000 }), (n) => {
      const content = wrapFrontMatter(String(n), "body");
      assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
    }),
    { numRuns: 100 },
  );
});

// --- Invariant 2: Unknown variable in prompt template SHALL fail strictly ---

test("invariant 2: rendering a prompt template referencing an unknown variable SHALL fail strictly", () => {
  fc.assert(
    fc.asyncProperty(unknownVariableNameArb, async (varName) => {
      const template = `Hello {{ ${varName} }}`;
      const issue = minimalIssue();
      await assert.rejects(() => buildPrompt(template, issue));
    }),
    { numRuns: 100 },
  );
});

test("invariant 2: nested unknown variable paths SHALL fail strictly", () => {
  fc.assert(
    fc.asyncProperty(
      unknownVariableNameArb,
      unknownVariableNameArb,
      async (obj, prop) => {
        const template = `Value: {{ ${obj}.${prop} }}`;
        const issue = minimalIssue();
        await assert.rejects(() => buildPrompt(template, issue));
      },
    ),
    { numRuns: 100 },
  );
});

test("invariant 2: unknown property on known object SHALL fail strictly", () => {
  const knownIssueProps = [
    "id",
    "identifier",
    "title",
    "description",
    "priority",
    "state",
    "state_type",
    "branch_name",
    "url",
    "assignee_id",
    "blocked_by",
    "labels",
    "assigned_to_worker",
    "created_at",
    "updated_at",
  ];
  const unknownIssuePropArb = fc
    .array(fc.constantFrom(...alphaChars), { minLength: 1, maxLength: 15 })
    .map((chars) => chars.join(""))
    .filter((name) => !knownIssueProps.includes(name));

  fc.assert(
    fc.asyncProperty(unknownIssuePropArb, async (propName) => {
      const template = `Issue prop: {{ issue.${propName} }}`;
      const issue = minimalIssue();
      await assert.rejects(() => buildPrompt(template, issue));
    }),
    { numRuns: 100 },
  );
});
