import { POOL_OWNED_LABEL, defaultWorkerDriverRegistry } from "@symphony/worker-sdk";
import type {
  WorkerDescriptor,
  WorkerDriver,
  WorkerDriverFactory,
  WorkerDriverRegistry,
  WorkerHealth,
  DriverCapabilities,
  DriverDeps,
  ProvisionRequest,
  SshRunner,
  TeardownReason,
} from "@symphony/worker-sdk";

const KIND = "e2b";

/**
 * SSH-ADDRESSABLE TRANSPORT ASSUMPTION
 * ------------------------------------
 * Symphony's executor only knows how to talk to a worker over SSH, so this
 * driver assumes the E2B sandbox template boots an `sshd` and exposes an SSH
 * endpoint. The sandbox handle's `getSshEndpoint()` yields `{host, port, user}`
 * which this driver renders into the canonical `user@host:port` `workerHost`
 * string the orchestrator/runner thread end to end. A non-SSH/delegated
 * transport (e.g. the E2B command API) would require executor changes and is
 * OUT OF SCOPE; it is noted in the design as a future extension.
 */
const CAPABILITIES: DriverCapabilities = {
  sshAddressable: true,
  ephemeral: true,
  usesLedger: true,
};

/** The readiness command the probe runs over SSH (a cheap liveness check). */
const PROBE_COMMAND = "printf ready";

/**
 * Metadata key stamped on every pool-owned sandbox so `list()` can re-adopt
 * survivors left by a prior daemon and NEVER touch sandboxes we do not own.
 */
export const E2B_WORKER_POOL_LABEL = "symphony.worker-pool";

/** Metadata key carrying the pool's idempotency key (the `workerId`). */
const WORKER_ID_LABEL = "symphony.worker-id";

/** Metadata key carrying the comma-joined request labels for re-adoption. */
const LABELS_LABEL = "symphony.labels";

/** The SSH endpoint an E2B sandbox advertises once it is booted with `sshd`. */
export interface E2BSshEndpoint {
  host: string;
  port: number;
  user: string;
}

/** A freshly-created sandbox handle returned by {@link E2BSandboxClient.create}. */
export interface E2BSandboxHandle {
  sandboxId: string;
  /** Resolves the SSH endpoint the sandbox listens on (`user@host:port`). */
  getSshEndpoint: () => E2BSshEndpoint;
}

/**
 * A running sandbox as reported by {@link E2BSandboxClient.list}. Carries the
 * metadata the driver stamped at create time so `list()` can filter to
 * pool-owned sandboxes and recover the `workerId`. May optionally expose
 * `getSshEndpoint` (when the SDK enumeration carries it); otherwise the driver
 * reconstructs a best-effort endpoint from metadata.
 */
export interface E2BSandboxInfo {
  sandboxId: string;
  metadata: Record<string, string>;
  getSshEndpoint?: () => E2BSshEndpoint;
}

/**
 * The small surface this driver needs from the E2B SDK. It is INJECTED so the
 * extension takes NO hard dependency on `@e2b/sdk`: the always-on tests pass a
 * fake, and a real deployment wires a thin adapter over the SDK via
 * `registerE2bWorkerDriver(registries, { client })`.
 */
