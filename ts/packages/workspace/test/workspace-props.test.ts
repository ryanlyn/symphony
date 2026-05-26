import { test } from "vitest";
import fc from "fast-check";
import { safeIdentifier, workspacePath, ensureInsideRoot } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

const SAFE_CHARS = /^[A-Za-z0-9._-]*$/;

test("safeIdentifier — idempotent", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 50 }), (input) => {
      const once = safeIdentifier(input);
      const twice = safeIdentifier(once);
      assert.equal(twice, once);
    }),
  );
});

test("safeIdentifier — output contains only safe characters", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 50 }), (input) => {
      const result = safeIdentifier(input);
      assert.match(result, SAFE_CHARS);
    }),
  );
});

test("safeIdentifier — length does not exceed input length", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 50 }), (input) => {
      const result = safeIdentifier(input);
      assert.ok(result.length <= input.length);
    }),
  );
});

test("safeIdentifier — deterministic", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 50 }), (input) => {
      assert.equal(safeIdentifier(input), safeIdentifier(input));
    }),
  );
});

test("safeIdentifier — non-string input returns empty string", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.boolean()),
      (input) => {
        assert.equal(safeIdentifier(input), "");
      },
    ),
  );
});

test("safeIdentifier — preserves safe characters", () => {
  const safeChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(...safeChars), { minLength: 1, maxLength: 30 })
        .map((a) => a.join("")),
      (input) => {
        assert.equal(safeIdentifier(input), input);
      },
    ),
  );
});

test("workspacePath — result starts with root", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("/tmp/workspaces", "/var/symphony", "/home/user/ws"),
      fc
        .string({ minLength: 1, maxLength: 15 })
        .filter(
          (s) =>
            safeIdentifier(s) !== "" && safeIdentifier(s) !== "." && safeIdentifier(s) !== "..",
        ),
      (root, identifier) => {
        const result = workspacePath(root, identifier);
        assert.ok(result.startsWith(root + "/"));
      },
    ),
  );
});

test("workspacePath — solo run has no slot suffix", () => {
  fc.assert(
    fc.property(
      fc.constant("/tmp/ws"),
      fc
        .string({ minLength: 1, maxLength: 15 })
        .filter(
          (s) =>
            safeIdentifier(s) !== "" && safeIdentifier(s) !== "." && safeIdentifier(s) !== "..",
        ),
      (root, identifier) => {
        const solo = workspacePath(root, identifier, 0, 1);
        const segments = solo.slice(root.length + 1).split("/");
        assert.equal(segments.length, 1);
      },
    ),
  );
});

test("workspacePath — ensemble adds slot directory", () => {
  fc.assert(
    fc.property(
      fc.constant("/tmp/ws"),
      fc
        .string({ minLength: 1, maxLength: 15 })
        .filter(
          (s) =>
            safeIdentifier(s) !== "" && safeIdentifier(s) !== "." && safeIdentifier(s) !== "..",
        ),
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 2, max: 10 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slotIdx = slotIndex % ensembleSize;
        const result = workspacePath(root, identifier, slotIdx, ensembleSize);
        assert.ok(result.endsWith(`/${slotIdx}`));
      },
    ),
  );
});

test("workspacePath — distinct slots produce distinct paths", () => {
  fc.assert(
    fc.property(
      fc.constant("/tmp/ws"),
      fc
        .string({ minLength: 1, maxLength: 15 })
        .filter(
          (s) =>
            safeIdentifier(s) !== "" && safeIdentifier(s) !== "." && safeIdentifier(s) !== "..",
        ),
      fc.integer({ min: 2, max: 5 }),
      (root, identifier, ensembleSize) => {
        const paths = new Set<string>();
        for (let slot = 0; slot < ensembleSize; slot += 1) {
          paths.add(workspacePath(root, identifier, slot, ensembleSize));
        }
        assert.equal(paths.size, ensembleSize);
      },
    ),
  );
});

test("workspacePath — deterministic", () => {
  fc.assert(
    fc.property(
      fc.constant("/tmp/ws"),
      fc
        .string({ minLength: 1, maxLength: 15 })
        .filter(
          (s) =>
            safeIdentifier(s) !== "" && safeIdentifier(s) !== "." && safeIdentifier(s) !== "..",
        ),
      fc.integer({ min: 0, max: 4 }),
      fc.integer({ min: 1, max: 5 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slot = slotIndex % ensembleSize;
        assert.equal(
          workspacePath(root, identifier, slot, ensembleSize),
          workspacePath(root, identifier, slot, ensembleSize),
        );
      },
    ),
  );
});

test("ensureInsideRoot — rejects paths outside root", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("/tmp/ws", "/var/data", "/home/user"),
      fc.constantFrom("../escape", "../../etc/passwd", "/absolute/other"),
      (root, suffix) => {
        const target = suffix.startsWith("/") ? suffix : `${root}/${suffix}`;
        let threw = false;
        try {
          ensureInsideRoot(target, root);
        } catch {
          threw = true;
        }
        if (target.startsWith("/") && !target.startsWith(root + "/") && target !== root) {
          assert.ok(threw);
        }
      },
    ),
  );
});

test("ensureInsideRoot — accepts paths inside root", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("/tmp/ws", "/var/data"),
      fc
        .string({ minLength: 1, maxLength: 10 })
        .filter((s) => !s.includes("..") && !s.startsWith("/")),
      (root, child) => {
        const target = `${root}/${child}`;
        ensureInsideRoot(target, root);
      },
    ),
  );
});
