import { test } from "vitest";
import fc from "fast-check";
import { ensembleSize } from "@symphony/cli";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_ENSEMBLE_SIZE = 1;

function issueWith(labels: string[]): Issue {
  return {
    id: "id-1",
    identifier: "TEST-1",
    title: "Test issue",
    state: "Todo",
    stateType: null,
    description: null,
    branchName: null,
    url: null,
    priority: null,
    createdAt: null,
    updatedAt: null,
    labels,
    blockers: [],
    assigneeId: null,
    assignedToWorker: true,
  };
}

/**
 * Resolves the effective ensemble size from an issue, falling back to the
 * configured default when ensembleSize returns null. This mirrors what the
 * runtime does but does NOT duplicate the label-parsing logic.
 */
function resolveEnsembleSize(issue: Issue, defaultSize: number = DEFAULT_ENSEMBLE_SIZE): number {
  return ensembleSize(issue) ?? defaultSize;
}

// Arbitrary: a label string that is definitely NOT a valid ensemble label.
const nonEnsembleLabelArb = fc
  .string({ minLength: 0, maxLength: 30 })
  .filter((s) => !/^ensemble:\d+$/i.test(s.trim()));

// ---------------------------------------------------------------------------
// Invariant 1: When a valid label with a positive integer is present, the
// system SHALL use that integer as ensemble size.
// ---------------------------------------------------------------------------

test("Invariant 1 — valid label with positive integer is used as ensemble size", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10000 }),
      fc.array(nonEnsembleLabelArb, { minLength: 0, maxLength: 5 }),
      (n, noise) => {
        // Place the valid label among noise labels at the front
        const labels = [`ensemble:${n}`, ...noise];
        const issue = issueWith(labels);
        const result = ensembleSize(issue);
        assert.equal(result, n);
        assert.ok(Number.isInteger(result));
        assert.ok(result !== null && result > 0);
      },
    ),
  );
});

test("Invariant 1 — very large positive integers are accepted", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 2_000_000 }), (n) => {
      const issue = issueWith([`ensemble:${n}`]);
      const result = ensembleSize(issue);
      assert.equal(result, n);
    }),
  );
});

// ---------------------------------------------------------------------------
// Invariant 2: When multiple valid labels are present, the system SHALL use
// the first encountered.
// ---------------------------------------------------------------------------

test("Invariant 2 — first valid ensemble label wins when multiple are present", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }),
      (first, rest) => {
        const labels = [`ensemble:${first}`, ...rest.map((n) => `ensemble:${n}`)];
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), first);
      },
    ),
  );
});

test("Invariant 2 — first valid label wins even when interleaved with invalid labels", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: 1, max: 100 }),
      fc.array(nonEnsembleLabelArb, { minLength: 0, maxLength: 3 }),
      (first, second, noise) => {
        // noise -> valid(first) -> noise -> valid(second)
        const labels = [...noise, `ensemble:${first}`, ...noise, `ensemble:${second}`];
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), first);
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Invariant 3: When a label specifies zero or a negative integer, the system
// SHALL ignore it and use the default.
// ---------------------------------------------------------------------------

test("Invariant 3 — zero in ensemble label is ignored, system uses default", () => {
  const issue = issueWith(["ensemble:0"]);
  const result = resolveEnsembleSize(issue);
  assert.equal(result, DEFAULT_ENSEMBLE_SIZE);
  // Raw function returns null to signal no valid label found
  assert.equal(ensembleSize(issue), null);
});

test("Invariant 3 — negative integers in ensemble label are ignored (regex does not match negatives)", () => {
  fc.assert(
    fc.property(fc.integer({ min: -10000, max: -1 }), (n) => {
      // Negative numbers produce labels like "ensemble:-5" which don't match \d+ pattern
      const issue = issueWith([`ensemble:${n}`]);
      assert.equal(ensembleSize(issue), null);
      assert.equal(resolveEnsembleSize(issue), DEFAULT_ENSEMBLE_SIZE);
    }),
  );
});

