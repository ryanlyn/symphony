import { test } from "vitest";
import fc from "fast-check";
import { mergeMonotonicUsage } from "@symphony/cli";

import { assert } from "../../../test/assert.js";
import { arbUsageTotals } from "../../../test/arbitraries.js";

/**
 * Arbitrary that generates partial updates including negative values,
 * large values, and undefined fields to stress edge cases.
 */
const arbPartialUsageUpdate = () =>
  fc.record({
    inputTokens: fc.option(fc.integer({ min: -1_000_000, max: 10_000_000 }), {
      nil: undefined,
    }),
    outputTokens: fc.option(fc.integer({ min: -1_000_000, max: 10_000_000 }), {
      nil: undefined,
    }),
    totalTokens: fc.option(fc.integer({ min: -1_000_000, max: 10_000_000 }), {
      nil: undefined,
    }),
  });

/**
 * Arbitrary that generates usage totals with zero values to test boundary conditions.
 */
const arbZeroBoundaryTotals = () =>
  fc.record({
    inputTokens: fc.constantFrom(0, 1),
    outputTokens: fc.constantFrom(0, 1),
    totalTokens: fc.constantFrom(0, 1),
    secondsRunning: fc.nat(),
  });

// Invariant 1: When token counts are updated, they SHALL never become negative.
test("Invariant 1: token counts SHALL never become negative after update", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // Entry totals token fields must be non-negative
        assert.ok(result.entryTotals.inputTokens >= 0);
        assert.ok(result.entryTotals.outputTokens >= 0);
        assert.ok(result.entryTotals.totalTokens >= 0);
        // Reported totals token fields must be non-negative
        assert.ok(result.reportedTotals.inputTokens >= 0);
        assert.ok(result.reportedTotals.outputTokens >= 0);
        assert.ok(result.reportedTotals.totalTokens >= 0);
        // Global totals token fields must be non-negative
        assert.ok(result.globalTotals.inputTokens >= 0);
        assert.ok(result.globalTotals.outputTokens >= 0);
        assert.ok(result.globalTotals.totalTokens >= 0);
      },
    ),
  );
});

test("Invariant 1: token counts non-negative even with zero-boundary inputs", () => {
  fc.assert(
    fc.property(
      arbZeroBoundaryTotals(),
      arbZeroBoundaryTotals(),
      arbZeroBoundaryTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        assert.ok(result.entryTotals.inputTokens >= 0);
        assert.ok(result.entryTotals.outputTokens >= 0);
        assert.ok(result.entryTotals.totalTokens >= 0);
        assert.ok(result.reportedTotals.inputTokens >= 0);
        assert.ok(result.reportedTotals.outputTokens >= 0);
        assert.ok(result.reportedTotals.totalTokens >= 0);
        assert.ok(result.globalTotals.inputTokens >= 0);
        assert.ok(result.globalTotals.outputTokens >= 0);
        assert.ok(result.globalTotals.totalTokens >= 0);
      },
    ),
  );
});

// Invariant 2: When token counters are updated, they SHALL never decrease (monotonic growth).
test("Invariant 2: entry token counters SHALL never decrease (monotonic growth)", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // Entry totals must never decrease compared to input entry totals
        assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
        assert.ok(result.entryTotals.outputTokens >= entry.outputTokens);
        assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
      },
    ),
  );
});

test("Invariant 2: sequential updates produce monotonically non-decreasing entry totals", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update1, update2) => {
        const first = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update: update1,
        });
        const second = mergeMonotonicUsage({
          entryTotals: first.entryTotals,
          reportedTotals: first.reportedTotals,
          globalTotals: first.globalTotals,
          update: update2,
        });
        // After two sequential merges, entry totals only grow
        assert.ok(second.entryTotals.inputTokens >= first.entryTotals.inputTokens);
        assert.ok(second.entryTotals.outputTokens >= first.entryTotals.outputTokens);
        assert.ok(second.entryTotals.totalTokens >= first.entryTotals.totalTokens);
      },
    ),
  );
});

