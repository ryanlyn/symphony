import { test } from "vitest";
import fc from "fast-check";
import type { Issue, Settings } from "@symphony/domain";
import { normalizeRouteName, defaultSettings } from "@symphony/config";

import { assert } from "../../../test/assert.js";

import { routeNames, routedToThisWorker } from "@symphony/dispatch";

function makeSettings(
  overrides: {
    acceptUnrouted?: boolean;
    onlyRoutes?: string[] | null;
    routeLabelPrefix?: string;
    activeStates?: string[];
    terminalStates?: string[];
    maxConcurrentAgents?: number;
    ensembleSize?: number;
  } = {},
): Settings {
  const s = defaultSettings();
  s.tracker.dispatch.acceptUnrouted = overrides.acceptUnrouted ?? true;
  s.tracker.dispatch.onlyRoutes = overrides.onlyRoutes ?? null;
  s.tracker.dispatch.routeLabelPrefix = overrides.routeLabelPrefix ?? "Symphony:";
  if (overrides.activeStates) s.tracker.activeStates = overrides.activeStates;
  if (overrides.terminalStates) s.tracker.terminalStates = overrides.terminalStates;
  if (overrides.maxConcurrentAgents !== undefined)
    s.agent.maxConcurrentAgents = overrides.maxConcurrentAgents;
  if (overrides.ensembleSize !== undefined) s.agent.ensembleSize = overrides.ensembleSize;
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

const arbRouteName = fc.oneof(
  fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
  fc.constantFrom(
    "team-alpha",
    "deploy_v2",
    "ci.main",
    "backend",
    "frontend-3",
    "ops_infra.prod",
    "release-2024.01",
    "ML-pipeline",
  ),
);
const arbRouteNameNoColon = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => s.trim().length > 0 && !s.includes(":"));
const arbWhitespace = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 5 })
  .map((a) => a.join(""));
