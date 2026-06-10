import type { BoxPoolProvider, BoxPoolSettings } from "@symphony/domain";
import { runSsh as defaultRunSsh, type SshRunOptions, type SshRunResult } from "@symphony/ssh";

import { POOL_OWNED_LABEL } from "../types.js";
import type {
  BoxDescriptor,
  BoxHealth,
  BoxProvider,
  ProviderCapabilities,
  ProviderDeps,
  ProvisionRequest,
  TeardownReason,
} from "../types.js";

const KIND: BoxPoolProvider = "modal";

/**
 * SSH-ADDRESSABLE TRANSPORT ASSUMPTION. Symphony's executor reaches a worker
 * over SSH, so this driver assumes the Modal Sandbox is provisioned to run
 * `sshd` and expose an SSH endpoint (e.g. `modal@<sandbox>.modal.host:2200`).
 * That endpoint is returned verbatim as the box `workerHost` and is what the
 * probe + runner connect to. A non-SSH / native-exec Modal integration would
 * require executor changes and is OUT OF SCOPE here (a possible future
 * extension). Hence `capabilities.sshAddressable` is `true`.
 */
const CAPABILITIES: ProviderCapabilities = {
  // Modal sandboxes are reached over SSH (see the assumption above).
  sshAddressable: true,
  // Sandboxes are disposable machines created/terminated per pool decision.
  ephemeral: true,
  // A cloud provider: pool-owned survivors are tracked in the write-ahead ledger.
  usesLedger: true,
};

/** The readiness command the probe runs over SSH (a cheap liveness check). */
const PROBE_COMMAND = "printf ready";

/**
 * The label the pool stamps on every box it owns. `list()` filters on this so a
 * reconcile only adopts sandboxes this pool provisioned (never a foreign one).
 */
const POOL_LABEL = "symphony.box-pool";

/** Injectable SSH transport so tests can spy on the probe argv/timeout. */
type RunSsh = (host: string, command: string, options?: SshRunOptions) => Promise<SshRunResult>;

/**
 * A live Modal Sandbox as seen through the transport. `sandboxId` is Modal's own
 * handle (used for `terminate`/`list` reconcile); `sshHost` is the SSH endpoint
 * the sandbox exposes; `labels` are the tags stamped at create time so a
 * `list()` reconcile can re-adopt pool-owned survivors.
 */
export interface ModalSandbox {
  sandboxId: string;
  sshHost: string;
  labels: ReadonlyArray<string>;
}

/**
 * Request handed to the transport to create a sandbox. `labels` are stamped on
 * the sandbox (pool label + a boxId-derived label so survivors correlate back to
 * a `boxId`); `image` is the optional base image from `providerOptions.image`.
 */
export interface ModalCreateRequest {
  labels: ReadonlyArray<string>;
  image?: string | undefined;
}

/**
 * The Modal seam. Deliberately abstract so this package takes NO hard dependency
 * on the Modal client/CLI: the daemon injects either a CLI-shelling transport or
 * a Modal-client-backed one, and the always-on tests inject an in-memory fake.
 * `create` boots a sandbox exposing an SSH endpoint; `terminate` removes it
 * (idempotent at the Modal level); `list` enumerates sandboxes carrying a label.
 */
export interface ModalTransport {
  create(req: ModalCreateRequest): Promise<ModalSandbox>;
  terminate(sandboxId: string): Promise<void>;
  list(opts: { label: string }): Promise<ModalSandbox[]>;
}

/** Dependency overrides (test seams for the Modal transport + SSH transport). */
export interface ModalProviderOverrides {
  transport: ModalTransport;
  runSsh?: RunSsh;
}

/**
 * Derives the boxId-correlation label stamped on a sandbox at create time so a
 * `list()` reconcile can map a survivor back to its `boxId`.
 */
function boxIdLabel(boxId: string): string {
  return `${POOL_LABEL}.box-id=${boxId}`;
}

/**
 * A {@link BoxProvider} backed by Modal Sandboxes via an INJECTED transport (a
 * CLI shim or the Modal client), so this package carries no Modal SDK dependency.
 * `provision` creates a sandbox exposing SSH and returns the endpoint as the box
 * `workerHost` (idempotent on `boxId`); `probe` runs `printf ready` over SSH with
 * the caller-supplied timeout; `destroy` terminates the sandbox by its Modal id;
 * `list` enumerates pool-labeled sandboxes for reconcile. Transport faults are
 * mapped to typed `modal_provision_failed` / `modal_destroy_failed` /
 * `modal_list_failed` errors.
 */
export class ModalBoxProvider implements BoxProvider {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  private readonly transport: ModalTransport;
  private readonly runSsh: RunSsh;
  /** Optional base image threaded into every create request. */
  private readonly image: string | undefined;

  /** Live sandboxes provisioned through this instance, keyed by `boxId`. */
  private readonly boxes = new Map<string, ModalSandbox>();

