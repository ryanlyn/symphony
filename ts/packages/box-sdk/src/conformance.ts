import { describe, expect, test } from "vitest";

import { POOL_OWNED_LABEL } from "./types.js";
import type { BoxDescriptor, BoxDriver, ProvisionRequest } from "./types.js";

/**
 * Shared, parameterized test body that asserts the {@link BoxDriver} contract.
 *
 * This module deliberately lives under `src/` (not `test/`) so it compiles to
 * `dist/` and can be imported by every driver's own test file (fake,
 * static-ssh, and each cloud driver behind its own gate). It registers its own
 * `describe`/`test` blocks, so a caller simply invokes it at the top level of a
 * test file:
 *
 * ```ts
 * runDriverConformanceSuite(() => new FakeBoxDriver(deps), {
 *   suiteName: "FakeBoxDriver",
 *   boxIds: ["box-a", "box-b"],
 *   makeUnreachable: () => ({ driver, boxId: "box-down" }),
 * });
 * ```
 *
 * The contract asserted here is intentionally minimal and driver-agnostic:
 *   1. `provision` is idempotent on `boxId` (same id -> same box).
 *   2. `destroy` is idempotent and tolerant of an already-gone box.
 *   3. `list()` reflects provisioned-minus-destroyed.
 *   4. `probe` gates a created-but-unreachable box to `{ ok: false }`.
 */