test("route name normalization is idempotent", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (input) => {
      const once = normalizeRouteName(input);
      assert.equal(normalizeRouteName(once), once);
    }),
    { numRuns: 50 },
  );
});
test("normalized route names are always lowercase and trimmed", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 80 }), (input) => {
      const result = normalizeRouteName(input);
      assert.equal(result, result.toLowerCase());
      assert.equal(result, result.trim());
    }),
    { numRuns: 50 },
  );
});
test("whitespace-only suffix after prefix removal is not a valid route", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Symphony:", "Route:", "Team:", "X:"),
      arbWhitespace,
      (prefix, ws) => {
        assert.equal(
          routeNames(
            issueWith({ labels: [`${prefix}${ws}`] }),
            makeSettings({ routeLabelPrefix: prefix }),
          ).length,
          0,
        );
      },
    ),
    { numRuns: 100 },
  );
});
test("prefix matching is case-insensitive", () => {
  fc.assert(
    fc.property(
      arbRouteNameNoColon,
      fc.constantFrom("Symphony:", "Route:", "Team:"),
      (routeSuffix, prefix) => {
        const prefixBase = prefix.slice(0, -1);
        const s = makeSettings({ routeLabelPrefix: prefix });
        const fromUpper = routeNames(
          issueWith({ labels: [`${prefix.toUpperCase()}${routeSuffix}`] }),
          s,
        );
        const fromLower = routeNames(
          issueWith({ labels: [`${prefix.toLowerCase()}${routeSuffix}`] }),
          s,
        );
        const fromMixed = routeNames(
          issueWith({
            labels: [
              `${prefixBase[0]!.toUpperCase()}${prefixBase.slice(1).toLowerCase()}:${routeSuffix}`,
            ],
          }),
          s,
        );
        assert.deepEqual(fromUpper, fromLower);
        assert.deepEqual(fromLower, fromMixed);
        assert.ok(fromUpper.length > 0);
      },
    ),
    { numRuns: 200 },
  );
});
test("extracted routes are always in normalized form", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      (routeSuffix) => {
        const routes = routeNames(
          issueWith({ labels: [`Symphony:${routeSuffix}`] }),
          makeSettings({ routeLabelPrefix: "Symphony:" }),
        );
        for (const route of routes) {
          assert.equal(route, route.toLowerCase());
          assert.equal(route, route.trim());
        }
      },
    ),
    { numRuns: 200 },
  );
});
test("null allowlist accepts all routes", () => {
  fc.assert(
    fc.property(arbRouteName, (routeName) => {
      assert.ok(
        routedToThisWorker(
          issueWith({ labels: [`Symphony:${routeName}`] }),
          makeSettings({ onlyRoutes: null }),
        ),
      );
    }),
    { numRuns: 200 },
  );
});
test("empty allowlist rejects all routes", () => {
  fc.assert(
    fc.property(arbRouteName, (routeName) => {
      assert.ok(
        !routedToThisWorker(
          issueWith({ labels: [`Symphony:${routeName}`] }),
          makeSettings({ onlyRoutes: [] }),
        ),
      );
    }),
    { numRuns: 200 },
  );
});
test("no route label with unrouted disabled means ineligible", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((l) => !l.toLowerCase().startsWith("symphony:")),
        { maxLength: 5 },
      ),
      (labels) => {
        assert.ok(
          !routedToThisWorker(issueWith({ labels }), makeSettings({ acceptUnrouted: false })),
        );
      },
    ),
    { numRuns: 200 },
  );
});
test("no route label with unrouted enabled means eligible", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((l) => !l.toLowerCase().startsWith("symphony:")),
        { maxLength: 5 },
      ),
      (labels) => {
        assert.ok(
          routedToThisWorker(issueWith({ labels }), makeSettings({ acceptUnrouted: true })),
        );
      },
    ),
    { numRuns: 200 },
  );
});
test("whitespace-only suffix after prefix match is rejected as routed-but-invalid", () => {
  const arbWs = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 5 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(fc.constantFrom("Symphony:", "Route:", "Team:"), arbWs, (prefix, ws) => {
      assert.ok(
        !routedToThisWorker(
          issueWith({ labels: [`${prefix}${ws}`] }),
          makeSettings({ routeLabelPrefix: prefix, acceptUnrouted: true }),
        ),
      );
    }),
    { numRuns: 200 },
  );
});
test("allowlist matching is case-insensitive", () => {
  fc.assert(
    fc.property(arbRouteNameNoColon, (routeName) => {
      const issue = issueWith({ labels: [`Symphony:${routeName}`] });
      assert.ok(routedToThisWorker(issue, makeSettings({ onlyRoutes: [routeName.toUpperCase()] })));
      assert.ok(routedToThisWorker(issue, makeSettings({ onlyRoutes: [routeName.toLowerCase()] })));
    }),
    { numRuns: 200 },
  );
});
test("unassigned issue is always rejected regardless of other settings", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
      fc.boolean(),
      fc.oneof(
        fc.constant(null),
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 3 }),
      ),
      (labels, acceptUnrouted, onlyRoutes) => {
        assert.ok(
          !routedToThisWorker(
            issueWith({ labels, assignedToWorker: false }),
            makeSettings({ acceptUnrouted, onlyRoutes }),
          ),
        );
      },
    ),
    { numRuns: 200 },
  );
});
test("route in allowlist is accepted", () => {
  fc.assert(
    fc.property(
      arbRouteNameNoColon,
      fc.array(arbRouteNameNoColon, { minLength: 0, maxLength: 4 }),
      (routeName, others) => {
        assert.ok(
          routedToThisWorker(
            issueWith({ labels: [`Symphony:${routeName}`] }),
            makeSettings({ onlyRoutes: [routeName, ...others] }),
          ),
        );
      },
    ),
    { numRuns: 200 },
  );
});
test("route not in allowlist is rejected", () => {
  const poolA = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const poolB = ["one", "two", "three", "four", "five", "six"];
  fc.assert(
    fc.property(
      fc.constantFrom(...poolA),
      fc.array(fc.constantFrom(...poolB), { minLength: 1, maxLength: 4 }),
      (routeName, allowlist) => {
        assert.ok(
          !routedToThisWorker(
            issueWith({ labels: [`Symphony:${routeName}`] }),
            makeSettings({ onlyRoutes: allowlist }),
          ),
        );
      },
    ),
    { numRuns: 200 },
  );
});
test("multiple route labels accepted if any matches the allowlist", () => {
  fc.assert(
    fc.property(
      arbRouteNameNoColon,
      fc.array(arbRouteNameNoColon, { minLength: 1, maxLength: 4 }),
      (allowedRoute, others) => {
        const nonColliding = others.filter(
          (r) => normalizeRouteName(r) !== normalizeRouteName(allowedRoute),
        );
        assert.ok(
          routedToThisWorker(
            issueWith({
              labels: [...nonColliding.map((r) => `Symphony:${r}`), `Symphony:${allowedRoute}`],
            }),
            makeSettings({ onlyRoutes: [allowedRoute] }),
          ),
        );
      },
    ),
    { numRuns: 500 },
  );
});
test("non-matching labels do not produce route names", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Symphony:", "Route:", "Team:"),
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).filter((l) => {
          const lo = l.toLowerCase();
          return !lo.startsWith("symphony:") && !lo.startsWith("route:") && !lo.startsWith("team:");
        }),
        { minLength: 1, maxLength: 5 },
      ),
      (prefix, labels) => {
        assert.equal(
          routeNames(issueWith({ labels }), makeSettings({ routeLabelPrefix: prefix })).length,
          0,
        );
      },
    ),
    { numRuns: 200 },
  );
});
