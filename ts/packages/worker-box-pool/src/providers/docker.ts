import { execFile } from "node:child_process";

import type { BoxPoolProvider, BoxPoolSettings } from "@symphony/domain";
import { runSsh as defaultRunSsh, type SshRunOptions, type SshRunResult } from "@symphony/ssh";

import type {
  BoxDescriptor,
  BoxHealth,
  BoxProvider,
  ProviderCapabilities,
  ProviderDeps,
  ProvisionRequest,
  TeardownReason,
} from "../types.js";
import { POOL_OWNED_LABEL } from "../types.js";

const KIND: BoxPoolProvider = "docker";

/**
 * Docker boxes are disposable SSH-addressable containers, so the pool both
 * destroys them (`ephemeral`) and keeps a write-ahead ledger (`usesLedger`) to
 * recover survivors across a daemon restart by label.
 */
const CAPABILITIES: ProviderCapabilities = {
  sshAddressable: true,
  ephemeral: true,
  usesLedger: true,
};

/**
 * The label every pool-owned container carries (with an EMPTY value) so a
 * `docker ps --filter label=<this>` enumerates only our containers and never
 * adopts an unrelated one.
 */
const LABEL_POOL = "symphony.box-pool";

/** The label that records the pool's idempotency key (boxId) on each container. */
const LABEL_BOX_ID = "symphony.box-id";

/** The container's sshd port that the run publishes to a loopback host port. */
const CONTAINER_SSH_PORT = "22";

/** The readiness command the probe runs over SSH (a cheap liveness check). */
const PROBE_COMMAND = "printf ready";

/** Default SSH user baked into the box image when none is configured. */
const DEFAULT_USER = "root";

/** Result of one `docker` invocation. Mirrors the subprocess transport surface. */
export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Injectable `docker` transport (test seam); defaults to a real subprocess. */
export type RunDocker = (
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<DockerCommandResult>;

/** Injectable SSH transport so tests can spy on the probe argv/timeout. */
type RunSsh = (host: string, command: string, options?: SshRunOptions) => Promise<SshRunResult>;

/** Optional dependency overrides (test seams for the docker + SSH transports). */
export interface DockerProviderOverrides {
  runDocker?: RunDocker;
  runSsh?: RunSsh;
}

/** Reads a string `providerOptions` value under any of the given keys. */
function readStringOption(
  providerOptions: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = providerOptions?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Default `docker` transport: shells out to the `docker` binary on PATH via
 * `execFile`, never throwing on a non-zero exit (the caller maps exits to
 * typed errors). An ENOENT (binary missing) surfaces as a thrown
 * `docker_not_found` so the daemon fails loud at startup.
 */
const defaultRunDocker: RunDocker = async (args, options) =>
  new Promise<DockerCommandResult>((resolve, reject) => {
    execFile(
      "docker",
      [...args],
      { timeout: options.timeoutMs, signal: options.signal, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("docker_not_found", { cause: error }));
          return;
        }
        const status =
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? ((error as { code: number }).code ?? 0)
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", status });
      },
    );
  });

/**
 * Parses the loopback host port that a `docker port <id> 22` / `docker ps`
 * `Ports` column maps to the container's sshd port. Accepts both the
 * `0.0.0.0:<port>` form emitted by `docker port` and the
 * `0.0.0.0:<port>->22/tcp` mapping emitted in a `ps` row.
 */
function parsePublishedPort(text: string): number | undefined {
  const mapped = text.match(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]+\]):(\d+)->22\/tcp/);
  if (mapped?.[1]) return Number.parseInt(mapped[1], 10);
  const direct = text.match(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]+\]):(\d+)/);
  if (direct?.[1]) return Number.parseInt(direct[1], 10);
  return undefined;
}

/**
 * A {@link BoxProvider} that boots disposable Docker containers running `sshd`.
 *
 * `provision` runs `docker run -d` of `providerOptions.image`, publishing the
 * container's sshd port (22) to an auto-assigned loopback host port and
 * labelling the container with {@link LABEL_POOL} (so `list`/reconcile can adopt
 * survivors) and {@link LABEL_BOX_ID}=<boxId> (the pool's idempotency key). It is
 * idempotent ACROSS provider instances: a second provision of the same boxId
 * adopts the surviving labelled container rather than launching a duplicate.
 * `probe` runs `printf ready` over SSH against the published `user@127.0.0.1:<port>`;
 * `destroy` runs `docker rm -f <containerId>` and tolerates an already-gone
 * container; `list` runs `docker ps --filter label=<LABEL_POOL>` so unlabelled
 * containers are never touched. Capabilities are
 * `{ sshAddressable: true, ephemeral: true, usesLedger: true }`.
 */
export class DockerBoxProvider implements BoxProvider {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  private readonly image: string | undefined;
  private readonly user: string;
  private readonly runDocker: RunDocker;
  private readonly runSsh: RunSsh;

  constructor(
    settings: BoxPoolSettings,
    private readonly deps: ProviderDeps,
    overrides: DockerProviderOverrides = {},
  ) {
    const opts = settings.providerOptions;
    this.image = readStringOption(opts, "image");
    this.user = readStringOption(opts, "user", "sshUser", "ssh_user") ?? DEFAULT_USER;
    this.runDocker = overrides.runDocker ?? defaultRunDocker;
    this.runSsh = overrides.runSsh ?? defaultRunSsh;
  }

