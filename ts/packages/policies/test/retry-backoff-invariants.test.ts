import { test } from "vitest";
import fc from "fast-check";
import { retryBackoffMs } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

// Invariant 1: Delay is always a non-negative finite number for any inputs.
// This guards against NaN, Infinity, or negative delays that could cause
// infinite loops or invalid timer arguments in the orchestrator.
test("retryBackoffMs - delay is always non-negative and finite for the full input domain", () => {
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

// Invariant 2: Failure delays are monotonically non-decreasing with attempt number.
// This ensures that higher attempt numbers never produce shorter waits, which would
// defeat the purpose of exponential backoff as a congestion-avoidance mechanism.
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
    { numRuns: 200 },
  );
});

// Invariant 3: Failure delay never exceeds the configured maximum cap.
// This guarantees that operators can bound worst-case wait times via configuration,
// ensuring SLA compliance regardless of retry count.
test("retryBackoffMs - failure delay never exceeds the configured maximum cap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 10_000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        assert.ok(result <= maxBackoff);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 5: When max allows, failure delays have a positive floor preventing zero-delay storms.
// A zero delay in failure retries would cause a tight retry loop that overwhelms the upstream.
test("retryBackoffMs - failure delay has a positive floor when maxBackoff permits", () => {
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

// Invariant 6: Continuation retry uses a constant short delay independent of attempt and maxBackoff.
// Continuations are not errors -- they are normal protocol flow (e.g., max_tokens reached),
// so they should retry quickly without exponential growth.
test("retryBackoffMs - continuation retry uses a fixed delay regardless of inputs", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "continuation");
        assert.equal(result, 1_000);
      },
    ),
    { numRuns: 200 },
  );
});
