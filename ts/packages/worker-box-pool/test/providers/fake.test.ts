import { test } from "vitest";
import type { ClockPort, TimerHandle } from "@symphony/ports";

import { assert } from "../../../../test/assert.js";
import { runProviderConformanceSuite } from "../../src/conformance.js";
import { FakeBoxProvider } from "../../src/providers/fake.js";
import type { ProviderDeps } from "../../src/types.js";

// A deterministic clock so `createdAtMs` is reproducible and the provider does no
// wall-clock reads of its own. `setTimeout`/`clearTimeout` are unused by the
// provider (it owns no timers) but the ClockPort shape requires them.
function fixedClock(initial: Date): { clock: ClockPort; set(next: Date): void } {
  let current = initial;
  const clock: ClockPort = {
    now: () => current,
    setTimeout: (): TimerHandle => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
  return {
    clock,
    set(next: Date) {
      current = next;
    },
  };
}

function makeDeps(at = new Date("2026-05-29T10:00:00.000Z")): ProviderDeps {
  return { clock: fixedClock(at).clock, logEvent: () => undefined };
}

// Run the shared provider contract over a fresh FakeBoxProvider per case. The
// unreachable variant injects a probe failure so the probe-gating case can
// assert `{ ok: false }`.
runProviderConformanceSuite(() => new FakeBoxProvider(makeDeps()), {
  suiteName: "FakeBoxProvider",
  boxIds: ["box-a", "box-b"],
  makeUnreachable: () => {
    const provider = new FakeBoxProvider(makeDeps());
    provider.injectProbeFailure("box-down", "fake_unreachable");
    return { provider, boxId: "box-down" };
  },
});

test("provision yields a synthetic fake:// workerHost deterministic on the clock", async () => {
  const at = new Date("2026-05-29T10:00:00.000Z");
  const provider = new FakeBoxProvider(makeDeps(at));

  const box = await provider.provision({
    boxId: "box-1",
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });

  // The yielded workerHost is the synthetic fake://box-<boxId> address and the
  // descriptor is stamped from the injected clock (no real wall-clock read).
  assert.equal(box.boxId, "box-1");
  assert.equal(box.workerHost, "fake://box-box-1");
  assert.equal(box.providerRef, "fake://box-box-1");
  assert.equal(box.createdAtMs, at.getTime());
  assert.deepEqual(box.labels, ["symphony.box-pool"]);
});

test("provision is idempotent on boxId (same descriptor, single inventory entry)", async () => {
  const provider = new FakeBoxProvider(makeDeps());

  const first = await provider.provision({ boxId: "box-1", labels: [], timeoutMs: 30_000 });
  const second = await provider.provision({ boxId: "box-1", labels: [], timeoutMs: 30_000 });

  assert.deepEqual(second, first);
  const listed = await provider.list();
  assert.equal(listed.filter((box) => box.boxId === "box-1").length, 1);
});

test("destroy is idempotent (a second destroy of a gone box does not throw)", async () => {
  const provider = new FakeBoxProvider(makeDeps());
  const box = await provider.provision({ boxId: "box-1", labels: [], timeoutMs: 30_000 });

  await provider.destroy(box, { timeoutMs: 30_000, reason: "idle" });
  await provider.destroy(box, { timeoutMs: 30_000, reason: "idle" });

  const listed = (await provider.list()).map((entry) => entry.boxId);
  assert.equal(listed.includes("box-1"), false);
});

test("capabilities are { sshAddressable:false, ephemeral:false, usesLedger:false }", () => {
  const provider = new FakeBoxProvider(makeDeps());
  assert.deepEqual(provider.capabilities, {
    sshAddressable: false,
    ephemeral: false,
    usesLedger: false,
  });
  assert.equal(provider.kind, "fake");
});

test("probe is ok by default but ok:false once a probe failure is injected", async () => {
  const provider = new FakeBoxProvider(makeDeps());
  const box = await provider.provision({ boxId: "box-1", labels: [], timeoutMs: 30_000 });

  const healthy = await provider.probe(box, { timeoutMs: 30_000 });
  assert.equal(healthy.ok, true);

  provider.injectProbeFailure("box-1", "boom");
  const unhealthy = await provider.probe(box, { timeoutMs: 30_000 });
  assert.equal(unhealthy.ok, false);
  if (!unhealthy.ok) {
    assert.equal(unhealthy.reason, "boom");
  }

  // Clearing the injection restores the box to healthy.
  provider.clearProbeFailure("box-1");
  const recovered = await provider.probe(box, { timeoutMs: 30_000 });
  assert.equal(recovered.ok, true);
});

test("injected provision failure rejects with the configured error", async () => {
  const provider = new FakeBoxProvider(makeDeps());
  provider.injectProvisionFailure("box-1", "provision_boom");

  await assert.rejects(
    () => provider.provision({ boxId: "box-1", labels: [], timeoutMs: 30_000 }),
    /provision_boom/,
  );

  // The failed provision leaves nothing behind in the inventory.
  assert.deepEqual(await provider.list(), []);
});

test("injected destroy failure rejects with the configured error", async () => {
  const provider = new FakeBoxProvider(makeDeps());
  const box = await provider.provision({ boxId: "box-1", labels: [], timeoutMs: 30_000 });
  provider.injectDestroyFailure("box-1", "destroy_boom");

  await assert.rejects(
    () => provider.destroy(box, { timeoutMs: 30_000, reason: "idle" }),
    /destroy_boom/,
  );

  // A failed destroy leaves the box in place (the caller must retry).
  const listed = (await provider.list()).map((entry) => entry.boxId);
  assert.equal(listed.includes("box-1"), true);
});

test("performs ZERO fs writes across a full provision/probe/destroy cycle", async () => {
  const provider = new FakeBoxProvider(makeDeps());

  const box = await provider.provision({ boxId: "box-1", labels: [], timeoutMs: 30_000 });
  await provider.probe(box, { timeoutMs: 30_000 });
  await provider.list();
  await provider.destroy(box, { timeoutMs: 30_000, reason: "idle" });

  // The fake provider is purely in-memory: it must never touch the disk. The
  // counter proves no fs write path was ever taken (it would only advance if the
  // provider wrote a byte, which it must not).
  assert.equal(provider.fsWriteCount, 0);
});