  constructor(
    settings: BoxPoolSettings,
    private readonly deps: ProviderDeps,
    overrides: ModalProviderOverrides,
  ) {
    this.transport = overrides.transport;
    this.runSsh = overrides.runSsh ?? defaultRunSsh;
    const image = settings.providerOptions?.["image"];
    this.image = typeof image === "string" ? image : undefined;
  }

  /**
   * Creates (or re-adopts) a Modal sandbox for `req.boxId`. Idempotent on
   * `boxId`: a second call returns the SAME descriptor without creating a second
   * sandbox. The sandbox is stamped with the pool label AND a boxId-derived label
   * so a `list()` reconcile can re-adopt survivors. A transport fault is mapped to
   * a typed `modal_provision_failed` error (and the box is NOT recorded as live).
   */
  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    const existing = this.boxes.get(req.boxId);
    if (existing) {
      return this.descriptorFor(req.boxId, existing);
    }

    const labels = Array.from(new Set([...req.labels, POOL_LABEL, boxIdLabel(req.boxId)]));
    let sandbox: ModalSandbox;
    try {
      sandbox = await this.transport.create({ labels, image: this.image });
    } catch (error) {
      throw new Error(`modal_provision_failed: ${messageOf(error)}`, { cause: error });
    }
    this.boxes.set(req.boxId, sandbox);
    return this.descriptorFor(req.boxId, sandbox);
  }

  /**
   * Runs `printf ready` over SSH against the sandbox's endpoint using the
   * caller-supplied `opts.timeoutMs` (the pool threads `worker.sshTimeoutMs`). A
   * non-zero exit or any transport error (e.g. an sshd that has not come up yet)
   * gates the box to `{ ok: false }` rather than throwing, so the reaper can
   * demote it.
   */
  async probe(
    box: BoxDescriptor,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<BoxHealth> {
    try {
      const result = await this.runSsh(box.workerHost, PROBE_COMMAND, {
        timeoutMs: opts.timeoutMs,
      });
      if (result.status !== 0) {
        return { ok: false, reason: `modal_probe_exit_${result.status}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: messageOf(error) };
    }
  }

  /**
   * Terminates the sandbox by its Modal id (`providerRef`). Always issues the
   * terminate so a SURVIVOR adopted via `list()` (a sandbox a prior daemon
   * provisioned, hence absent from this instance's `boxes`) is still torn down by
   * a reconcile/drain - never silently skipped. Idempotent: an already-gone
   * sandbox (a "not found" transport fault) is the desired end state and is
   * swallowed. Any other transport fault maps to a typed `modal_destroy_failed`.
   */
  async destroy(
    box: BoxDescriptor,
    _opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    try {
      await this.transport.terminate(box.providerRef);
    } catch (error) {
      if (isNotFound(error)) {
        // Already gone: the desired end state (sandbox terminated) holds.
        this.boxes.delete(box.boxId);
        return;
      }
      throw new Error(`modal_destroy_failed: ${messageOf(error)}`, { cause: error });
    }
    this.boxes.delete(box.boxId);
  }

  /**
   * Lists pool-owned sandboxes by filtering on the pool label, mapping each to an
   * SSH-addressable descriptor for reconcile. A transport fault is mapped to a
   * typed `modal_list_failed` error.
   */
  async list(): Promise<BoxDescriptor[]> {
    let sandboxes: ModalSandbox[];
    try {
      sandboxes = await this.transport.list({ label: POOL_LABEL });
    } catch (error) {
      throw new Error(`modal_list_failed: ${messageOf(error)}`, { cause: error });
    }
    return sandboxes.map((sandbox) =>
      this.descriptorFor(boxIdFromLabels(sandbox), sandbox, {
        // Surface the pool-owned label so the pool's hydrate/reaper ownership gate
        // (which keys on POOL_OWNED_LABEL) re-adopts or cleans up this survivor.
        // Only POOL_LABEL-tagged sandboxes reach here, so every returned
        // descriptor is pool-owned.
        ownedLabel: true,
      }),
    );
  }

  private descriptorFor(
    boxId: string,
    sandbox: ModalSandbox,
    opts: { ownedLabel?: boolean } = {},
  ): BoxDescriptor {
    const labels = opts.ownedLabel
      ? Array.from(new Set([POOL_OWNED_LABEL, ...sandbox.labels]))
      : [...sandbox.labels];
    return {
      boxId,
      workerHost: sandbox.sshHost,
      providerRef: sandbox.sandboxId,
      createdAtMs: this.deps.clock.now().getTime(),
      labels,
      metadata: { sandboxId: sandbox.sandboxId },
    };
  }
}

/**
 * Recovers the `boxId` a survivor was provisioned under from its labels, falling
 * back to the Modal sandbox id when the correlation label is absent.
 */
function boxIdFromLabels(sandbox: ModalSandbox): string {
  const prefix = `${POOL_LABEL}.box-id=`;
  const match = sandbox.labels.find((label) => label.startsWith(prefix));
  return match ? match.slice(prefix.length) : sandbox.sandboxId;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a "not found"-style error means the sandbox is already gone. */
function isNotFound(error: unknown): boolean {
  return /not[\s_-]?found/i.test(messageOf(error));
}
