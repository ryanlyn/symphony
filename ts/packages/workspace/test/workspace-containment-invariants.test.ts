import { test } from "vitest";
import fc from "fast-check";
import { safeIdentifier, workspacePath, ensureInsideRoot } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

/**
 * Arbitrary that generates non-empty identifiers whose safeIdentifier output
 * is non-empty and not "." or ".." (which would be degenerate path segments).
 */
const validIdentifier = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => {
    const safe = safeIdentifier(s);
    return safe !== "" && safe !== "." && safe !== "..";
  });

/**
 * Arbitrary for workspace roots (absolute paths without trailing slash).
 */
const absoluteRoot = fc.constantFrom(
  "/tmp/workspaces",
  "/var/symphony/ws",
  "/home/user/projects",
  "/opt/agent/runs",
);

/**
 * Arbitrary for diverse strings including edge cases: empty, unicode, special chars.
 */
const diverseString = fc.oneof(
  fc.string({ maxLength: 100 }),
  fc.string({ unit: "grapheme", maxLength: 50 }),
  fc.constant(""),
  fc.constant(".."),
  fc.constant("."),
  fc.constant("/"),
  fc.constant("../../../etc/passwd"),
  fc.constant("hello world"),
  fc.constant("name\twith\ttabs"),
  fc.constant("emoji-\u{1F600}-test"),
);

// Invariant 1: When a workspace path is resolved, the path SHALL be a strict
// descendant of the workspace root.
test("invariant 1: workspace path is a strict descendant of the workspace root", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier);
      // Must start with root + separator (strict descendant, not equal to root)
      assert.ok(result.startsWith(root + "/"));
      // Verify using ensureInsideRoot (should not throw)
      ensureInsideRoot(result, root);
      // Ensure it is NOT equal to root (strict descendant)
      assert.notEqual(result, root);
    }),
  );
});

test("invariant 1: ensemble workspace paths are strict descendants of root", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 2, max: 10 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slot = slotIndex % ensembleSize;
        const result = workspacePath(root, identifier, slot, ensembleSize);
        assert.ok(result.startsWith(root + "/"));
        ensureInsideRoot(result, root);
        assert.notEqual(result, root);
      },
    ),
  );
});

// Invariant 2: When directory names are derived from identifiers, the names
// SHALL contain only alphanumeric characters, dots, hyphens, and underscores.
const ALLOWED_CHARS = /^[A-Za-z0-9._-]*$/;

test("invariant 2: safeIdentifier output contains only alphanumeric, dots, hyphens, underscores", () => {
  fc.assert(
    fc.property(diverseString, (input) => {
      const result = safeIdentifier(input);
      assert.match(result, ALLOWED_CHARS);
    }),
  );
});

test("invariant 2: safeIdentifier on unicode strings contains only allowed characters", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme", minLength: 0, maxLength: 100 }), (input) => {
      const result = safeIdentifier(input);
      assert.match(result, ALLOWED_CHARS);
    }),
  );
});

test("invariant 2: safeIdentifier on non-string inputs contains only allowed characters", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant(null),
        fc.constant(undefined),
        fc.integer(),
        fc.boolean(),
        fc.double(),
      ),
      (input) => {
        const result = safeIdentifier(input);
        assert.match(result, ALLOWED_CHARS);
      },
    ),
  );
});

// Invariant 3: When sanitization is applied to a name, applying sanitization
// again SHALL produce the same result (idempotent).
test("invariant 3: safeIdentifier is idempotent on arbitrary strings", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (input) => {
      const once = safeIdentifier(input);
      const twice = safeIdentifier(once);
      assert.equal(twice, once);
    }),
  );
});

test("invariant 3: safeIdentifier is idempotent on unicode strings", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme", maxLength: 100 }), (input) => {
      const once = safeIdentifier(input);
      const twice = safeIdentifier(once);
      assert.equal(twice, once);
    }),
  );
});

