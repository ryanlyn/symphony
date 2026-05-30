import { test } from "vitest";
import fc from "fast-check";
import { buildPrompt } from "@symphony/cli";
import { effectivePromptTemplate, defaultPromptTemplate } from "@symphony/cli";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

// --- Helper arbitraries ---

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Fix the login bug",
    description: "Users cannot log in when using SSO.",
    state: "In Progress",
    stateType: "started",
    branchName: "fix/login-bug",
    url: "https://linear.app/team/issue/ENG-42",
    priority: 1,
    labels: [],
    blockers: [],
    assignedToWorker: true,
    ...overrides,
  };
}

/** Arbitrary that produces strings that are empty or consist only of whitespace. */
const whitespaceOnlyArb = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("\t"),
  fc.constant("\n"),
  fc.constant("  \n\t  "),
  fc.array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 20 }).map((a) => a.join("")),
);

/** Arbitrary that produces valid Liquid variable names that do NOT exist in the template context. */
const unknownVariableNameArb = fc.array(
  fc.constantFrom(
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
    "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "_",
  ),
  { minLength: 3, maxLength: 12 },
).map((a) => a.join("")).filter(
  (s) => !["issue", "attempt", "ensemble"].includes(s) && /^[a-z_]/.test(s),
);

/** Arbitrary that produces filter names that do not exist in Liquid's built-in set. */
const unknownFilterNameArb = fc.array(
  fc.constantFrom(
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
    "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "_",
  ),
  { minLength: 5, maxLength: 15 },
).map((a) => a.join("")).filter(
  (s) =>
    // Exclude known Liquid built-in filters
    ![
      "abs", "append", "at_least", "at_most", "capitalize", "ceil",
      "compact", "concat", "date", "default", "divided_by", "downcase",
      "escape", "escape_once", "first", "floor", "join", "json", "last",
      "lstrip", "map", "minus", "modulo", "newline_to_br", "nl2br",
      "plus", "prepend", "remove", "remove_first", "replace",
      "replace_first", "reverse", "round", "rstrip", "size", "slice",
      "sort", "sort_natural", "split", "strip", "strip_html",
      "strip_newlines", "times", "truncate", "truncatewords", "uniq",
      "upcase", "url_decode", "url_encode", "where",
    ].includes(s) && /^[a-z_]/.test(s),
);

/** Arbitrary producing diverse Issue objects. */
const issueArb: fc.Arbitrary<Issue> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 50 }),
  identifier: fc.string({ minLength: 1, maxLength: 20 }),
  title: fc.string({ minLength: 1, maxLength: 200 }),
  description: fc.option(fc.string({ maxLength: 500 }), { nil: null }),
  state: fc.string({ minLength: 1, maxLength: 30 }),
  stateType: fc.option(
    fc.constantFrom("backlog" as const, "unstarted" as const, "started" as const, "completed" as const, "canceled" as const, "triage" as const),
    { nil: null },
  ),
  branchName: fc.option(fc.string({ maxLength: 60 }), { nil: null }),
  url: fc.option(fc.string({ maxLength: 100 }), { nil: null }),
  priority: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
  labels: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
  blockers: fc.array(
    fc.record({
      id: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
      identifier: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      state: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      stateType: fc.option(
        fc.constantFrom("backlog" as const, "unstarted" as const, "started" as const, "completed" as const, "canceled" as const, "triage" as const),
        { nil: undefined },
      ),
    }),
    { maxLength: 3 },
  ),
  assignedToWorker: fc.option(fc.boolean(), { nil: null }),
}) as fc.Arbitrary<Issue>;

// --- Invariant 1: empty/whitespace body falls back to default prompt ---

test("Invariant 1: when workflow prompt body is empty or whitespace-only, system uses minimal default prompt", async () => {
  await fc.assert(
    fc.asyncProperty(whitespaceOnlyArb, issueArb, async (template, issue) => {
      const result = await buildPrompt(template, issue);
      // The result must match what defaultPromptTemplate would render (not be empty)
      // Specifically it must contain the structural markers from the default template
      assert.match(result, /Identifier:/);
      assert.match(result, /Title:/);
      // It must contain actual issue data rendered into the default template
      assert.match(result, issue.identifier);
      assert.match(result, issue.title);
    }),
    { numRuns: 50 },
  );
});