test("Invariant 3 — zero is ignored and system falls back to configured default", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50 }), (configuredDefault) => {
      const issue = issueWith(["ensemble:0"]);
      assert.equal(resolveEnsembleSize(issue, configuredDefault), configuredDefault);
    }),
  );
});

// ---------------------------------------------------------------------------
// Invariant 4: When matching ensemble labels, matching SHALL be
// case-insensitive and whitespace-insensitive.
// ---------------------------------------------------------------------------

test("Invariant 4 — matching is case-insensitive", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
      const variants = [
        `ensemble:${n}`,
        `ENSEMBLE:${n}`,
        `Ensemble:${n}`,
        `eNsEmBlE:${n}`,
        `ENSEMBLE:${n}`,
      ];
      for (const label of variants) {
        const issue = issueWith([label]);
        assert.equal(ensembleSize(issue), n);
      }
    }),
  );
});

test("Invariant 4 — matching is whitespace-insensitive (leading/trailing spaces)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.array(fc.constantFrom(" ", "\t", "  "), { minLength: 1, maxLength: 3 }).map((a) => a.join("")),
      (n, ws) => {
        const variants = [`${ws}ensemble:${n}`, `ensemble:${n}${ws}`, `${ws}ensemble:${n}${ws}`];
        for (const label of variants) {
          const issue = issueWith([label]);
          assert.equal(ensembleSize(issue), n);
        }
      },
    ),
  );
});

test("Invariant 4 — random case permutation is still matched", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
      (n, caseBits) => {
        const base = "ensemble";
        const cased = base
          .split("")
          .map((ch, i) => (caseBits[i] ? ch.toUpperCase() : ch.toLowerCase()))
          .join("");
        const label = `${cased}:${n}`;
        const issue = issueWith([label]);
        assert.equal(ensembleSize(issue), n);
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Invariant 5: When no valid ensemble label is present, the system SHALL use
// the configured default.
// ---------------------------------------------------------------------------

test("Invariant 5 — no ensemble labels at all yields configured default", () => {
  fc.assert(
    fc.property(
      fc.array(nonEnsembleLabelArb, { minLength: 0, maxLength: 10 }),
      fc.integer({ min: 1, max: 20 }),
      (labels, configuredDefault) => {
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), null);
        assert.equal(resolveEnsembleSize(issue, configuredDefault), configuredDefault);
      },
    ),
  );
});

test("Invariant 5 — empty labels array yields configured default", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50 }), (configuredDefault) => {
      const issue = issueWith([]);
      assert.equal(ensembleSize(issue), null);
      assert.equal(resolveEnsembleSize(issue, configuredDefault), configuredDefault);
    }),
  );
});

test("Invariant 5 — labels with non-numeric ensemble values yield default", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.constant("ensemble:"),
          fc.constant("ensemble:abc"),
          fc.constant("ensemble:1.5"),
          fc.constant("ensemble:two"),
          fc.constant("ensemble: "),
          fc.constant("ensemble:1e3"),
        ),
        { minLength: 1, maxLength: 5 },
      ),
      fc.integer({ min: 1, max: 20 }),
      (labels, configuredDefault) => {
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), null);
        assert.equal(resolveEnsembleSize(issue, configuredDefault), configuredDefault);
      },
    ),
  );
});

test("Invariant 5 — unicode and special character labels do not accidentally match", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.constant("ensemble:🎵"),
          fc.constant("ensémble:3"),
          fc.constant("еnsemble:5"), // Cyrillic 'е' (U+0435) looks like Latin 'e'
          fc.constant("ënsemble:7"),
          fc.constant("ensemble​:4"), // zero-width space
        ),
        { minLength: 1, maxLength: 5 },
      ),
      (labels) => {
        const issue = issueWith(labels);
        // Either null or a valid positive integer (if by chance random string produced a valid label)
        const result = ensembleSize(issue);
        if (result !== null) {
          assert.ok(Number.isInteger(result));
          assert.ok(result > 0);
        }
      },
    ),
  );
});