test("invariant 3: safeIdentifier is idempotent on strings with path separators", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(fc.string({ maxLength: 20 }), fc.constant("/")), {
        minLength: 1,
        maxLength: 10,
      }),
      (parts) => {
        const input = parts.join("");
        const once = safeIdentifier(input);
        const twice = safeIdentifier(once);
        assert.equal(twice, once);
      },
    ),
  );
});

// Invariant 4: When the same inputs are provided, the system SHALL produce
// the same workspace path (deterministic).
test("invariant 4: workspacePath is deterministic for single-slot runs", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const first = workspacePath(root, identifier, 0, 1);
      const second = workspacePath(root, identifier, 0, 1);
      assert.equal(first, second);
    }),
  );
});

test("invariant 4: workspacePath is deterministic for ensemble runs", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 1, max: 10 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slot = slotIndex % ensembleSize;
        const first = workspacePath(root, identifier, slot, ensembleSize);
        const second = workspacePath(root, identifier, slot, ensembleSize);
        assert.equal(first, second);
      },
    ),
  );
});

test("invariant 4: safeIdentifier is deterministic", () => {
  fc.assert(
    fc.property(diverseString, (input) => {
      const first = safeIdentifier(input);
      const second = safeIdentifier(input);
      assert.equal(first, second);
    }),
  );
});

// Invariant 5: When a multi-slot ensemble is resolved, each slot SHALL
// receive a distinct workspace path.
test("invariant 5: ensemble slots produce distinct workspace paths", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 2, max: 20 }),
      (root, identifier, ensembleSize) => {
        const paths = new Set<string>();
        for (let slot = 0; slot < ensembleSize; slot++) {
          paths.add(workspacePath(root, identifier, slot, ensembleSize));
        }
        assert.equal(paths.size, ensembleSize);
      },
    ),
  );
});

test("invariant 5: any two different slots in an ensemble yield different paths", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 2, max: 20 }),
      fc.integer({ min: 0, max: 19 }),
      fc.integer({ min: 0, max: 19 }),
      (root, identifier, ensembleSize, slotA, slotB) => {
        const a = slotA % ensembleSize;
        const b = slotB % ensembleSize;
        if (a !== b) {
          const pathA = workspacePath(root, identifier, a, ensembleSize);
          const pathB = workspacePath(root, identifier, b, ensembleSize);
          assert.notEqual(pathA, pathB);
        }
      },
    ),
  );
});

// Invariant 6: When a single-slot run is resolved, the workspace path SHALL
// have no slot suffix.
test("invariant 6: single-slot run has no slot suffix in path", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier, 0, 1);
      // The path after root should be exactly one segment (the sanitized identifier)
      const relativePart = result.slice(root.length + 1);
      assert.ok(!relativePart.includes("/"));
      // The relative part should equal the sanitized identifier directly
      assert.equal(relativePart, safeIdentifier(identifier));
    }),
  );
});

test("invariant 6: single-slot path equals root/safeIdentifier without numeric suffix", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier, 0, 1);
      // Verify it does NOT end with a /digit pattern that ensemble paths have
      const lastSegment = result.split("/").pop()!;
      // The last segment should be the sanitized identifier, not a numeric slot index
      assert.equal(lastSegment, safeIdentifier(identifier));
    }),
  );
});

test("invariant 6: contrast with ensemble — ensemble path has extra segment", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 2, max: 10 }),
      (root, identifier, ensembleSize) => {
        const singleSlot = workspacePath(root, identifier, 0, 1);
        const ensembleSlot = workspacePath(root, identifier, 0, ensembleSize);
        // Single-slot path should be a proper prefix of the ensemble path
        assert.ok(ensembleSlot.startsWith(singleSlot + "/"));
        // Ensemble path has an extra segment
        const extraSegment = ensembleSlot.slice(singleSlot.length + 1);
        assert.equal(extraSegment, "0");
      },
    ),
  );
});