  /**
   * Boots (or adopts) the container for `req.boxId`. Idempotency is keyed on the
   * {@link LABEL_BOX_ID} label on the live daemon: if a labelled container
   * already exists it is adopted (no `docker run`), so two provider instances
   * sharing one daemon never double-launch. Otherwise it runs
   * `docker run -d -p 127.0.0.1::22 --label symphony.box-pool= --label
   * symphony.box-id=<boxId> [--label <caller label>...] <image>`, then resolves
   * the published loopback port via `docker port`. Rejects with
   * `docker_image_required` when `providerOptions.image` is unset and
   * `docker_run_failed` on a non-zero `docker run` exit.
   */
  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    if (!this.image) throw new Error("docker_image_required");

    const existing = (await this.list()).find((box) => box.boxId === req.boxId);
    if (existing) return existing;

    const labelArgs: string[] = [
      `--label`,
      `${LABEL_POOL}=`,
      `--label`,
      `${LABEL_BOX_ID}=${req.boxId}`,
    ];
    for (const label of req.labels) {
      if (label === LABEL_POOL) continue;
      labelArgs.push("--label", label);
    }

    const runArgs = [
      "run",
      "-d",
      "-p",
      `127.0.0.1::${CONTAINER_SSH_PORT}`,
      ...labelArgs,
      this.image,
    ];
    const run = await this.runDocker(runArgs, {
      timeoutMs: req.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (run.status !== 0) {
      throw new Error(`docker_run_failed: ${run.status} ${run.stderr.trim()}`);
    }
    const containerId = run.stdout.trim();

    // The container now exists on the daemon. Any failure resolving its published
    // port would otherwise leave a running container the pool never records: `grow()`
    // drops the provisional ledger row and writes NO inventory record, so a later
    // drain/reaper can never see or destroy it. Force-remove it before rethrowing so
    // a post-create fault never leaks a paid container.
    try {
      const port = await this.runDocker(["port", containerId, CONTAINER_SSH_PORT], {
        timeoutMs: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (port.status !== 0) {
        throw new Error(`docker_port_failed: ${port.status} ${port.stderr.trim()}`);
      }
      const hostPort = parsePublishedPort(port.stdout);
      if (hostPort === undefined) {
        throw new Error(`docker_port_unresolved: ${port.stdout.trim()}`);
      }

      return {
        boxId: req.boxId,
        workerHost: this.workerHostFor(hostPort),
        providerRef: containerId,
        createdAtMs: this.deps.clock.now().getTime(),
        labels: [LABEL_POOL, LABEL_BOX_ID, ...req.labels.filter((label) => label !== LABEL_POOL)],
        metadata: { containerId, hostPort },
      };
    } catch (error) {
      // Best-effort: a cleanup failure must not mask the original provision error.
      await this.runDocker(["rm", "-f", containerId], { timeoutMs: req.timeoutMs }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  /**
   * Runs `printf ready` over SSH against the published `workerHost`, using the
   * caller-supplied `opts.timeoutMs`. A non-zero exit or any transport error
   * gates the box to `{ ok: false }` (with a reason) rather than throwing, so the
   * reaper can demote an unreachable-but-created container.
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
        return { ok: false, reason: `docker_probe_exit_${result.status}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Force-removes the container via `docker rm -f <providerRef>`. Idempotent: a
   * `No such container` exit (the container is already gone) is tolerated, while
   * any other non-zero exit (e.g. the daemon is unreachable) throws
   * `docker_rm_failed` so the reaper can retry.
   */
  async destroy(
    box: BoxDescriptor,
    opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    const result = await this.runDocker(["rm", "-f", box.providerRef], {
      timeoutMs: opts.timeoutMs,
    });
    if (result.status === 0) return;
    if (/no such container/i.test(result.stderr)) return;
    throw new Error(`docker_rm_failed: ${result.status} ${result.stderr.trim()}`);
  }

  /**
   * Enumerates pool-owned containers via `docker ps --filter label=<LABEL_POOL>`,
   * reading the {@link LABEL_BOX_ID} label and the published loopback port out of
   * the tab-separated `ID<TAB>box-id<TAB>Ports` rows. Unlabelled containers are
   * never returned (the filter excludes them), so reconcile never adopts an
   * unrelated container.
   */
  async list(): Promise<BoxDescriptor[]> {
    const result = await this.runDocker(
      [
        "ps",
        "--filter",
        `label=${LABEL_POOL}`,
        "--no-trunc",
        "--format",
        `{{.ID}}\t{{.Label "${LABEL_BOX_ID}"}}\t{{.Ports}}`,
      ],
      { timeoutMs: 30_000 },
    );
    if (result.status !== 0) {
      throw new Error(`docker_ps_failed: ${result.status} ${result.stderr.trim()}`);
    }
    const createdAtMs = this.deps.clock.now().getTime();
    const boxes: BoxDescriptor[] = [];
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [containerId, boxId, ports = ""] = trimmed.split("\t");
      if (!containerId || !boxId) continue;
      const hostPort = parsePublishedPort(ports);
      if (hostPort === undefined) continue;
      boxes.push({
        boxId,
        workerHost: this.workerHostFor(hostPort),
        providerRef: containerId,
        createdAtMs,
        // Surface the pool-owned label so the pool's hydrate/reconcile ownership
        // gate (which keys on POOL_OWNED_LABEL) re-adopts or cleans up this
        // survivor. The `docker ps --filter label=<LABEL_POOL>` filter already
        // guarantees every returned container is pool-owned.
        labels: [POOL_OWNED_LABEL, LABEL_POOL, LABEL_BOX_ID],
        metadata: { containerId, hostPort },
      });
    }
    return boxes;
  }

  private workerHostFor(hostPort: number): string {
    return `${this.user}@127.0.0.1:${hostPort}`;
  }
}