/** Options that tailor the shared suite to a specific driver backend. */
export interface ConformanceSuiteOptions {
  /** Label for the `describe` block (e.g. the driver class name). */
  suiteName?: string;
  /**
   * Two distinct, driver-acceptable box ids. For fixed-inventory drivers
   * (static-ssh, `min==max==len`) these must map onto real configured hosts.
   */
  boxIds: readonly [string, string];
  /** Timeout passed to `provision` (defaults to 30s). */
  provisionTimeoutMs?: number;
  /** Timeout passed to `probe` (defaults to 30s). */
  probeTimeoutMs?: number;
  /** Timeout passed to `destroy` (defaults to 30s). */
  destroyTimeoutMs?: number;
  /**
   * Builds a {@link ProvisionRequest} for a given box id. Lets a driver supply
   * its own `labels`/`driverOptions`. Defaults to a minimal request with a
   * single `symphony.box-pool` label and the configured `provisionTimeoutMs`.
   */
  makeProvisionRequest?: (boxId: string) => ProvisionRequest;
  /**
   * Yields a driver plus a box id that is created-but-unreachable, so the
   * suite can assert `probe` returns `{ ok: false }`. Optional: a driver that
   * cannot represent an unreachable-but-created box omits this and the probe
   * gating case is skipped. Both built-in drivers supply it (fake via failure
   * injection, static-ssh via an unroutable host).
   */
  makeUnreachable?: () => { driver: BoxDriver; boxId: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;

function descriptorOf(box: BoxDescriptor): {
  boxId: string;
  workerHost: string;
  driverRef: string;
} {
  return { boxId: box.boxId, workerHost: box.workerHost, driverRef: box.driverRef };
}

/**
 * Registers the shared {@link BoxDriver} conformance tests. `makeDriver`
 * must return a FRESH driver per call so each case starts from a clean
 * inventory.
 */
export function runDriverConformanceSuite(
  makeDriver: () => BoxDriver,
  opts: ConformanceSuiteOptions,
): void {
  const suiteName = opts.suiteName ?? "BoxDriver conformance";
  const provisionTimeoutMs = opts.provisionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const destroyTimeoutMs = opts.destroyTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [boxIdA, boxIdB] = opts.boxIds;

  const provisionRequest = (boxId: string): ProvisionRequest =>
    opts.makeProvisionRequest?.(boxId) ?? {
      boxId,
      labels: ["symphony.box-pool"],
      timeoutMs: provisionTimeoutMs,
    };

  describe(suiteName, () => {
    test("provision is idempotent on boxId", async () => {
      const driver = makeDriver();
      const first = await driver.provision(provisionRequest(boxIdA));
      const second = await driver.provision(provisionRequest(boxIdA));

      // Same idempotency key must yield the same box identity (no duplicate).
      expect(first.boxId).toBe(boxIdA);
      expect(descriptorOf(second)).toEqual(descriptorOf(first));

      // A second provision must NOT create a duplicate in the inventory.
      const listed = await driver.list();
      const matching = listed.filter((box) => box.boxId === boxIdA);
      expect(matching).toHaveLength(1);
    });

    test("list() descriptors carry the pool-owned label", async () => {
      // The pool's hydrate re-adoption and reaper reconcile gate ONLY re-adopt /
      // destroy survivors whose list() descriptor carries POOL_OWNED_LABEL. A
      // descriptor missing it is NEVER touched, so for a driver that creates
      // disposable, pool-owned boxes (ephemeral), a leaked survivor (e.g. a paid
      // E2B/Modal/Fly/Docker box left by a crashed daemon) would leak forever.
      // Pinning the label on every ephemeral driver's list() descriptors
      // catches that class of bug going forward.
      //
      // Non-ephemeral drivers (fixed-inventory static-ssh, in-memory fake) own
      // no disposable resource the pool re-adopts/reaps via this gate, so the
      // label is not load-bearing for them and the assertion does not apply.
      const driver = makeDriver();
      if (!driver.capabilities.ephemeral) return;

      await driver.provision(provisionRequest(boxIdA));

      const listed = await driver.list();
      expect(listed.length).toBeGreaterThan(0);
      for (const box of listed) {
        expect(box.labels).toContain(POOL_OWNED_LABEL);
      }
    });

    test("list() reflects provisioned-minus-destroyed", async () => {
      const driver = makeDriver();
      const a = await driver.provision(provisionRequest(boxIdA));
      const b = await driver.provision(provisionRequest(boxIdB));

      const afterProvision = (await driver.list()).map((box) => box.boxId).sort();
      expect(afterProvision).toContain(boxIdA);
      expect(afterProvision).toContain(boxIdB);

      await driver.destroy(b, { timeoutMs: destroyTimeoutMs, reason: "shrink" });

      const afterDestroy = (await driver.list()).map((box) => box.boxId);
      // The surviving box is still listed; the destroyed one is gone.
      expect(afterDestroy).toContain(a.boxId);
      expect(afterDestroy).not.toContain(b.boxId);
    });

    test("destroy is idempotent (already-gone is ok)", async () => {
      const driver = makeDriver();
      const box = await driver.provision(provisionRequest(boxIdA));

      // Destroying twice must not throw; the box is gone after the first call.
      await driver.destroy(box, { timeoutMs: destroyTimeoutMs, reason: "idle" });
      await driver.destroy(box, { timeoutMs: destroyTimeoutMs, reason: "idle" });

      const listed = (await driver.list()).map((entry) => entry.boxId);
      expect(listed).not.toContain(box.boxId);
    });

    test("destroy of a never-provisioned box is a no-op (does not throw)", async () => {
      const driver = makeDriver();
      const phantom: BoxDescriptor = {
        boxId: boxIdA,
        workerHost: "unknown",
        driverRef: "unknown",
        createdAtMs: 0,
        labels: ["symphony.box-pool"],
        metadata: {},
      };

      // Destroying a box the driver has never seen must be tolerated.
      await driver.destroy(phantom, { timeoutMs: destroyTimeoutMs, reason: "orphan" });
    });

    if (opts.makeUnreachable) {
      const makeUnreachable = opts.makeUnreachable;
      test("probe gates a created-but-unreachable box to ok:false", async () => {
        const { driver, boxId } = makeUnreachable();
        const box = await driver.provision(provisionRequest(boxId));

        const health = await driver.probe(box, { timeoutMs: probeTimeoutMs });
        expect(health.ok).toBe(false);
        if (!health.ok) {
          // The failure must carry a non-empty reason for diagnostics.
          expect(typeof health.reason).toBe("string");
          expect(health.reason.length).toBeGreaterThan(0);
        }
      });
    }
  });
}
