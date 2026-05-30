import { test } from "vitest";
import fc from "fast-check";
import { selectLeastLoadedHost } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

// --- Helper arbitraries ---

/** Generate a non-empty host name with diverse characters */
const arbHostName = () =>
  fc.oneof(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.constantFrom("host-a", "host-b", "host-c", "us-east-1", "192.168.0.1", "\u{1F600}", ""),
  ).filter((s) => s.length > 0);

/** Generate a list of hosts (possibly with duplicates) */
const arbHosts = () => fc.array(arbHostName(), { minLength: 0, maxLength: 12 });

/** Generate a non-empty list of hosts */
const arbNonEmptyHosts = () => fc.array(arbHostName(), { minLength: 1, maxLength: 12 });

/** Generate a cap value (including edge values like 0 and large numbers) */
const arbCap = () =>
  fc.oneof(fc.integer({ min: 0, max: 100 }), fc.constantFrom(0, 1, 1000));

/** Generate running counts for a set of hosts */
const arbRunningCounts = (hosts: string[]) => {
  const entries: [string, number][] = hosts.map((h) => [
    h,
    fc.sample(fc.nat({ max: 50 }), 1)[0]!,
  ]);
  return new Map(entries);
};

// --- Invariant 1 ---
// When a host is selected, it SHALL be from the configured list or "no host available" SHALL be returned.
test("Invariant 1: selected host is from configured list, or null/undefined is returned", () => {
  fc.assert(
    fc.property(arbHosts(), arbCap(), (hosts, cap) => {
      const runningCounts = arbRunningCounts(hosts);
      const result = selectLeastLoadedHost({ hosts, runningCounts, cap });

      // Result must be null (empty list), undefined (all at cap), or a member of hosts
      if (result === null || result === undefined) return;
      assert.ok(hosts.includes(result));
    }),
    { numRuns: 200 },
  );
});

// --- Invariant 2 ---
// When hosts are evaluated, only hosts with load strictly below the cap SHALL be considered.
test("Invariant 2: selected host always has load strictly below the cap", () => {
  fc.assert(
    fc.property(arbHosts(), arbCap(), (hosts, cap) => {
      const runningCounts = arbRunningCounts(hosts);
      const result = selectLeastLoadedHost({ hosts, runningCounts, cap });

      if (typeof result !== "string") return;
      const count = runningCounts.get(result) ?? 0;
      assert.ok(count < cap);
    }),
    { numRuns: 200 },
  );
});

// --- Invariant 3 ---
// When multiple hosts are below the cap, the host with the lowest load SHALL be selected.
test("Invariant 3: selected host has the lowest load among all hosts below cap", () => {
  fc.assert(
    fc.property(arbNonEmptyHosts(), arbCap(), (hosts, cap) => {
      const runningCounts = arbRunningCounts(hosts);
      const result = selectLeastLoadedHost({ hosts, runningCounts, cap });

      if (typeof result !== "string") return;

      const selectedCount = runningCounts.get(result) ?? 0;

      // No other host in the list should have a count that is both below cap and strictly less than selectedCount
      for (const host of hosts) {
        const count = runningCounts.get(host) ?? 0;
        if (count < cap) {
          assert.ok(
            count >= selectedCount,
          );
        }
      }
    }),
    { numRuns: 200 },
  );
});

// --- Invariant 4 ---
// When the host list is empty, "no host available" SHALL be returned.
test("Invariant 4: empty host list returns null (no host available)", () => {
  fc.assert(
    fc.property(arbCap(), (cap) => {
      const result = selectLeastLoadedHost({
        hosts: [],
        runningCounts: new Map(),
        cap,
      });
      assert.equal(result, null);
    }),
    { numRuns: 100 },
  );
});

// --- Invariant 5 ---
// When at least one host is below the cap, the system SHALL always select a host (no false starvation).
test("Invariant 5: if at least one host is below cap, a host string is returned (no false starvation)", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbHostName(), { minLength: 1, maxLength: 12 }),
      fc.integer({ min: 1, max: 100 }),
      (hosts, cap) => {
        // Construct running counts ensuring at least one host is strictly below cap
        const runningCounts = new Map<string, number>();
        // Force the first host to have count 0 (below any cap >= 1)
        runningCounts.set(hosts[0]!, 0);
        for (let i = 1; i < hosts.length; i++) {
          runningCounts.set(hosts[i]!, fc.sample(fc.nat({ max: cap + 10 }), 1)[0]!);
        }

        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
        assert.equal(typeof result, "string");
      },
    ),
    { numRuns: 200 },
  );
});
