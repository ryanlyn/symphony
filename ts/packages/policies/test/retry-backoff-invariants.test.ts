import { test } from "vitest";
import fc from "fast-check";
import { retryBackoffMs } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

test("retry delay is always non-negative and finite", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }),
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      fc.constantFrom("failure" as const, "continuation" as const),
      (attempt, maxBackoff, kind) => {
        const result = retryBackoffMs(attempt, maxBackoff, kind);
        assert.ok(result >= 0);
        assert.ok(Number.isFinite(result));
      },
    ),
    { numRuns: 200 },
  );
});

test("failure delays are monotonically non-decreasing with attempt number", () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 100 }),
      fc.nat({ max: 100 }),
      fc.integer({ min: 1, max: 100_000_000 }),
      (a, b, maxBackoff) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const delayLo = retryBackoffMs(lo, maxBackoff, "failure");
        const delayHi = retryBackoffMs(hi, maxBackoff, "failure");
        assert.ok(delayHi >= delayLo);
      },
    ),
    { numRuns: 200 },
  );
});

test("retry delay never exceeds configured maximum cap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 10_000 }),
      fc.integer({ min: 1_000, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        assert.ok(result <= maxBackoff);
      },
    ),
    { numRuns: 200 },
  );
});

test("failure delay has a positive floor preventing zero-delay storms", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 200 }),
      fc.integer({ min: 10_000, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        assert.ok(result >= 10_000);
      },
    ),
    { numRuns: 200 },
  );
});

test("continuation retry uses fixed short delay capped by maxRetryBackoffMs", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "continuation");
        assert.equal(result, Math.min(1_000, maxBackoff));
      },
    ),
    { numRuns: 200 },
  );
});