test("Invariant 1: effectivePromptTemplate returns defaultPromptTemplate for whitespace inputs", () => {
  fc.assert(
    fc.property(whitespaceOnlyArb, (template) => {
      const effective = effectivePromptTemplate(template);
      assert.equal(effective, defaultPromptTemplate);
    }),
    { numRuns: 100 },
  );
});

// --- Invariant 2: unknown variable causes strict failure ---

test("Invariant 2: when prompt template references unknown variable, rendering fails strictly", async () => {
  await fc.assert(
    fc.asyncProperty(unknownVariableNameArb, async (varName) => {
      const template = `Hello {{ ${varName} }}`;
      const issue = makeIssue();
      await assert.rejects(
        () => buildPrompt(template, issue),
      );
    }),
    { numRuns: 50 },
  );
});

test("Invariant 2: nested unknown variable references also fail strictly", async () => {
  await fc.assert(
    fc.asyncProperty(unknownVariableNameArb, async (varName) => {
      const template = `Data: {{ issue.${varName} }}`;
      const issue = makeIssue();
      // issue context has specific known keys; an arbitrary name should not resolve
      await assert.rejects(
        () => buildPrompt(template, issue),
      );
    }),
    { numRuns: 50 },
  );
});

// --- Invariant 3: unknown filter causes strict failure ---

test("Invariant 3: when prompt template references unknown filter, rendering fails strictly", async () => {
  await fc.assert(
    fc.asyncProperty(unknownFilterNameArb, async (filterName) => {
      const template = `Hello {{ issue.title | ${filterName} }}`;
      const issue = makeIssue();
      await assert.rejects(
        () => buildPrompt(template, issue),
      );
    }),
    { numRuns: 50 },
  );
});

// --- Invariant 4: issue, attempt, and ensemble are available as template inputs ---

test("Invariant 4: issue object is available as template input with expected fields", async () => {
  await fc.assert(
    fc.asyncProperty(issueArb, async (issue) => {
      const template = `id:{{ issue.id }} ident:{{ issue.identifier }} title:{{ issue.title }} state:{{ issue.state }}`;
      const result = await buildPrompt(template, issue);
      assert.match(result, `id:${issue.id}`);
      assert.match(result, `ident:${issue.identifier}`);
      assert.match(result, `title:${issue.title}`);
      assert.match(result, `state:${issue.state}`);
    }),
    { numRuns: 50 },
  );
});

test("Invariant 4: attempt is available as template input", async () => {
  const attemptArb = fc.oneof(
    fc.constant(null),
    fc.integer({ min: 0, max: 100 }),
  );

  await fc.assert(
    fc.asyncProperty(attemptArb, async (attempt) => {
      const template = `attempt:{{ attempt }}`;
      const issue = makeIssue();
      const result = await buildPrompt(template, issue, { attempt });
      if (attempt === null) {
        assert.match(result, "attempt:");
      } else {
        assert.match(result, `attempt:${attempt}`);
      }
    }),
    { numRuns: 50 },
  );
});

test("Invariant 4: ensemble object is available as template input with slot_index, size, and enabled", async () => {
  const slotArb = fc.integer({ min: 0, max: 10 });
  const sizeArb = fc.integer({ min: 1, max: 10 });

  await fc.assert(
    fc.asyncProperty(slotArb, sizeArb, async (slotIndex, ensembleSize) => {
      // Ensure slotIndex < ensembleSize for valid ensembles
      const validSlot = slotIndex % ensembleSize;
      const template = `slot:{{ ensemble.slot_index }} size:{{ ensemble.size }} enabled:{{ ensemble.enabled }}`;
      const issue = makeIssue();
      const result = await buildPrompt(template, issue, { slotIndex: validSlot, ensembleSize });
      assert.match(result, `slot:${validSlot}`);
      assert.match(result, `size:${ensembleSize}`);
      assert.match(result, `enabled:${ensembleSize > 1}`);
    }),
    { numRuns: 50 },
  );
});
