import { test } from "vitest";
import fc from "fast-check";
import {
  routeNames,
  routedToThisWorker,
  normalizeRouteName,
  defaultSettings,
} from "@symphony/cli";
import type { Issue, Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

function makeSettings(
  overrides: {
    acceptUnrouted?: boolean;
    onlyRoutes?: string[] | null;
    routeLabelPrefix?: string;
    activeStates?: string[];
    terminalStates?: string[];
  } = {},
): Settings {
  const s = defaultSettings();
  s.tracker.dispatch.acceptUnrouted = overrides.acceptUnrouted ?? true;
  s.tracker.dispatch.onlyRoutes = overrides.onlyRoutes ?? null;
  s.tracker.dispatch.routeLabelPrefix = overrides.routeLabelPrefix ?? "Symphony:";
  if (overrides.activeStates) s.tracker.activeStates = overrides.activeStates;
  if (overrides.terminalStates) s.tracker.terminalStates = overrides.terminalStates;
  return s;
}

function issueWith(overrides: Partial<Issue>): Issue {
  return {
    id: "id-1",
    identifier: "TEST-1",
    title: "Test issue",
    state: "Todo",
    stateType: "unstarted",
    description: null,
    branchName: null,
    url: null,
    priority: 1,
    createdAt: null,
    updatedAt: null,
    labels: [],
    blockers: [],
    assigneeId: null,
    assignedToWorker: true,
    ...overrides,
  };
}

// --- Invariant 1: normalization is case-insensitive ---

test("normalizeRouteName — normalization SHALL be case-insensitive", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 50 }), (input) => {
      const fromUpper = normalizeRouteName(input.toUpperCase());
      const fromLower = normalizeRouteName(input.toLowerCase());
      assert.equal(fromUpper, fromLower);
    }),
  );
});

// --- Invariant 2: normalization is idempotent ---

test("normalizeRouteName — applying normalization twice SHALL yield the same result (idempotent)", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (input) => {
      const once = normalizeRouteName(input);
      const twice = normalizeRouteName(once);
      assert.equal(twice, once);
    }),
  );
});

test("normalizeRouteName — idempotent with unicode inputs", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme", maxLength: 50 }), (input) => {
      const once = normalizeRouteName(input);
      const twice = normalizeRouteName(once);
      assert.equal(twice, once);
    }),
  );
});

// --- Invariant 3: leading and trailing whitespace is stripped ---

test("normalizeRouteName — leading and trailing whitespace SHALL be stripped", () => {
  const arbWhitespace = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 5 })
    .map((a) => a.join(""));

  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 30 }),
      arbWhitespace,
      arbWhitespace,
      (core, leading, trailing) => {
        const withWhitespace = `${leading}${core}${trailing}`;
        const normalized = normalizeRouteName(withWhitespace);
        // The result should equal normalizing the core without surrounding whitespace
        assert.equal(normalized, normalizeRouteName(core));
        // The result itself should have no leading or trailing whitespace
        assert.equal(normalized, normalized.trim());
      },
    ),
  );
});

// --- Invariant 4: whitespace-only after prefix removal is not valid ---

test("routeNames — when route name after prefix removal is whitespace-only, it SHALL not be valid", () => {
  const arbWhitespace = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 5 })
    .map((a) => a.join(""));

  fc.assert(
    fc.property(
      fc.constantFrom("Symphony:", "Route:", "Team:", "X:"),
      arbWhitespace,
      (prefix, whitespace) => {
        // Label = prefix + whitespace (so the suffix is whitespace-only)
        const issue = issueWith({ labels: [`${prefix}${whitespace}`] });
        const settings = makeSettings({ routeLabelPrefix: prefix });
        const routes = routeNames(issue, settings);
        assert.equal(routes.length, 0);
      },
    ),
  );
});

// --- Invariant 5: prefix matching is case-insensitive ---

