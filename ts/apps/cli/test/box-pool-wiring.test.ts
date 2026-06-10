import { afterEach, test } from "vitest";
import { parseConfig } from "@symphony/config";
import { clearBoxProviderRegistry, registerBuiltInBoxProviders } from "@symphony/worker-box-pool";

import { assert } from "../../../test/assert.js";
import { assertSlotsPerMachineGate } from "../src/main.js";

import {
  buildBoxPool,
  buildDispatchCoordinator,
  createBoxPool,
  resolveProvider,
  FakeBoxProvider,
  StaticSshBoxProvider,
} from "@symphony/cli";

afterEach(() => {
  // Built-in providers self-register at barrel load; restore them after any
  // test that clears the shared module-level registry for isolation.
  registerBuiltInBoxProviders();
});

test("buildBoxPool returns undefined when the pool is disabled (byte-identical path)", () => {
  const settings = parseConfig({}, {});
  assert.equal(settings.worker.boxPool, undefined);
  assert.equal(buildBoxPool(settings, {}), undefined);
});

test("buildBoxPool returns undefined when box_pool is present but enabled:false", () => {
  const settings = parseConfig({ worker: { box_pool: { enabled: false, provider: "fake" } } }, {});
  assert.equal(settings.worker.boxPool?.enabled, false);
  assert.equal(buildBoxPool(settings, {}), undefined);
});

test("buildBoxPool constructs an enabled fake pool with a workspace-scoped ledger path", () => {
  const settings = parseConfig(
    { worker: { box_pool: { enabled: true, provider: "fake", max: 2, warm: 1 } } },
    {},
  );
  const boxPool = buildBoxPool(settings, {});
  assert.ok(boxPool);

  const snapshot = boxPool!.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.provider, "fake");
  // Drain must be awaitable so main.ts can await runtime.drainBoxPool() on exit.
  assert.equal(typeof boxPool!.drain, "function");
  assert.equal(typeof boxPool!.hydrate, "function");
  assert.equal(typeof boxPool!.canAcquire, "function");
});

test("buildBoxPool throws box_pool_provider_unavailable for an unregistered enabled kind", () => {
  const settings = parseConfig({ worker: { box_pool: { enabled: true, provider: "fake" } } }, {});
  clearBoxProviderRegistry();
  assert.throws(() => buildBoxPool(settings, {}), /box_pool_provider_unavailable/);
});

test("CLI re-exports the worker-box-pool public API for live/e2e tests", () => {
  assert.equal(typeof createBoxPool, "function");
  assert.equal(typeof resolveProvider, "function");
  assert.equal(typeof FakeBoxProvider, "function");
  assert.equal(typeof StaticSshBoxProvider, "function");
});

// --- STEP 3 post-construction gate ---------------------------------------
// `assertSlotsPerMachineGate` is the single mechanical safety that lives where
// the coordinator capability is actually known (after buildDispatchCoordinator).
// It enforces TWO conditions for slotsPerMachine>1: the runtime perRunEndpoint
// capability AND the explicit operator co-residence opt-in. slotsPerMachine===1
// always passes (the gate never triggers) so the default path is byte-identical.

const capable = { capabilities: { perRunEndpoint: true } } as const;
const incapable = { capabilities: { perRunEndpoint: false } } as const;

function gateSettings(boxPool: Record<string, unknown> | undefined) {
  return parseConfig(boxPool ? { worker: { box_pool: boxPool } } : {});
}

test("gate: slotsPerMachine>1 with perRunEndpoint=false throws", () => {
  const settings = gateSettings({
    enabled: true,
    provider: "fake",
    max_in_flight: 2,
    co_residence: true,
  });
  assert.throws(
    () => assertSlotsPerMachineGate(settings, incapable),
    /per-run.*endpoint|perRunEndpoint/i,
  );
});

test("gate: slotsPerMachine>1 with perRunEndpoint=true but coResidence absent throws", () => {
  const settings = gateSettings({ enabled: true, provider: "fake", max_in_flight: 2 });
  assert.equal(settings.worker.boxPool?.coResidence, undefined);
  assert.throws(() => assertSlotsPerMachineGate(settings, capable), /co.?residence/i);
});

test("gate: slotsPerMachine>1 with perRunEndpoint=true but coResidence=false throws", () => {
  const settings = gateSettings({
    enabled: true,
    provider: "fake",
    max_in_flight: 2,
    co_residence: false,
  });
  assert.throws(() => assertSlotsPerMachineGate(settings, capable), /co.?residence/i);
});

test("gate: slotsPerMachine>1 with perRunEndpoint AND coResidence passes", () => {
  const settings = gateSettings({
    enabled: true,
    provider: "fake",
    max_in_flight: 2,
    co_residence: true,
  });
  // Does not throw.
  assertSlotsPerMachineGate(settings, capable);
});

test("gate: DISABLED pool with max_in_flight>1 does not abort daemon startup", () => {
  // A dormant max_in_flight>1 on a DISABLED pool must not gate startup: the pool
  // is off (runs go static/local), so buildDispatchCoordinator returns undefined
  // and assertSlotsPerMachineGate(settings, undefined) must NOT throw. Before the
  // fix this fail-closed regression aborted the daemon over a value never used.
  const settings = gateSettings({ enabled: false, provider: "fake", max_in_flight: 2 });
  assert.equal(settings.worker.boxPool?.enabled, false);
  assert.equal(settings.worker.boxPool?.slotsPerMachine, 2);
  const coordinator = buildDispatchCoordinator(settings, {});
  assert.equal(coordinator, undefined);
  // Does not throw: daemon startup proceeds on the static/local path.
  assertSlotsPerMachineGate(settings, coordinator);
});

test("gate: default slotsPerMachine=1 always passes regardless of capability/opt-in", () => {
  // Enabled pool, default slots, no capability, no opt-in: gate never triggers.
  const enabledDefault = gateSettings({ enabled: true, provider: "fake" });
  assert.equal(enabledDefault.worker.boxPool?.slotsPerMachine, 1);
  assertSlotsPerMachineGate(enabledDefault, incapable);
  assertSlotsPerMachineGate(enabledDefault, capable);

  // Absent box_pool / absent coordinator: byte-identical no-op.
  const noPool = gateSettings(undefined);
  assert.equal(noPool.worker.boxPool, undefined);
  assertSlotsPerMachineGate(noPool, undefined);
});
