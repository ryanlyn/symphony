import { POOL_OWNED_LABEL, defaultBoxDriverRegistry } from "@symphony/box-sdk";
import type {
  BoxDescriptor,
  BoxDriver,
  BoxDriverFactory,
  BoxDriverRegistry,
  BoxHealth,
  DriverCapabilities,
  DriverDeps,
  ProvisionRequest,
  SshRunner,
  TeardownReason,
} from "@symphony/box-sdk";

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
export const E2B_BOX_POOL_LABEL = "symphony.box-pool";

/** Metadata key carrying the pool's idempotency key (the `boxId`). */
const BOX_ID_LABEL = "symphony.box-id";

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
 * pool-owned sandboxes and recover the `boxId`. May optionally expose
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
 * `registerE2bBoxDriver(registries, { client })`.
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
 * A {@link BoxDriver} backed by E2B sandboxes (kind `e2b`). It provisions an
 * ephemeral sandbox via an INJECTED {@link E2BSandboxClient} (no hard SDK dep),
 * tags it with a pool-owned marker label + the `boxId` so survivors can be
 * re-adopted across daemon restarts, and returns the sandbox's SSH endpoint as
 * the `workerHost`. `destroy` kills the sandbox (idempotent: an already-gone
 * sandbox is tolerated); `list` returns ONLY pool-owned running sandboxes;
 * `probe` runs `printf ready` over SSH against the advertised endpoint. As an
 * ephemeral cloud driver it is ledger-backed (`usesLedger: true`).
 */
export class E2BBoxDriver implements BoxDriver {
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
   * Starts (or re-adopts) a sandbox for `req.boxId`. Idempotent on `boxId`: a
   * survivor carrying the pool label + matching `boxId` metadata is re-adopted
   * via `list()` instead of creating a duplicate. A typed `e2b_provision_failed`
   * error is raised when the client `create` call fails.
   */
  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    const labels = [...req.labels];

    const survivor = await this.findExisting(req.boxId);
    if (survivor) {
      return this.descriptorFor(
        req.boxId,
        survivor.sandboxId,
        this.endpointFor(survivor),
        labels.length > 0 ? labels : parseLabels(survivor.metadata[LABELS_LABEL]),
      );
    }

    const metadata: Record<string, string> = {
      [E2B_BOX_POOL_LABEL]: "true",
      [BOX_ID_LABEL]: req.boxId,
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
    return this.descriptorFor(req.boxId, handle.sandboxId, endpoint, labels);
  }

  /**
   * Runs `printf ready` over SSH against the sandbox's advertised endpoint using
   * the caller-supplied `opts.timeoutMs` (the pool passes `worker.sshTimeoutMs`).
   * A non-zero exit or any transport error (e.g. `ssh_timeout`, or sshd not up
   * yet) gates the box to `{ ok: false }` rather than throwing, so the reaper can
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
    box: BoxDescriptor,
    _opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    const sandboxId = box.driverRef;
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
   * Returns ONLY pool-owned running sandboxes (those carrying the box-pool
   * marker label), mapped to descriptors. Foreign sandboxes are never returned,
   * so the pool never destroys what it does not own. Maps a client failure to a
   * typed `e2b_list_failed` error.
   */
  async list(): Promise<BoxDescriptor[]> {
    let infos: E2BSandboxInfo[];
    try {
      infos = await this.client.list();
    } catch (error) {
      throw new Error(`e2b_list_failed: ${errorMessage(error)}`, { cause: error });
    }
    return infos.filter((info) => this.isPoolOwned(info)).map((info) => this.descriptorOf(info));
  }

  /** Finds a pool-owned running sandbox already serving `boxId`, if any. */
  private async findExisting(boxId: string): Promise<E2BSandboxInfo | undefined> {
    let infos: E2BSandboxInfo[];
    try {
      infos = await this.client.list();
    } catch {
      // A list failure during provision must not block growth: fall through to
      // a fresh create. (A genuine duplicate is reaped via labels later.)
      return undefined;
    }
    return infos.find((info) => this.isPoolOwned(info) && info.metadata[BOX_ID_LABEL] === boxId);
  }

  private isPoolOwned(info: E2BSandboxInfo): boolean {
    return info.metadata[E2B_BOX_POOL_LABEL] === "true";
  }

  private descriptorOf(info: E2BSandboxInfo): BoxDescriptor {
    const boxId = info.metadata[BOX_ID_LABEL] ?? info.sandboxId;
    return this.descriptorFor(
      boxId,
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
    boxId: string,
    sandboxId: string,
    endpoint: E2BSshEndpoint,
    labels: string[],
  ): BoxDescriptor {
    return {
      boxId,
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
export function e2bBoxDriverFactory(io: { client: E2BSandboxClient }): BoxDriverFactory {
  return {
    kind: KIND,
    create: (options, deps) => new E2BBoxDriver(options, deps, io),
  };
}

/**
 * The fail-loud `e2b` factory registered when no client is injected: enabling
 * the kind then fails at pool construction with an actionable message instead
 * of failing at first provision.
 */
const failLoudFactory: BoxDriverFactory = {
  kind: KIND,
  create: () => {
    throw new Error(
      "box_pool_driver_unavailable: e2b requires an injected client; register a configured e2b driver via registerE2bBoxDriver(registries, { client }) before enabling it",
    );
  },
};

/**
 * Register this extension's box driver. Idempotent; called by the composition
 * root (or a test) against its registry, defaulting to the process-wide one.
 * With `io` it registers a working factory closing over the supplied client;
 * without `io` it registers a fail-loud factory so the stock daemon (which
 * ships no E2B client) surfaces an actionable error if the kind is enabled.
 */
export function registerE2bBoxDriver(
  registries: { boxDrivers?: BoxDriverRegistry | undefined } = {},
  io?: { client: E2BSandboxClient },
): void {
  const drivers = registries.boxDrivers ?? defaultBoxDriverRegistry;
  if (drivers.get(KIND) === undefined) {
    drivers.register(io ? e2bBoxDriverFactory(io) : failLoudFactory);
  }
}
