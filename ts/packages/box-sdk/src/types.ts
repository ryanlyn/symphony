import type { ClockPort } from "@symphony/domain";

/**
 * The box driver contract: everything a third party needs to ship a new box
 * backend (their own cloud, their own VM fleet) as an extension, without
 * touching the pool engine. A driver provisions, probes, destroys, and lists
 * SSH-addressable worker boxes behind one interface; the warm pool in
 * `@symphony/worker-box-pool` owns every lifecycle decision (leasing, reaping,
 * spend, crash recovery) and only ever calls these four operations.
 *
 * This module is dependency-light by design: it pulls `ClockPort` from
 * `@symphony/domain` only, so extensions implementing a driver depend on the
 * SDK layer alone.
 */

/**
 * The label every pool-owned box carries so a `list()` reconcile can re-adopt
 * or destroy ONLY boxes the pool created (never an unlabeled foreign
 * instance). The pool stamps this on every provision request, and every
 * driver's `list()` MUST surface it on the descriptors it returns (the pool's
 * ownership gate keys on it).
 */
export const POOL_OWNED_LABEL = "symphony.pool=worker-box-pool";

/**
 * Why a box is being torn down. Drives driver `destroy` and the pool's
 * ledger/spend bookkeeping; never runs workspace hooks (the runner owns
 * workspace lifecycle).
 */
export type TeardownReason =
  | "ttl"
  | "idle"
  | "shrink"
  | "unhealthy"
  | "failed"
  | "drain"
  | "orphan";

/**
 * Driver-reported health of a single box. The probe is a cheap readiness
 * check (e.g. `printf ready` over SSH), not a workspace/hook operation.
 */
export type BoxHealth = { ok: true } | { ok: false; reason: string };

/**
 * Static capabilities of a driver backend. `usesLedger` gates the write-ahead
 * ledger (cloud-only); `sshAddressable` records that the yielded `workerHost`
 * is an SSH destination; `ephemeral` records that boxes are disposable
 * machines.
 */
export interface DriverCapabilities {
  sshAddressable: boolean;
  ephemeral: boolean;
  usesLedger: boolean;
}

/**
 * A provisioned box. `workerHost` is the SSH-addressable string threaded
 * end-to-end by the orchestrator/runner. `driverRef` is the backend's own
 * handle (e.g. a machine id) used for `destroy`/`list` reconcile. `labels`
 * tag pool-owned survivors so a `list()` reconcile can re-adopt them.
 */
export interface BoxDescriptor {
  boxId: string;
  workerHost: string;
  driverRef: string;
  createdAtMs: number;
  labels: ReadonlyArray<string>;
  metadata: Record<string, unknown>;
}

/**
 * Request to provision one box. `boxId` is the pool's idempotency key (a
 * driver must return the same box for the same `boxId`). `affinityKey` carries
 * a prior `workerHost` so a retry can re-land on the same machine. `labels`
 * are stamped on the box for reconcile. `driverOptions` is the operator's
 * `worker.box_pool.driver_options` block, passed through verbatim.
 */
export interface ProvisionRequest {
  boxId: string;
  affinityKey?: string | null;
  labels: ReadonlyArray<string>;
  timeoutMs: number;
  signal?: AbortSignal;
  driverOptions?: Record<string, unknown>;
}

/**
 * A swappable backend that provisions, probes, destroys, and lists boxes
 * behind one interface. Every implementation must be idempotent on `boxId`
 * for `provision` and idempotent for `destroy` (a second destroy of a gone
 * machine is tolerated, never an error).
 */
export interface BoxDriver {
  readonly kind: string;
  provision(req: ProvisionRequest): Promise<BoxDescriptor>;
  probe(box: BoxDescriptor, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<BoxHealth>;
  destroy(box: BoxDescriptor, opts: { timeoutMs: number; reason: TeardownReason }): Promise<void>;
  list(): Promise<BoxDescriptor[]>;
  readonly capabilities: DriverCapabilities;
}

/**
 * Structural mirror of the engine's ssh runner so drivers can probe boxes over
 * SSH without depending on the engine ssh package. The pool injects the real
 * implementation through {@link DriverDeps}; tests inject fakes.
 */
export interface SshRunOptions {
  timeoutMs?: number | undefined;
  stderrToStdout?: boolean | undefined;
  abortSignal?: AbortSignal | undefined;
}

export interface SshRunResult {
  stdout: string;
  stderr: string;
  status: number;
}

export type SshRunner = (
  destination: string,
  command: string,
  options?: SshRunOptions,
) => Promise<SshRunResult>;

/**
 * Dependencies a driver factory receives from the pool. Deliberately excludes
 * any workspace or hook deps: drivers manage box lifecycle only. Cloud
 * transports the engine does not provide (e.g. an E2B client or Modal
 * transport) are closed over by the extension's registration, never threaded
 * through these deps.
 */
export interface DriverDeps {
  clock: ClockPort;
  logEvent: (event: Record<string, unknown>) => void;
  runSsh: SshRunner;
}

/**
 * The unit a box-driver extension registers: a named constructor for its
 * {@link BoxDriver}. `create` receives the operator's
 * `worker.box_pool.driver_options` verbatim (never the full pool settings, so
 * the SDK surface stays stable) and validates them itself, throwing an
 * actionable error at pool construction when they are unusable - the same
 * fail-loud startup point as an unregistered kind.
 */
export interface BoxDriverFactory {
  readonly kind: string;
  create(options: Readonly<Record<string, unknown>>, deps: DriverDeps): BoxDriver;
}