// Invariant 3: When global aggregates are updated, they SHALL never decrease.
test("Invariant 3: global aggregates SHALL never decrease after merge", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        assert.ok(result.globalTotals.inputTokens >= global.inputTokens);
        assert.ok(result.globalTotals.outputTokens >= global.outputTokens);
        assert.ok(result.globalTotals.totalTokens >= global.totalTokens);
      },
    ),
  );
});

test("Invariant 3: global aggregates never decrease across sequential merges", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update1, update2) => {
        const first = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update: update1,
        });
        const second = mergeMonotonicUsage({
          entryTotals: first.entryTotals,
          reportedTotals: first.reportedTotals,
          globalTotals: first.globalTotals,
          update: update2,
        });
        assert.ok(second.globalTotals.inputTokens >= first.globalTotals.inputTokens);
        assert.ok(second.globalTotals.outputTokens >= first.globalTotals.outputTokens);
        assert.ok(second.globalTotals.totalTokens >= first.globalTotals.totalTokens);
      },
    ),
  );
});

// Invariant 4: When reported-totals watermark is updated, it SHALL stay in sync with entry totals.
test("Invariant 4: reported-totals watermark SHALL stay in sync with entry totals", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // Reported totals token values must equal entry totals token values
        assert.equal(result.reportedTotals.inputTokens, result.entryTotals.inputTokens);
        assert.equal(result.reportedTotals.outputTokens, result.entryTotals.outputTokens);
        assert.equal(result.reportedTotals.totalTokens, result.entryTotals.totalTokens);
      },
    ),
  );
});

// Invariant 5: When usage is accounted, seconds-running SHALL be preserved independently.
test("Invariant 5: seconds-running SHALL be preserved independently for each aggregate", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // secondsRunning is never modified by the merge — each aggregate keeps its own
        assert.equal(result.entryTotals.secondsRunning, entry.secondsRunning);
        assert.equal(result.reportedTotals.secondsRunning, reported.secondsRunning);
        assert.equal(result.globalTotals.secondsRunning, global.secondsRunning);
      },
    ),
  );
});

test("Invariant 5: seconds-running preserved even with large token updates", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      fc.record({
        inputTokens: fc.option(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), {
          nil: undefined,
        }),
        outputTokens: fc.option(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), {
          nil: undefined,
        }),
        totalTokens: fc.option(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), {
          nil: undefined,
        }),
      }),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        assert.equal(result.entryTotals.secondsRunning, entry.secondsRunning);
        assert.equal(result.reportedTotals.secondsRunning, reported.secondsRunning);
        assert.equal(result.globalTotals.secondsRunning, global.secondsRunning);
      },
    ),
  );
});

// Invariant 6: When the same update is applied twice, the result SHALL be the same (idempotent).
test("Invariant 6: applying the same update twice SHALL be idempotent", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const first = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        const second = mergeMonotonicUsage({
          entryTotals: first.entryTotals,
          reportedTotals: first.reportedTotals,
          globalTotals: first.globalTotals,
          update,
        });
        // After applying the same update to the result, nothing changes
        assert.deepEqual(second.entryTotals, first.entryTotals);
        assert.deepEqual(second.reportedTotals, first.reportedTotals);
        assert.deepEqual(second.globalTotals, first.globalTotals);
      },
    ),
  );
});

test("Invariant 6: idempotency holds across three consecutive identical applications", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const first = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        const second = mergeMonotonicUsage({
          entryTotals: first.entryTotals,
          reportedTotals: first.reportedTotals,
          globalTotals: first.globalTotals,
          update,
        });
        const third = mergeMonotonicUsage({
          entryTotals: second.entryTotals,
          reportedTotals: second.reportedTotals,
          globalTotals: second.globalTotals,
          update,
        });
        assert.deepEqual(third.entryTotals, first.entryTotals);
        assert.deepEqual(third.reportedTotals, first.reportedTotals);
        assert.deepEqual(third.globalTotals, first.globalTotals);
      },
    ),
  );
});
