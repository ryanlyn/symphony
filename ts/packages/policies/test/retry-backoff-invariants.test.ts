import { test } from "vitest";
import fc from "fast-check";
import { retryBackoffMs } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

// Invariant 1: When a retry delay is calculated, it SHALL be non-negative.
test("retryBackoffMs - delay is always non-negative for any input combination", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      fc.constantFrom("failure" as const, "continuation" as const),
      (attempt, maxBackoff, kind) => {
        const result = retryBackoffMs(attempt, maxBackoff, kind);
        assert.ok(result >= 0);
      },
    ),
  );
});

test("retryBackoffMs - delay is non-negative even with extreme attempt values", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }),
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      fc.constantFrom("failure" as const, "continuation" as const),
      (attempt, maxBackoff, kind) => {
        const result = retryBackoffMs(attempt, maxBackoff, kind);
        assert.ok(result >= 0);
      },
    ),
  );
});

// Invariant 2: When failure retry delay is calculated, it SHALL be monotonically non-decreasing with attempt number.
test("retryBackoffMs - failure delays are monotonically non-decreasing with attempt number", () => {
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
  );
});

test("retryBackoffMs - failure delays are non-decreasing across consecutive attempts", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 10_000, max: 10_000_000 }),
      (attempt, maxBackoff) => {
        const current = retryBackoffMs(attempt, maxBackoff, "failure");
        const next = retryBackoffMs(attempt + 1, maxBackoff, "failure");
        assert.ok(next >= current);
      },
    ),
  );
});

// Invariant 3: When a retry delay is calculated, it SHALL never exceed the configured maximum cap.
test("retryBackoffMs - failure delay never exceeds the configured maximum cap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 200 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        assert.ok(result <= maxBackoff);
      },
    ),
  );
});

test("retryBackoffMs - cap applies regardless of how large the attempt number is", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 10_000 }),
      fc.integer({ min: 1, max: 500_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        assert.ok(result <= maxBackoff);
      },
    ),
  );
});

// Invariant 4: When a retry delay is calculated, the minimum delay floor SHALL prevent zero-delay storms.
test("retryBackoffMs - failure delay has a positive floor preventing zero-delay storms when max allows", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 200 }),
      fc.integer({ min: 10_000, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        // The base delay is 10_000ms so when max >= 10_000, delay must be at least 10_000
        assert.ok(result >= 10_000);
      },
    ),
  );
});

test("retryBackoffMs - continuation delay is always positive preventing zero-delay storms", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "continuation");
        assert.ok(result > 0);
      },
    ),
  );
});

// Invariant 5: When a continuation retry is scheduled, it SHALL use a fixed short delay regardless of attempt number.
test("retryBackoffMs - continuation retry uses a fixed delay regardless of attempt number", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "continuation");
        assert.equal(result, 1_000);
      },
    ),
  );
});

test("retryBackoffMs - continuation delay is constant across different attempt/max combinations", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt1, attempt2, max1, max2) => {
        const result1 = retryBackoffMs(attempt1, max1, "continuation");
        const result2 = retryBackoffMs(attempt2, max2, "continuation");
        assert.equal(result1, result2);
      },
    ),
  );
});
