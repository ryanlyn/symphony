import { test } from "vitest";
import fc from "fast-check";
import { sortForDispatch } from "@symphony/cli";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

/**
 * Arbitrary that produces a minimal valid Issue with varied priority and createdAt values.
 * Covers valid priorities (1-4), out-of-range, null, undefined, zero, and negative.
 */
const arbIssue = (): fc.Arbitrary<Issue> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    identifier: fc.string({ minLength: 1, maxLength: 20 }),
    title: fc.string({ minLength: 1, maxLength: 30 }),
    state: fc.string({ minLength: 1, maxLength: 10 }),
    labels: fc.constant([] as string[]),
    blockers: fc.constant([]),
    priority: fc.oneof(
      fc.constantFrom(1, 2, 3, 4),
      fc.constant(null as number | null),
      fc.constant(undefined as number | undefined),
      fc.integer({ min: -100, max: 0 }),
      fc.integer({ min: 5, max: 1000 }),
    ),
    createdAt: fc.oneof(
      fc
        .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2040-01-01").getTime() })
        .map((ms) => new Date(ms).toISOString()),
      fc.constant(null as string | null),
      fc.constant(undefined as string | undefined),
      fc.constant(""),
      fc.constant("not-a-valid-date"),
      fc.constant("garbage-☃-unicode"),
    ),
  });

/**
 * Arbitrary that produces an Issue with a valid in-range priority (1-4).
 */
const arbIssueWithValidPriority = (): fc.Arbitrary<Issue> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    identifier: fc.string({ minLength: 1, maxLength: 20 }),
    title: fc.string({ minLength: 1, maxLength: 30 }),
    state: fc.string({ minLength: 1, maxLength: 10 }),
    labels: fc.constant([] as string[]),
    blockers: fc.constant([]),
    priority: fc.constantFrom(1, 2, 3, 4),
    createdAt: fc
      .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2040-01-01").getTime() })
      .map((ms) => new Date(ms).toISOString()),
  });

/**
 * Arbitrary that produces an Issue with null/missing/out-of-range priority.
 */
const arbIssueWithInvalidPriority = (): fc.Arbitrary<Issue> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    identifier: fc.string({ minLength: 1, maxLength: 20 }),
    title: fc.string({ minLength: 1, maxLength: 30 }),
    state: fc.string({ minLength: 1, maxLength: 10 }),
    labels: fc.constant([] as string[]),
    blockers: fc.constant([]),
    priority: fc.oneof(
      fc.constant(null as number | null),
      fc.constant(undefined as number | undefined),
      fc.constant(0),
      fc.integer({ min: 5, max: 1000 }),
      fc.integer({ min: -100, max: -1 }),
    ),
    createdAt: fc
      .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2040-01-01").getTime() })
      .map((ms) => new Date(ms).toISOString()),
  });

/**
 * Arbitrary that produces an Issue with null/missing/unparseable createdAt.
 */
const arbIssueWithInvalidCreatedAt = (): fc.Arbitrary<Issue> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    identifier: fc.string({ minLength: 1, maxLength: 20 }),
    title: fc.string({ minLength: 1, maxLength: 30 }),
    state: fc.string({ minLength: 1, maxLength: 10 }),
    labels: fc.constant([] as string[]),
    blockers: fc.constant([]),
    priority: fc.constantFrom(1, 2, 3, 4),
    createdAt: fc.oneof(
      fc.constant(null as string | null),
      fc.constant(undefined as string | undefined),
      fc.constant(""),
      fc.constant("not-a-date"),
      fc.constant("garbage-☃-unicode"),
    ),
  });

