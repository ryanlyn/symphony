import { defaultBoxDriverRegistry } from "@symphony/box-sdk";
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

const KIND = "static-ssh";

const CAPABILITIES: DriverCapabilities = {
  sshAddressable: true,
  ephemeral: false,
  usesLedger: false,
};

/** The readiness command the probe runs over SSH (a cheap liveness check). */
const PROBE_COMMAND = "printf ready";

/**
 * Reads the configured host list from the driver options, accepting BOTH the
 * snake_case `ssh_hosts` and the camelCase `sshHosts` spellings. This is the
 * documented passthrough: the config normalizer is a flat per-key alias map and
 * does NOT recurse into the driver options, so an operator may write either form.
 * Throws `static_ssh_hosts_required` when neither is a non-empty string array.
 */
function readSshHosts(options: Readonly<Record<string, unknown>> | undefined): string[] {
  const raw = options?.["ssh_hosts"] ?? options?.["sshHosts"];
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((value) => typeof value === "string" && value.length > 0)
  ) {
    return raw as string[];
  }
  throw new Error("static_ssh_hosts_required");
}

/**
 * A {@link BoxDriver} over a FIXED set of pre-existing SSH machines configured
 * via the `ssh_hosts` (or `sshHosts`) driver option. It owns no lifecycle for the
 * machines themselves: `min == max == hosts.length` is the implicit shape, and
 * the address IS the `boxId`. `provision` hands out one of the configured
 * addresses idempotently; `probe` runs `printf ready` over SSH using the
 * caller-supplied `opts.timeoutMs` (the pool threads `worker.sshTimeoutMs` here);
 * `destroy` merely forgets the address locally - it runs NO workspace hooks and
 * NEVER deletes a machine (a destroyed host is immediately re-provisionable);
 * `list` returns the configured set minus the addresses currently forgotten.
 */
export class StaticSshBoxDriver implements BoxDriver {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  /** The full configured inventory (the fixed address set), in config order. */
  private readonly hosts: readonly string[];
  private readonly hostSet: ReadonlySet<string>;
  /**
   * boxId -> assigned host. Keys are the pool's idempotency keys: either a
   * synthetic `box-N` the pool minted, or a configured host string (the legacy
   * "address IS the boxId" shape). Tracks the provisioned-minus-destroyed view.
   */
  private readonly assignments = new Map<string, string>();
  private readonly runSsh: SshRunner;

  constructor(
    options: Readonly<Record<string, unknown>>,
    private readonly deps: DriverDeps,
  ) {
    this.hosts = readSshHosts(options);
    this.hostSet = new Set(this.hosts);
    this.runSsh = deps.runSsh;
  }

  /**
   * Hands out a configured address for `req.boxId`. The pool mints synthetic
   * `box-N` idempotency keys (NOT host strings), so an unknown boxId is ASSIGNED a
   * free configured host round-robin and that mapping is remembered (the
   * `workerHost` is the chosen host while the `boxId` stays the pool's key). A
   * boxId that already IS a configured host is served directly (the legacy
   * "address is the boxId" shape, e.g. a host-keyed hydrate survivor). Idempotent
   * on `boxId`: a second call returns the same assignment. Rejects with
   * `static_ssh_unknown_host` only when the fixed inventory is exhausted (no free
   * host remains).
   */
  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    const existing = this.assignments.get(req.boxId);
    if (existing) {
      return Promise.resolve(this.descriptorFor(req.boxId, existing, [...req.labels]));
    }

    // Legacy shape: the boxId itself is a configured address (the address IS the
    // key). Serve that host directly so a host-keyed provision/hydrate still works.
    if (this.hostSet.has(req.boxId)) {
      this.assignments.set(req.boxId, req.boxId);
      return Promise.resolve(this.descriptorFor(req.boxId, req.boxId, [...req.labels]));
    }

    // Synthetic boxId (the pool's `box-N`): assign the first free configured host.
    const taken = new Set(this.assignments.values());
    const host = this.hosts.find((candidate) => !taken.has(candidate));
    if (host === undefined) {
      return Promise.reject(new Error(`static_ssh_unknown_host: ${req.boxId}`));
    }
    this.assignments.set(req.boxId, host);
    return Promise.resolve(this.descriptorFor(req.boxId, host, [...req.labels]));
  }

  /**
   * Runs `printf ready` over SSH against the box's address, using the
   * caller-supplied `opts.timeoutMs` (the pool passes `worker.sshTimeoutMs`). A
   * non-zero exit or any transport error (e.g. `ssh_timeout`) gates the box to
   * `{ ok: false }` rather than throwing, so the reaper can demote it.
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
        return { ok: false, reason: `static_ssh_probe_exit_${result.status}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Forgets the address locally. This is a pure bookkeeping no-op against the
   * machine: it runs NO workspace hooks and NEVER deletes the machine (a static
   * host is pre-existing infrastructure). Idempotent and tolerant of an
   * already-forgotten or never-provisioned address.
   */
  async destroy(
    box: BoxDescriptor,
    _opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    // Free the host assignment so the address re-enters the pool of free hosts a
    // future provision can hand out. Idempotent and tolerant of an already-gone id.
    this.assignments.delete(box.boxId);
    return Promise.resolve();
  }

  /** Returns the live inventory (provisioned-minus-destroyed assignments). */
  async list(): Promise<BoxDescriptor[]> {
    return Promise.resolve(
      [...this.assignments.entries()].map(([boxId, host]) => this.descriptorFor(boxId, host, [])),
    );
  }

  private descriptorFor(boxId: string, host: string, labels: string[]): BoxDescriptor {
    return {
      boxId,
      workerHost: host,
      driverRef: host,
      createdAtMs: this.deps.clock.now().getTime(),
      labels,
      metadata: {},
    };
  }
}

/** The registered `static-ssh` factory: constructs a driver over the configured hosts. */
export const staticSshBoxDriverFactory: BoxDriverFactory = {
  kind: KIND,
  create: (options, deps) => new StaticSshBoxDriver(options, deps),
};

/**
 * Register this extension's box driver. Idempotent; called by the composition
 * root (or a test) against its registry, defaulting to the process-wide one.
 */
export function registerStaticSshBoxDriver(
  registries: { boxDrivers?: BoxDriverRegistry | undefined } = {},
): void {
  const drivers = registries.boxDrivers ?? defaultBoxDriverRegistry;
  if (drivers.get(KIND) === undefined) {
    drivers.register(staticSshBoxDriverFactory);
  }
}