export interface E2BSandboxClient {
  create(opts: {
    metadata: Record<string, string>;
    template?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<E2BSandboxHandle>;
  kill(sandboxId: string): Promise<void>;
  list(): Promise<E2BSandboxInfo[]>;
}

/** Optional dependency overrides (the injected E2B SDK client seam). */
export interface E2BDriverOverrides {
  client?: E2BSandboxClient;
}

/** Renders an SSH endpoint into the canonical `user@host:port` workerHost. */
function renderWorkerHost(endpoint: E2BSshEndpoint): string {
  return `${endpoint.user}@${endpoint.host}:${endpoint.port}`;
}

/** Parses the comma-joined `symphony.labels` metadata back into an array. */
function parseLabels(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

/** True when a "not found"-style error means the sandbox is already gone. */
function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not[\s_-]?found/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A {@link WorkerDriver} backed by E2B sandboxes (kind `e2b`). It provisions an
 * ephemeral sandbox via an INJECTED {@link E2BSandboxClient} (no hard SDK dep),
 * tags it with a pool-owned marker label + the `workerId` so survivors can be
 * re-adopted across daemon restarts, and returns the sandbox's SSH endpoint as
 * the `workerHost`. `destroy` kills the sandbox (idempotent: an already-gone
 * sandbox is tolerated); `list` returns ONLY pool-owned running sandboxes;
 * `probe` runs `printf ready` over SSH against the advertised endpoint. As an
 * ephemeral cloud driver it is ledger-backed (`usesLedger: true`).
 */
export class E2BWorkerDriver implements WorkerDriver {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  private readonly client: E2BSandboxClient;
  private readonly runSsh: SshRunner;
  private readonly template: string | undefined;

  // Endpoints learned from sandboxes this instance created, keyed on sandboxId,
  // so a re-adoption returns the SAME workerHost as the original provision.
  private readonly endpoints = new Map<string, E2BSshEndpoint>();

  constructor(
    options: Readonly<Record<string, unknown>>,
    private readonly deps: DriverDeps,
    overrides: E2BDriverOverrides = {},
  ) {
    // No hard SDK dependency: with no injected client and no resolvable default,
    // fail loud rather than silently no-op.
    if (!overrides.client) {
      throw new Error("e2b_client_unavailable");
    }
    this.client = overrides.client;
    this.runSsh = deps.runSsh;
    const image = options["image"];
    this.template = typeof image === "string" && image.length > 0 ? image : undefined;
  }

  /**
   * Starts (or re-adopts) a sandbox for `req.workerId`. Idempotent on `workerId`: a
   * survivor carrying the pool label + matching `workerId` metadata is re-adopted
   * via `list()` instead of creating a duplicate. A typed `e2b_provision_failed`
   * error is raised when the client `create` call fails.
   */
  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    const labels = [...req.labels];

    const survivor = await this.findExisting(req.workerId);
    if (survivor) {
      return this.descriptorFor(
        req.workerId,
        survivor.sandboxId,
        this.endpointFor(survivor),
        labels.length > 0 ? labels : parseLabels(survivor.metadata[LABELS_LABEL]),
      );
    }

    const metadata: Record<string, string> = {
      [E2B_WORKER_POOL_LABEL]: "true",
      [WORKER_ID_LABEL]: req.workerId,
      [LABELS_LABEL]: labels.join(","),
    };

    let handle: E2BSandboxHandle;
    try {
      handle = await this.client.create({
        metadata,
        ...(this.template !== undefined ? { template: this.template } : {}),
        timeoutMs: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (error) {
      throw new Error(`e2b_provision_failed: ${errorMessage(error)}`, { cause: error });
    }

    const endpoint = handle.getSshEndpoint();
    this.endpoints.set(handle.sandboxId, endpoint);
    return this.descriptorFor(req.workerId, handle.sandboxId, endpoint, labels);
  }

  /**
   * Runs `printf ready` over SSH against the sandbox's advertised endpoint using
   * the caller-supplied `opts.timeoutMs` (the pool passes `worker.sshTimeoutMs`).
   * A non-zero exit or any transport error (e.g. `ssh_timeout`, or sshd not up
   * yet) gates the worker to `{ ok: false }` rather than throwing, so the reaper can
   * demote it.
   */
  async probe(
    worker: WorkerDescriptor,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WorkerHealth> {
    try {
      const result = await this.runSsh(worker.workerHost, PROBE_COMMAND, {
        timeoutMs: opts.timeoutMs,
      });
      if (result.status !== 0) {
        return { ok: false, reason: `e2b_probe_exit_${result.status}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }

  /**
   * Kills the sandbox. Idempotent: a "not found" from the client means the
   * sandbox is already gone, which is the desired end state, so it is swallowed.
   * Any other client failure maps to a typed `e2b_destroy_failed` error.
   */
  async destroy(
    worker: WorkerDescriptor,
    _opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    const sandboxId = worker.driverRef;
    try {
      await this.client.kill(sandboxId);
    } catch (error) {
      if (isNotFound(error)) {
        // Already gone: the desired end state (sandbox killed) holds.
        this.endpoints.delete(sandboxId);
        return;
      }
      throw new Error(`e2b_destroy_failed: ${errorMessage(error)}`, { cause: error });
    }
    this.endpoints.delete(sandboxId);
  }

  /**
   * Returns ONLY pool-owned running sandboxes (those carrying the worker-pool
   * marker label), mapped to descriptors. Foreign sandboxes are never returned,
   * so the pool never destroys what it does not own. Maps a client failure to a
   * typed `e2b_list_failed` error.
   */
  async list(): Promise<WorkerDescriptor[]> {
    let infos: E2BSandboxInfo[];
    try {
      infos = await this.client.list();
    } catch (error) {
      throw new Error(`e2b_list_failed: ${errorMessage(error)}`, { cause: error });
    }
    return infos.filter((info) => this.isPoolOwned(info)).map((info) => this.descriptorOf(info));
  }

  /** Finds a pool-owned running sandbox already serving `workerId`, if any. */
  private async findExisting(workerId: string): Promise<E2BSandboxInfo | undefined> {
    let infos: E2BSandboxInfo[];
    try {
      infos = await this.client.list();
    } catch {
      // A list failure during provision must not block growth: fall through to
      // a fresh create. (A genuine duplicate is reaped via labels later.)
      return undefined;
    }
    return infos.find(
      (info) => this.isPoolOwned(info) && info.metadata[WORKER_ID_LABEL] === workerId,
    );
  }

  private isPoolOwned(info: E2BSandboxInfo): boolean {
    return info.metadata[E2B_WORKER_POOL_LABEL] === "true";
  }

  private descriptorOf(info: E2BSandboxInfo): WorkerDescriptor {
    const workerId = info.metadata[WORKER_ID_LABEL] ?? info.sandboxId;
    return this.descriptorFor(
      workerId,
      info.sandboxId,
      this.endpointFor(info),
      // Surface the pool-owned label so the pool's hydrate/reaper ownership gate
      // (which keys on POOL_OWNED_LABEL) re-adopts or cleans up this survivor.
      // Only pool-owned sandboxes reach here (isPoolOwned filter in list()), so
      // every returned descriptor is pool-owned.
      [POOL_OWNED_LABEL, ...parseLabels(info.metadata[LABELS_LABEL])],
    );
  }

  /**
   * Resolves the SSH endpoint for a sandbox. Prefers an endpoint learned at
   * create time (cached by sandboxId), then the info's own `getSshEndpoint`, and
   * finally a best-effort reconstruction so a re-adopted survivor still yields a
   * usable `workerHost` (the probe will gate it if it is not actually reachable).
   */
  private endpointFor(info: E2BSandboxInfo): E2BSshEndpoint {
    const cached = this.endpoints.get(info.sandboxId);
    if (cached) {
      return cached;
    }
    if (info.getSshEndpoint) {
      const endpoint = info.getSshEndpoint();
      this.endpoints.set(info.sandboxId, endpoint);
      return endpoint;
    }
    return { host: info.sandboxId, port: 22, user: "root" };
  }

  private descriptorFor(
    workerId: string,
    sandboxId: string,
    endpoint: E2BSshEndpoint,
    labels: string[],
  ): WorkerDescriptor {
    return {
      workerId,
      workerHost: renderWorkerHost(endpoint),
      driverRef: sandboxId,
      createdAtMs: this.deps.clock.now().getTime(),
      labels,
      metadata: { sandboxId },
    };
  }
}

/**
 * Builds the `e2b` factory over an injected {@link E2BSandboxClient}. The
 * extension carries no E2B SDK dependency, so a working factory only exists
 * once the composition root supplies the client adapter.
 */
export function e2bWorkerDriverFactory(io: { client: E2BSandboxClient }): WorkerDriverFactory {
  return {
    kind: KIND,
    create: (options, deps) => new E2BWorkerDriver(options, deps, io),
  };
}

/**
 * The fail-loud `e2b` factory registered when no client is injected: enabling
 * the kind then fails at pool construction with an actionable message instead
 * of failing at first provision.
 */
const failLoudFactory: WorkerDriverFactory = {
  kind: KIND,
  create: () => {
    throw new Error(
      "worker_pool_driver_unavailable: e2b requires an injected client; register a configured e2b driver via registerE2bWorkerDriver(registries, { client }) before enabling it",
    );
  },
};

/**
 * Register this extension's worker driver. Idempotent; called by the composition
 * root (or a test) against its registry, defaulting to the process-wide one.
 * With `io` it registers a working factory closing over the supplied client;
 * without `io` it registers a fail-loud factory so the stock daemon (which
 * ships no E2B client) surfaces an actionable error if the kind is enabled.
 */
export function registerE2bWorkerDriver(
  registries: { workerDrivers?: WorkerDriverRegistry | undefined } = {},
  io?: { client: E2BSandboxClient },
): void {
  const drivers = registries.workerDrivers ?? defaultWorkerDriverRegistry;
  if (drivers.get(KIND) === undefined) {
    drivers.register(io ? e2bWorkerDriverFactory(io) : failLoudFactory);
  }
}
