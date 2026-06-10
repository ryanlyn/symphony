import { afterEach, beforeEach, test } from "vitest";
import type { BoxPoolProvider, BoxPoolSettings } from "@symphony/domain";
import { systemClock } from "@symphony/ports";

import { assert } from "../../../test/assert.js";
import { clearBoxProviderRegistry, registerBoxProvider, resolveProvider } from "../src/registry.js";
import type { BoxProvider, ProviderDeps } from "../src/types.js";

// A minimal settings object; the registry never reads its fields, it only passes
// it through to the factory, so the exact values do not matter for these tests.
const settings: BoxPoolSettings = {
  enabled: true,
  provider: "fake",
  min: 0,
  max: 1,
  warm: 1,
  maxInFlight: 1,
  ttlMs: 3_600_000,
  idleReapMs: 300_000,
  acquireTimeoutMs: 30_000,
  reapIntervalMs: 15_000,
  staleHeartbeatMs: 600_000,
  drainDeadlineMs: 30_000,
};

const deps: ProviderDeps = {
  clock: systemClock,
  logEvent: () => undefined,
};

// A stub provider just sufficient to satisfy the BoxProvider shape; the registry
// tests only care that the registered factory's product is handed back verbatim.
function makeStubProvider(kind: BoxPoolProvider): BoxProvider {
  return {
    kind,
    provision: async () => {
      throw new Error("not implemented");
    },
    probe: async () => ({ ok: true }),
    destroy: async () => undefined,
    list: async () => [],
    capabilities: { sshAddressable: false, ephemeral: false, usesLedger: false },
  };
}

beforeEach(() => {
  clearBoxProviderRegistry();
});

afterEach(() => {
  clearBoxProviderRegistry();
});

test("resolveProvider returns the product of the registered factory", () => {
  const stub = makeStubProvider("fake");
  let receivedSettings: BoxPoolSettings | null = null;
  let receivedDeps: ProviderDeps | null = null;
  registerBoxProvider("fake", (s, d) => {
    receivedSettings = s;
    receivedDeps = d;
    return stub;
  });

  const resolved = resolveProvider("fake", settings, deps);

  // The exact instance is handed back, and the factory saw the same settings/deps.
  assert.equal(resolved, stub);
  assert.equal(receivedSettings, settings);
  assert.equal(receivedDeps, deps);
});

test("resolveProvider throws box_pool_provider_unavailable for an unregistered kind", () => {
  // Nothing registered for `static-ssh`, so resolution must fail loud with the
  // typed code (consumed by the daemon at startup to fail fast).
  assert.throws(
    () => resolveProvider("static-ssh", settings, deps),
    /box_pool_provider_unavailable: static-ssh/,
  );
});

test("registerBoxProvider overrides a prior factory for the same kind", () => {
  const first = makeStubProvider("fake");
  const second = makeStubProvider("fake");
  registerBoxProvider("fake", () => first);
  registerBoxProvider("fake", () => second);

  // The most recent registration wins.
  assert.equal(resolveProvider("fake", settings, deps), second);
});

test("clearBoxProviderRegistry isolates registrations between tests", () => {
  registerBoxProvider("fake", () => makeStubProvider("fake"));

  clearBoxProviderRegistry();

  // After clearing, the previously registered kind is gone again.
  assert.throws(
    () => resolveProvider("fake", settings, deps),
    /box_pool_provider_unavailable: fake/,
  );
});