test("routeNames — prefix matching SHALL be case-insensitive", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 10 })
        .map((a) => a.join("")),
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 6 })
        .map((a) => a.join("")),
      (routeSuffix, prefixBase) => {
        const prefix = `${prefixBase}:`;
        const upperLabel = `${prefix.toUpperCase()}${routeSuffix}`;
        const lowerLabel = `${prefix.toLowerCase()}${routeSuffix}`;
        const mixedLabel = `${prefixBase[0]!.toUpperCase()}${prefixBase.slice(1).toLowerCase()}:${routeSuffix}`;

        const settingsObj = makeSettings({ routeLabelPrefix: prefix });

        const fromUpper = routeNames(issueWith({ labels: [upperLabel] }), settingsObj);
        const fromLower = routeNames(issueWith({ labels: [lowerLabel] }), settingsObj);
        const fromMixed = routeNames(issueWith({ labels: [mixedLabel] }), settingsObj);

        // All case variants should produce the same routes
        assert.deepEqual(fromUpper, fromLower);
        assert.deepEqual(fromLower, fromMixed);
        // And they should all find the route
        assert.ok(fromUpper.length > 0);
      },
    ),
  );
});

// --- Invariant 6: when allowlist is null, system accepts all routes ---

test("routedToThisWorker — when onlyRoutes is null, the system SHALL accept all routes", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
          minLength: 1,
          maxLength: 12,
        })
        .map((a) => a.join("")),
      (routeName) => {
        const issue = issueWith({ labels: [`symphony:${routeName}`] });
        const settings = makeSettings({ onlyRoutes: null });
        assert.ok(routedToThisWorker(issue, settings));
      },
    ),
  );
});

// --- Invariant 7: when allowlist is empty, system rejects all routes ---

test("routedToThisWorker — when onlyRoutes is empty, the system SHALL reject all routes", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
          minLength: 1,
          maxLength: 12,
        })
        .map((a) => a.join("")),
      (routeName) => {
        const issue = issueWith({ labels: [`symphony:${routeName}`] });
        const settings = makeSettings({ onlyRoutes: [] });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
  );
});

// --- Invariant 8: no route label and unrouted dispatch disabled means ineligible ---

test("routedToThisWorker — when no route label is present and unrouted dispatch is disabled, dispatch SHALL be ineligible", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((l) => !l.toLowerCase().startsWith("symphony:")),
        { maxLength: 5 },
      ),
      (labels) => {
        const issue = issueWith({ labels });
        const settings = makeSettings({ acceptUnrouted: false });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
  );
});

test("routedToThisWorker — no route label with various prefixes and unrouted disabled rejects", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Symphony:", "Route:", "Deploy:", "Team:"),
      fc.array(
        fc
          .string({ minLength: 1, maxLength: 15 })
          .filter((l) => !l.toLowerCase().includes(":")),
        { maxLength: 3 },
      ),
      (prefix, labels) => {
        const issue = issueWith({ labels });
        const settings = makeSettings({ routeLabelPrefix: prefix, acceptUnrouted: false });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
  );
});

// --- Invariant 9: prefix matches but remaining name is whitespace-only means rejected as routed-but-invalid ---

test("routedToThisWorker — when prefix matching succeeds but remaining name is whitespace-only, the route SHALL be rejected", () => {
  const arbWhitespace = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 5 })
    .map((a) => a.join(""));

  fc.assert(
    fc.property(
      fc.constantFrom("Symphony:", "Route:", "Team:"),
      arbWhitespace,
      (prefix, whitespace) => {
        // The label matches the prefix but the suffix is only whitespace
        const issue = issueWith({ labels: [`${prefix}${whitespace}`] });
        const settings = makeSettings({ routeLabelPrefix: prefix, acceptUnrouted: true });
        // hasRouteLabel returns true (prefix matched), but routeNames yields empty
        // so routedToThisWorker should treat it as "routed but invalid" and return false
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
  );
});

test("routedToThisWorker — whitespace-only suffix with onlyRoutes null still rejected", () => {
  const arbWhitespace = fc
    .array(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 4 })
    .map((a) => a.join(""));

  fc.assert(
    fc.property(arbWhitespace, (whitespace) => {
      const issue = issueWith({ labels: [`Symphony:${whitespace}`] });
      const settings = makeSettings({ onlyRoutes: null });
      // Even with null allowlist (accept all), a whitespace-only route name
      // means the label matched the prefix but produced no valid route name
      assert.ok(!routedToThisWorker(issue, settings));
    }),
  );
});