// ---------------------------------------------------------------------------
// Invariant 1: Output is a permutation of the input (no additions or drops)
// ---------------------------------------------------------------------------
test("invariant 1: sort output SHALL be a permutation of the input (no additions or drops)", () => {
  fc.assert(
    fc.property(fc.array(arbIssue(), { maxLength: 50 }), (issues) => {
      const sorted = sortForDispatch(issues);
      // Same length
      assert.equal(sorted.length, issues.length);
      // Every input element appears in output (by reference)
      for (const issue of issues) {
        assert.ok(sorted.includes(issue));
      }
      // Every output element appears in input (by reference)
      for (const issue of sorted) {
        assert.ok(issues.includes(issue));
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// Invariant 2: Sorting an already-sorted list yields identical result (idempotent)
// ---------------------------------------------------------------------------
test("invariant 2: sort applied to an already-sorted list SHALL be identical (idempotent)", () => {
  fc.assert(
    fc.property(fc.array(arbIssue(), { maxLength: 50 }), (issues) => {
      const once = sortForDispatch(issues);
      const twice = sortForDispatch(once);
      assert.equal(twice.length, once.length);
      for (let i = 0; i < once.length; i++) {
        assert.equal(twice[i], once[i]);
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// Invariant 3: Lower priority number sorts first when priorities differ
// ---------------------------------------------------------------------------
test("invariant 3: dispatch with lower priority number SHALL sort before one with higher priority number", () => {
  fc.assert(
    fc.property(
      arbIssueWithValidPriority(),
      arbIssueWithValidPriority(),
      (issueA, issueB) => {
        fc.pre(issueA.priority !== issueB.priority);
        const sorted = sortForDispatch([issueA, issueB]);
        const first = sorted[0]!;
        const second = sorted[1]!;
        assert.ok(first.priority! <= second.priority!);
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Invariant 4: Same priority, earlier creation time sorts first
// ---------------------------------------------------------------------------
test("invariant 4: same priority with earlier creation time SHALL sort first", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(1, 2, 3, 4),
      fc.integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() }),
      fc.integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() }),
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.string({ minLength: 1, maxLength: 10 }),
      (priority, timeA, timeB, idA, idB) => {
        fc.pre(timeA !== timeB);
        const issueA: Issue = {
          id: "a",
          identifier: idA,
          title: "A",
          state: "active",
          labels: [],
          blockers: [],
          priority,
          createdAt: new Date(timeA).toISOString(),
        };
        const issueB: Issue = {
          id: "b",
          identifier: idB,
          title: "B",
          state: "active",
          labels: [],
          blockers: [],
          priority,
          createdAt: new Date(timeB).toISOString(),
        };
        const sorted = sortForDispatch([issueA, issueB]);
        const first = sorted[0]!;
        // The one with the earlier timestamp should be first
        if (timeA < timeB) {
          assert.equal(first, issueA);
        } else {
          assert.equal(first, issueB);
        }
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Invariant 5: Same priority and creation time, lexicographically earlier identifier sorts first
// ---------------------------------------------------------------------------
test("invariant 5: same priority and creation time, lexicographically earlier identifier SHALL sort first", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(1, 2, 3, 4),
      fc
        .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() })
        .map((ms) => new Date(ms).toISOString()),
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.string({ minLength: 1, maxLength: 10 }),
      (priority, createdAt, idA, idB) => {
        fc.pre(idA.localeCompare(idB) !== 0);
        const issueA: Issue = {
          id: "a",
          identifier: idA,
          title: "A",
          state: "active",
          labels: [],
          blockers: [],
          priority,
          createdAt,
        };
        const issueB: Issue = {
          id: "b",
          identifier: idB,
          title: "B",
          state: "active",
          labels: [],
          blockers: [],
          priority,
          createdAt,
        };
        const sorted = sortForDispatch([issueA, issueB]);
        const first = sorted[0]!;
        if (idA.localeCompare(idB) < 0) {
          assert.equal(first, issueA);
        } else {
          assert.equal(first, issueB);
        }
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Invariant 6: Null, missing, or out-of-range priority sorts last
// ---------------------------------------------------------------------------
test("invariant 6: dispatch with null, missing, or out-of-range priority SHALL sort last", () => {
  fc.assert(
    fc.property(
      arbIssueWithValidPriority(),
      arbIssueWithInvalidPriority(),
      (validIssue, invalidIssue) => {
        const sorted = sortForDispatch([validIssue, invalidIssue]);
        // The valid-priority issue must come first
        assert.equal(sorted[0], validIssue);
        assert.equal(sorted[1], invalidIssue);
      },
    ),
  );
});

test("invariant 6 (multi): all invalid-priority dispatches sort after all valid-priority dispatches", () => {
  fc.assert(
    fc.property(
      fc.array(arbIssueWithValidPriority(), { minLength: 1, maxLength: 10 }),
      fc.array(arbIssueWithInvalidPriority(), { minLength: 1, maxLength: 10 }),
      (validIssues, invalidIssues) => {
        const mixed = [...invalidIssues, ...validIssues];
        const sorted = sortForDispatch(mixed);
        // All valid-priority issues should precede all invalid-priority issues
        const validSet = new Set(validIssues);
        const firstInvalidIndex = sorted.findIndex((issue) => !validSet.has(issue));
        // Everything before firstInvalidIndex should be valid
        for (let i = 0; i < firstInvalidIndex; i++) {
          assert.ok(validSet.has(sorted[i]!));
        }
        // Everything from firstInvalidIndex onward should be invalid
        for (let i = firstInvalidIndex; i < sorted.length; i++) {
          assert.ok(!validSet.has(sorted[i]!));
        }
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Invariant 7: Null, missing, or unparseable creation time sorts last within its priority group
// ---------------------------------------------------------------------------
test("invariant 7: dispatch with null, missing, or unparseable creation time SHALL sort last within its priority group", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(1, 2, 3, 4),
      fc
        .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() })
        .map((ms) => new Date(ms).toISOString()),
      arbIssueWithInvalidCreatedAt(),
      (priority, validCreatedAt, invalidIssue) => {
        // Give the invalid issue the same priority
        const fixedInvalidIssue = { ...invalidIssue, priority };
        const validIssue: Issue = {
          id: "valid-id",
          identifier: "VALID-1",
          title: "Valid",
          state: "active",
          labels: [],
          blockers: [],
          priority,
          createdAt: validCreatedAt,
        };
        const sorted = sortForDispatch([fixedInvalidIssue, validIssue]);
        // The issue with valid createdAt must come before the one with invalid createdAt
        assert.equal(sorted[0], validIssue);
        assert.equal(sorted[1], fixedInvalidIssue);
      },
    ),
  );
});

test("invariant 7 (multi): within the same priority, all invalid-createdAt dispatches sort after valid ones", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(1, 2, 3, 4),
      fc.array(
        fc
          .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() })
          .map((ms) => new Date(ms).toISOString()),
        { minLength: 1, maxLength: 5 },
      ),
      fc.array(
        fc.oneof(
          fc.constant(null as string | null),
          fc.constant(undefined as string | undefined),
          fc.constant(""),
          fc.constant("not-a-date"),
        ),
        { minLength: 1, maxLength: 5 },
      ),
      (priority, validDates, invalidDates) => {
        const validIssues: Issue[] = validDates.map((createdAt, i) => ({
          id: `valid-${i}`,
          identifier: `V-${i}`,
          title: `Valid ${i}`,
          state: "active",
          labels: [],
          blockers: [],
          priority,
          createdAt,
        }));
        const invalidIssues: Issue[] = invalidDates.map((createdAt, i) => ({
          id: `invalid-${i}`,
          identifier: `I-${i}`,
          title: `Invalid ${i}`,
          state: "active",
          labels: [],
          blockers: [],
          priority,
          createdAt: createdAt ?? undefined,
        }));
        const mixed = [...invalidIssues, ...validIssues];
        const sorted = sortForDispatch(mixed);
        const validSet = new Set(validIssues);
        // Find the boundary: all valid issues should precede all invalid issues
        const firstInvalidIndex = sorted.findIndex((issue) => !validSet.has(issue));
        if (firstInvalidIndex === -1) return; // all valid, nothing to check
        for (let i = 0; i < firstInvalidIndex; i++) {
          assert.ok(validSet.has(sorted[i]!));
        }
        for (let i = firstInvalidIndex; i < sorted.length; i++) {
          assert.ok(!validSet.has(sorted[i]!));
        }
      },
    ),
  );
});
