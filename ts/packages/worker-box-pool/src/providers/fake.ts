import type { BoxPoolProvider } from "@symphony/domain";

import type {
  BoxDescriptor,
  BoxHealth,
  BoxProvider,
  ProviderCapabilities,
  ProviderDeps,
  ProvisionRequest,
  TeardownReason,
} from "../types.js";

const KIND: BoxPoolProvider = "fake";

const CAPABILITIES: ProviderCapabilities = {
  sshAddressable: false,
  ephemeral: false,
  usesLedger: false,
};

/**
 * An in-memory {@link BoxProvider} used by the always-on test layer and the
 * memory-tracker e2e demo. It owns no real machines and touches no disk: every
 * operation mutates a `Map<boxId, BoxDescriptor>` and the yielded `workerHost`
 * is a synthetic `fake://box-<boxId>` address. Determinism comes from the
 * injected {@link ClockPort} (so `createdAtMs` is reproducible), and failure can
 * be injected per-box so tests can exercise probe/provision/destroy faults and
 * the conformance suite's unreachable-box case.
 */
export class FakeBoxProvider implements BoxProvider {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  // The live inventory: provisioned-minus-destroyed, keyed on the pool's
  // idempotency key so `provision` is idempotent on `boxId`.
  private readonly boxes = new Map<string, BoxDescriptor>();

  // Per-box failure injections. `probeFailures` flips `probe` to `{ ok: false }`;
  // `provisionFailures`/`destroyFailures` reject the respective call.
  private readonly probeFailures = new Map<string, string>();
  private readonly provisionFailures = new Map<string, string>();
  private readonly destroyFailures = new Map<string, string>();

  // A write counter that proves the provider never touched the disk. It is
  // structurally pinned at 0 (the provider holds only in-memory state), so a
  // test can assert ZERO fs I/O by reading `fsWriteCount`.
  private writes = 0;

  constructor(private readonly deps: ProviderDeps) {}

  /** Number of fs writes performed (always 0; the provider is purely in-memory). */
  get fsWriteCount(): number {
    return this.writes;
  }

  /**
   * Provisions (or re-adopts) a box for `req.boxId`. Idempotent on `boxId`: a
   * second call returns the SAME descriptor without creating a duplicate. The
   * descriptor is stamped from the injected clock so its `createdAtMs` is
   * deterministic.
   */
  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    const injected = this.provisionFailures.get(req.boxId);
    if (injected !== undefined) {
      return Promise.reject(new Error(injected));
    }

    const existing = this.boxes.get(req.boxId);
    if (existing) {
      return Promise.resolve(existing);
    }

    const workerHost = `fake://box-${req.boxId}`;
    const descriptor: BoxDescriptor = {
      boxId: req.boxId,
      workerHost,
      providerRef: workerHost,
      createdAtMs: this.deps.clock.now().getTime(),
      labels: [...req.labels],
      metadata: {},
    };
    this.boxes.set(req.boxId, descriptor);
    return Promise.resolve(descriptor);
  }

  /**
   * Reports the box healthy unless a probe failure was injected for its
   * `boxId`. An unknown/already-destroyed box is reported `ok: false` rather
   * than throwing (mirroring a real probe against a gone machine).
   */
  async probe(
    box: BoxDescriptor,
    _opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<BoxHealth> {
    const injected = this.probeFailures.get(box.boxId);
    if (injected !== undefined) {
      return Promise.resolve({ ok: false, reason: injected });
    }
    if (!this.boxes.has(box.boxId)) {
      return Promise.resolve({ ok: false, reason: "fake_box_not_found" });
    }
    return Promise.resolve({ ok: true });
  }

  /**
   * Destroys a box. Idempotent and tolerant of an already-gone (or
   * never-provisioned) box. Rejects only when a destroy failure was injected
   * for the box, leaving the box in place so the caller can retry.
   */
  async destroy(
    box: BoxDescriptor,
    _opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    const injected = this.destroyFailures.get(box.boxId);
    if (injected !== undefined) {
      return Promise.reject(new Error(injected));
    }
    this.boxes.delete(box.boxId);
    return Promise.resolve();
  }

  /** Returns the live inventory (provisioned-minus-destroyed). */
  async list(): Promise<BoxDescriptor[]> {
    return Promise.resolve([...this.boxes.values()]);
  }

  /** Injects a probe failure so `probe` returns `{ ok: false, reason }`. */
  injectProbeFailure(boxId: string, reason: string): void {
    this.probeFailures.set(boxId, reason);
  }

  /** Clears a previously injected probe failure so the box probes healthy again. */
  clearProbeFailure(boxId: string): void {
    this.probeFailures.delete(boxId);
  }

  /** Injects a provision failure so `provision` rejects with `reason`. */
  injectProvisionFailure(boxId: string, reason: string): void {
    this.provisionFailures.set(boxId, reason);
  }

  /** Clears a previously injected provision failure. */
  clearProvisionFailure(boxId: string): void {
    this.provisionFailures.delete(boxId);
  }

  /** Injects a destroy failure so `destroy` rejects with `reason`. */
  injectDestroyFailure(boxId: string, reason: string): void {
    this.destroyFailures.set(boxId, reason);
  }

  /** Clears a previously injected destroy failure. */
  clearDestroyFailure(boxId: string): void {
    this.destroyFailures.delete(boxId);
  }
}
