import { describe, expect, test } from "vitest";

import { POOL_OWNED_LABEL } from "./types.js";
import type { BoxDescriptor, BoxProvider, ProvisionRequest } from "./types.js";

/**
 * Shared, parameterized test body that asserts the {@link BoxProvider} contract.
 *
 * This module deliberately lives under `src/` (not `test/`) so it compiles to
 * `dist/` and can be imported by every provider's own test file (fake,
 * static-ssh, and each cloud driver behind its own gate). It registers its own
 * `describe`/`test` blocks, so a caller simply invokes it at the top level of a
 * test file:
 *
 * ```ts
 * runProviderConformanceSuite(() => new FakeBoxProvider(deps), {
 *   suiteName: "FakeBoxProvider",
 *   boxIds: ["box-a", "box-b"],
 *   makeUnreachable: () => ({ provider, boxId: "box-down" }),
 * });
 * ```
 *
 * The contract asserted here is intentionally minimal and provider-agnostic:
 *   1. `provision` is idempotent on `boxId` (same id -> same box).
 *   2. `destroy` is idempotent and tolerant of an already-gone box.
 *   3. `list()` reflects provisioned-minus-destroyed.
 *   4. `probe` gates a created-but-unreachable box to `{ ok: false }`.
 */

/** Options that tailor the shared suite to a specific provider backend. */
export interface ConformanceSuiteOptions {
  /** Label for the `describe` block (e.g. the provider class name). */
  suiteName?: string;
  /**
   * Two distinct, provider-acceptable box ids. For fixed-inventory providers
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
   * Builds a {@link ProvisionRequest} for a given box id. Lets a provider supply
   * its own `labels`/`providerOptions`. Defaults to a minimal request with a
   * single `symphony.box-pool` label and the configured `provisionTimeoutMs`.
   */
  makeProvisionRequest?: (boxId: string) => ProvisionRequest;
  /**
   * Yields a provider plus a box id that is created-but-unreachable, so the
   * suite can assert `probe` returns `{ ok: false }`. Optional: a provider that
   * cannot represent an unreachable-but-created box omits this and the probe
   * gating case is skipped. Both built-in providers supply it (fake via failure
   * injection, static-ssh via an unroutable host).
   */
  makeUnreachable?: () => { provider: BoxProvider; boxId: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;

function descriptorOf(box: BoxDescriptor): {
  boxId: string;
  workerHost: string;
  providerRef: string;
} {
  return { boxId: box.boxId, workerHost: box.workerHost, providerRef: box.providerRef };
}

/**
 * Registers the shared {@link BoxProvider} conformance tests. `makeProvider`
 * must return a FRESH provider per call so each case starts from a clean
 * inventory.
 */
export function runProviderConformanceSuite(
  makeProvider: () => BoxProvider,
  opts: ConformanceSuiteOptions,
): void {
  const suiteName = opts.suiteName ?? "BoxProvider conformance";
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
      const provider = makeProvider();
      const first = await provider.provision(provisionRequest(boxIdA));
      const second = await provider.provision(provisionRequest(boxIdA));

      // Same idempotency key must yield the same box identity (no duplicate).
      expect(first.boxId).toBe(boxIdA);
      expect(descriptorOf(second)).toEqual(descriptorOf(first));

      // A second provision must NOT create a duplicate in the inventory.
      const listed = await provider.list();
      const matching = listed.filter((box) => box.boxId === boxIdA);
      expect(matching).toHaveLength(1);
    });

    test("list() descriptors carry the pool-owned label", async () => {
      // The pool's hydrate re-adoption and reaper reconcile gate ONLY re-adopt /
      // destroy survivors whose list() descriptor carries POOL_OWNED_LABEL. A
      // descriptor missing it is NEVER touched, so for a provider that creates
      // disposable, pool-owned boxes (ephemeral), a leaked survivor (e.g. a paid
      // E2B/Modal/Fly/Docker box left by a crashed daemon) would leak forever.
      // Pinning the label on every ephemeral provider's list() descriptors
      // catches that class of bug going forward.
      //
      // Non-ephemeral providers (fixed-inventory static-ssh, in-memory fake) own
      // no disposable resource the pool re-adopts/reaps via this gate, so the
      // label is not load-bearing for them and the assertion does not apply.
      const provider = makeProvider();
      if (!provider.capabilities.ephemeral) return;

      await provider.provision(provisionRequest(boxIdA));

      const listed = await provider.list();
      expect(listed.length).toBeGreaterThan(0);
      for (const box of listed) {
        expect(box.labels).toContain(POOL_OWNED_LABEL);
      }
    });

    test("list() reflects provisioned-minus-destroyed", async () => {
      const provider = makeProvider();
      const a = await provider.provision(provisionRequest(boxIdA));
      const b = await provider.provision(provisionRequest(boxIdB));

      const afterProvision = (await provider.list()).map((box) => box.boxId).sort();
      expect(afterProvision).toContain(boxIdA);
      expect(afterProvision).toContain(boxIdB);

      await provider.destroy(b, { timeoutMs: destroyTimeoutMs, reason: "shrink" });

      const afterDestroy = (await provider.list()).map((box) => box.boxId);
      // The surviving box is still listed; the destroyed one is gone.
      expect(afterDestroy).toContain(a.boxId);
      expect(afterDestroy).not.toContain(b.boxId);
    });

    test("destroy is idempotent (already-gone is ok)", async () => {
      const provider = makeProvider();
      const box = await provider.provision(provisionRequest(boxIdA));

      // Destroying twice must not throw; the box is gone after the first call.
      await provider.destroy(box, { timeoutMs: destroyTimeoutMs, reason: "idle" });
      await provider.destroy(box, { timeoutMs: destroyTimeoutMs, reason: "idle" });

      const listed = (await provider.list()).map((entry) => entry.boxId);
      expect(listed).not.toContain(box.boxId);
    });

    test("destroy of a never-provisioned box is a no-op (does not throw)", async () => {
      const provider = makeProvider();
      const phantom: BoxDescriptor = {
        boxId: boxIdA,
        workerHost: "unknown",
        providerRef: "unknown",
        createdAtMs: 0,
        labels: ["symphony.box-pool"],
        metadata: {},
      };

      // Destroying a box the provider has never seen must be tolerated.
      await provider.destroy(phantom, { timeoutMs: destroyTimeoutMs, reason: "orphan" });
    });

    if (opts.makeUnreachable) {
      const makeUnreachable = opts.makeUnreachable;
      test("probe gates a created-but-unreachable box to ok:false", async () => {
        const { provider, boxId } = makeUnreachable();
        const box = await provider.provision(provisionRequest(boxId));

        const health = await provider.probe(box, { timeoutMs: probeTimeoutMs });
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
