import { test } from "vitest";
import fc from "fast-check";
import { normalizeStateName, isTerminalState } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

// --- Invariant 1: Normalization SHALL be case-insensitive ---

test("normalizeStateName — normalization is case-insensitive (upper and lower produce same result)", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 30 }), (input) => {
      assert.equal(
        normalizeStateName(input.toUpperCase()),
        normalizeStateName(input.toLowerCase()),
      );
    }),
  );
});

test("normalizeStateName — mixed case variants all normalize to the same value", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
      (input, casePattern) => {
        // Create a random casing of the input
        const randomCased = input
          .split("")
          .map((ch, i) => (casePattern[i % casePattern.length] ? ch.toUpperCase() : ch.toLowerCase()))
          .join("");
        assert.equal(normalizeStateName(randomCased), normalizeStateName(input));
      },
    ),
  );
});

// --- Invariant 2: Normalization applied twice SHALL produce the same result (idempotent) ---

test("normalizeStateName — applying normalization twice yields the same result as once (idempotent)", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 50 }), (input) => {
      const once = normalizeStateName(input);
      const twice = normalizeStateName(once);
      assert.equal(twice, once);
    }),
  );
});

test("normalizeStateName — idempotency holds for unicode and special characters", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 0, maxLength: 40, unit: "grapheme" }), (input) => {
      const once = normalizeStateName(input);
      const twice = normalizeStateName(once);
      assert.equal(twice, once);
    }),
  );
});

// --- Invariant 3: Leading and trailing whitespace SHALL be stripped ---

test("normalizeStateName — leading and trailing whitespace is stripped", () => {
  const whitespaceArb = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 5 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      whitespaceArb,
      whitespaceArb,
      (core, leading, trailing) => {
        const padded = leading + core + trailing;
        assert.equal(normalizeStateName(padded), normalizeStateName(core));
      },
    ),
  );
});

test("normalizeStateName — result never starts or ends with whitespace (non-empty input)", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 30 }), (input) => {
      const result = normalizeStateName(input);
      if (result.length > 0) {
        assert.equal(result, result.trim());
      }
    }),
  );
});

// --- Invariant 4: Null or undefined state SHALL be classified as non-terminal ---

test("isTerminalState — null state is always classified as non-terminal", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 10 }),
      (terminalStates) => {
        assert.equal(isTerminalState(null, terminalStates), false);
      },
    ),
  );
});

test("isTerminalState — undefined state is always classified as non-terminal", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 10 }),
      (terminalStates) => {
        assert.equal(isTerminalState(undefined, terminalStates), false);
      },
    ),
  );
});

// --- Invariant 5: Unknown state SHALL be classified as non-terminal ---

test("isTerminalState — a state not in the terminal list is classified as non-terminal", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 10 }),
      (state, terminalStates) => {
        // Ensure the state (normalized) does not appear in the terminal list (normalized)
        const normalizedState = state.trim().toLowerCase();
        const normalizedTerminals = terminalStates.map((s) => s.trim().toLowerCase());
        fc.pre(!normalizedTerminals.includes(normalizedState));

        assert.equal(isTerminalState(state, terminalStates), false);
      },
    ),
  );
});

test("isTerminalState — empty string state is classified as non-terminal", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 10 }),
      (terminalStates) => {
        assert.equal(isTerminalState("", terminalStates), false);
      },
    ),
  );
});

// --- Invariant 6: State comparison SHALL be case-insensitive and whitespace-tolerant ---

test("isTerminalState — comparison is case-insensitive (any casing of a terminal state matches)", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 0, maxLength: 5 }),
      (terminalState, otherStates) => {
        const terminalStates = [terminalState, ...otherStates];
        // The same state in uppercase should still be recognized as terminal
        assert.equal(isTerminalState(terminalState.toUpperCase(), terminalStates), true);
        assert.equal(isTerminalState(terminalState.toLowerCase(), terminalStates), true);
      },
    ),
  );
});

test("isTerminalState — comparison is whitespace-tolerant (padded state matches)", () => {
  const wsArb = fc
    .array(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 3 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 0, maxLength: 5 }),
      wsArb,
      wsArb,
      (terminalState, otherStates, leading, trailing) => {
        const terminalStates = [terminalState, ...otherStates];
        const padded = leading + terminalState + trailing;
        assert.equal(isTerminalState(padded, terminalStates), true);
      },
    ),
  );
});

test("isTerminalState — comparison is both case-insensitive and whitespace-tolerant simultaneously", () => {
  const wsArb = fc
    .array(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 3 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      wsArb,
      (terminalState, padding) => {
        const terminalStates = [terminalState];
        const variant = padding + terminalState.toUpperCase() + padding;
        assert.equal(isTerminalState(variant, terminalStates), true);
      },
    ),
  );
});
