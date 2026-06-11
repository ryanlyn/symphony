import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, test } from "vitest";
import type { BoxPoolSettings } from "@symphony/domain";
import type { ClockPort, TimerHandle } from "@symphony/domain";
import type { SshRunOptions, SshRunResult } from "@symphony/ssh";
import { assert, writeExecutable } from "@symphony/test-utils";

import { runProviderConformanceSuite } from "../../src/conformance.js";
import {
  DockerBoxProvider,
  type DockerCommandResult,
  type DockerProviderOverrides,
} from "../../src/providers/docker.js";
import { POOL_OWNED_LABEL, type ProviderDeps, type ProvisionRequest } from "../../src/types.js";

// A deterministic clock so `createdAtMs` is reproducible. The provider owns no
// timers (it shells out to `docker` and delegates the probe to `runSsh`).
function fixedClock(initial: Date): ClockPort {
  return {
    now: () => initial,
    setTimeout: (): TimerHandle => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
}

function makeDeps(): ProviderDeps {
  return { clock: fixedClock(new Date("2026-05-29T10:00:00.000Z")), logEvent: () => undefined };
}

const IMAGE = "ghcr.io/org/box:latest";

function settingsWith(providerOptions: Record<string, unknown>): BoxPoolSettings {
  return {
    enabled: true,
    provider: "docker",
    min: 0,
    max: 4,
    warm: 1,
    maxInFlight: 1,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 30_000,
    reapIntervalMs: 15_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
    providerOptions,
  };
}

const LABEL_POOL = "symphony.box-pool";
const LABEL_ID = "symphony.box-id";

// ---------------------------------------------------------------------------
// A scripted fake `docker` CLI seam. It records every argv it is handed and
// returns canned results keyed on the subcommand, modeling a tiny container
// daemon: `run` mints a container id and remembers it under its box-id label
// and an assigned host port; `port` reports the published port; `rm` removes
// it; `ps` lists the survivors filtered by the pool label.
// ---------------------------------------------------------------------------
interface FakeDocker {
  override: DockerProviderOverrides;
  calls: string[][];
  containers: Map<string, { boxId: string; hostPort: number }>;
}

function fakeDocker(opts: { startPort?: number } = {}): FakeDocker {
  const calls: string[][] = [];
  const containers = new Map<string, { boxId: string; hostPort: number }>();
  let nextId = 1;
  let nextPort = opts.startPort ?? 32_768;

  const runDocker = async (
    args: readonly string[],
    _options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<DockerCommandResult> => {
    calls.push([...args]);
    const sub = args[0];
    if (sub === "run") {
      const boxId = labelValue(args, LABEL_ID);
      const id = `c${nextId++}${"0".repeat(60)}`.slice(0, 64);
      const hostPort = nextPort++;
      containers.set(id, { boxId: boxId ?? "", hostPort });
      return { stdout: `${id}\n`, stderr: "", status: 0 };
    }
    if (sub === "port") {
      const id = args[1] ?? "";
      const c = containers.get(id);
      if (!c) return { stdout: "", stderr: "no such container", status: 1 };
      return { stdout: `0.0.0.0:${c.hostPort}\n[::]:${c.hostPort}\n`, stderr: "", status: 0 };
    }
    if (sub === "rm") {
      const id = args[args.length - 1] ?? "";
      if (!containers.has(id)) {
        // Mirror docker's exit-1 "No such container" so the provider's
        // idempotent destroy must tolerate it.
        return { stdout: "", stderr: `Error: No such container: ${id}`, status: 1 };
      }
      containers.delete(id);
      return { stdout: `${id}\n`, stderr: "", status: 0 };
    }
    if (sub === "ps") {
      const lines = [...containers.entries()].map(
        ([id, c]) => `${id}\t${c.boxId}\t0.0.0.0:${c.hostPort}->22/tcp`,
      );
      return { stdout: lines.length ? `${lines.join("\n")}\n` : "", stderr: "", status: 0 };
    }
    return { stdout: "", stderr: `unexpected docker subcommand: ${sub}`, status: 127 };
  };

  return { override: { runDocker }, calls, containers };
}

// Reads the value of the Nth `--label <key>=<value>` pair for `key`.
function labelValue(args: readonly string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--label" && args[i + 1]?.startsWith(`${key}=`)) {
      return args[i + 1]!.slice(key.length + 1);
    }
  }
  return undefined;
}

function makeProvider(over?: DockerProviderOverrides): DockerBoxProvider {
  const fake = fakeDocker();
  return new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), {
    ...fake.override,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Conformance suite over the scripted fake docker (always-on, zero network).
// `boxIds` are arbitrary pool idempotency keys; the provider derives the host
// port and the container id from the fake. The unreachable variant forces the
// SSH probe to fail so the box gates to ok:false.
// ---------------------------------------------------------------------------
runProviderConformanceSuite(
  () => {
    const fake = fakeDocker();
    return new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), fake.override);
  },
  {
    suiteName: "DockerBoxProvider (fake docker CLI)",
    boxIds: ["box-a", "box-b"],
    makeProvisionRequest: (boxId): ProvisionRequest => ({
      boxId,
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    }),
    makeUnreachable: () => {
      const fake = fakeDocker();
      const provider = new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), {
        ...fake.override,
        runSsh: async () => {
          throw new Error("ssh_timeout: 127.0.0.1 5000");
        },
      });
      return { provider, boxId: "box-down" };
    },
  },
);

describe("DockerBoxProvider command construction", () => {
  test("provision: docker run -d publishes 22, labels the pool + box id + image", async () => {
    const fake = fakeDocker({ startPort: 40_000 });
    const provider = new DockerBoxProvider(
      settingsWith({ image: IMAGE }),
      makeDeps(),
      fake.override,
    );

    const box = await provider.provision({
      boxId: "box-a",
      labels: [LABEL_POOL, "ensemble:0"],
      timeoutMs: 30_000,
    });

    // The container id from `docker run` is the providerRef used by destroy/list.
    assert.equal(box.boxId, "box-a");
    assert.match(box.providerRef, /^c1/);

    // workerHost is the published loopback endpoint `user@127.0.0.1:<port>`.
    assert.equal(box.workerHost, "root@127.0.0.1:40000");

    // Exact `docker run` argv: detached, publish container 22, all labels, image last.
    const runCall = fake.calls.find((c) => c[0] === "run");
    assert.ok(runCall);
    assert.equal(runCall![0], "run");
    assert.equal(runCall!.includes("-d"), true);
    // Publishes a host port mapped to the container's sshd port 22.
    const pubIdx = runCall!.indexOf("-p");
    assert.ok(pubIdx >= 0);
    assert.match(runCall![pubIdx + 1] ?? "", /:22$/);
    // The pool label (so list/reconcile can adopt survivors) and the box-id label.
    assert.equal(labelValue(runCall!, LABEL_POOL), "");
    assert.equal(labelValue(runCall!, LABEL_ID), "box-a");
    // Caller-supplied labels are forwarded too.
    assert.ok(runCall!.includes("ensemble:0"));
    // The image (from providerOptions.image) is the final positional argument.
    assert.equal(runCall![runCall!.length - 1], IMAGE);
  });

  test("provision: a custom user from providerOptions is used in workerHost", async () => {
    const fake = fakeDocker({ startPort: 50_000 });
    const provider = new DockerBoxProvider(
      settingsWith({ image: IMAGE, user: "agent" }),
      makeDeps(),
      fake.override,
    );
    const box = await provider.provision({
      boxId: "box-u",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });
    assert.equal(box.workerHost, "agent@127.0.0.1:50000");
  });

  test("provision: reads sshUser (camelCase) as well as user", async () => {
    const fake = fakeDocker({ startPort: 50_500 });
    const provider = new DockerBoxProvider(
      settingsWith({ image: IMAGE, sshUser: "dev" }),
      makeDeps(),
      fake.override,
    );
    const box = await provider.provision({
      boxId: "box-c",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });
    assert.equal(box.workerHost, "dev@127.0.0.1:50500");
  });

  test("provision: rejects when providerOptions.image is missing", async () => {
    const fake = fakeDocker();
    const provider = new DockerBoxProvider(settingsWith({}), makeDeps(), fake.override);
    await assert.rejects(
      () => provider.provision({ boxId: "box-a", labels: [LABEL_POOL], timeoutMs: 30_000 }),
      /docker_image_required/,
    );
  });

  test("provision: maps a non-zero `docker run` exit to a thrown provider error", async () => {
    const provider = new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), {
      runDocker: async (args) => {
        if (args[0] === "run") return { stdout: "", stderr: "Unable to find image", status: 125 };
        return { stdout: "", stderr: "", status: 0 };
      },
    });
    await assert.rejects(
      () => provider.provision({ boxId: "box-a", labels: [LABEL_POOL], timeoutMs: 30_000 }),
      /docker_run_failed/,
    );
  });

  test("provision: a post-create `docker port` failure force-removes the container (no leak)", async () => {
    const fake = fakeDocker({ startPort: 41_000 });
    const innerRunDocker = fake.override.runDocker!;
    // `docker run` succeeds (a container now exists on the daemon) but resolving its
    // published port fails. Without cleanup the container would leak: the pool writes
    // no inventory record, so drain/reaper can never see it.
    const provider = new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), {
      runDocker: async (args, options) => {
        if (args[0] === "port") return { stdout: "", stderr: "boom", status: 1 };
        return innerRunDocker(args, options);
      },
    });

    await assert.rejects(
      () => provider.provision({ boxId: "box-leak", labels: [LABEL_POOL], timeoutMs: 30_000 }),
      /docker_port_failed/,
    );

    // The created container was force-removed: the fake daemon holds none...
    assert.equal(fake.containers.size, 0);
    // ...via `docker rm -f <containerId>`.
    const rmCall = fake.calls.find((c) => c[0] === "rm");
    assert.ok(rmCall, "expected a docker rm -f cleanup call");
    assert.equal(rmCall?.includes("-f"), true);
  });

  test("provision is idempotent across instances via the pool label on the live daemon", async () => {
    // Two provider instances share one fake daemon: a second provision of the
    // same boxId must adopt the surviving container (no duplicate `docker run`),
    // because idempotency is keyed on the symphony.box-id label, not in-memory.
    const fake = fakeDocker({ startPort: 41_000 });
    const a = new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), fake.override);
    const first = await a.provision({ boxId: "box-keep", labels: [LABEL_POOL], timeoutMs: 30_000 });

    const b = new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), fake.override);
    const second = await b.provision({
      boxId: "box-keep",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });

    assert.equal(second.boxId, first.boxId);
    assert.equal(second.providerRef, first.providerRef);
    assert.equal(second.workerHost, first.workerHost);

    // Exactly ONE container exists for box-keep (the second provision adopted it).
    const runCount = fake.calls.filter((c) => c[0] === "run").length;
    assert.equal(runCount, 1);
    const listed = (await b.list()).filter((box) => box.boxId === "box-keep");
    assert.equal(listed.length, 1);
  });
});

describe("DockerBoxProvider list/destroy/probe", () => {
  test("list: docker ps filters by the pool label and parses the box-id label + port", async () => {
    const fake = fakeDocker({ startPort: 33_000 });
    const provider = new DockerBoxProvider(
      settingsWith({ image: IMAGE }),
      makeDeps(),
      fake.override,
    );
    await provider.provision({ boxId: "box-1", labels: [LABEL_POOL], timeoutMs: 30_000 });
    await provider.provision({ boxId: "box-2", labels: [LABEL_POOL], timeoutMs: 30_000 });

    const listed = await provider.list();
    const byId = new Map(listed.map((box) => [box.boxId, box]));
    assert.deepEqual([...byId.keys()].sort(), ["box-1", "box-2"]);
    // The parsed workerHost carries the published loopback port from `docker ps`.
    assert.equal(byId.get("box-1")!.workerHost, "root@127.0.0.1:33000");
    assert.equal(byId.get("box-2")!.workerHost, "root@127.0.0.1:33001");

    // `docker ps` was filtered by the pool label (so unlabeled containers are
    // never adopted) and asked for the box-id label + ports in its format.
    const psCall = fake.calls.find((c) => c[0] === "ps");
    assert.ok(psCall);
    const filterIdx = psCall!.indexOf("--filter");
    assert.ok(filterIdx >= 0);
    assert.equal(psCall![filterIdx + 1], `label=${LABEL_POOL}`);

    // Every listed descriptor surfaces POOL_OWNED_LABEL so the pool's
    // hydrate/reconcile ownership gate re-adopts (and can later clean up) these
    // survivors. Without it a crash-leaked container is a permanent orphan.
    for (const box of listed) {
      assert.equal(box.labels.includes(POOL_OWNED_LABEL), true);
    }
  });

  test("destroy: docker rm -f on the providerRef (container id), idempotent on already-gone", async () => {
    const fake = fakeDocker({ startPort: 34_000 });
    const provider = new DockerBoxProvider(
      settingsWith({ image: IMAGE }),
      makeDeps(),
      fake.override,
    );
    const box = await provider.provision({
      boxId: "box-x",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });

    await provider.destroy(box, { timeoutMs: 5_000, reason: "shrink" });

    const rmCall = fake.calls.find((c) => c[0] === "rm");
    assert.ok(rmCall);
    assert.equal(rmCall!.includes("-f"), true);
    // The providerRef (container id), NOT the boxId, is what `docker rm` targets.
    assert.equal(rmCall![rmCall!.length - 1], box.providerRef);

    // The container is gone from the daemon.
    assert.equal(
      (await provider.list()).some((b) => b.boxId === "box-x"),
      false,
    );

    // A second destroy (now "No such container", exit 1) must NOT throw.
    await provider.destroy(box, { timeoutMs: 5_000, reason: "shrink" });
  });

  test("destroy: a genuine docker error (not 'no such container') is surfaced", async () => {
    const provider = new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), {
      runDocker: async (args) => {
        if (args[0] === "rm")
          return { stdout: "", stderr: "Cannot connect to the Docker daemon", status: 1 };
        return { stdout: "", stderr: "", status: 0 };
      },
    });
    await assert.rejects(
      () =>
        provider.destroy(
          {
            boxId: "box-a",
            workerHost: "root@127.0.0.1:9999",
            providerRef: "deadbeef",
            createdAtMs: 0,
            labels: [LABEL_POOL],
            metadata: {},
          },
          { timeoutMs: 5_000, reason: "drain" },
        ),
      /docker_rm_failed/,
    );
  });

  test("probe: runs runSsh printf-ready against the published workerHost with opts.timeoutMs", async () => {
    const fake = fakeDocker({ startPort: 35_000 });
    const calls: Array<{ host: string; command: string; options: SshRunOptions }> = [];
    const provider = new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), {
      ...fake.override,
      runSsh: async (host, command, options = {}): Promise<SshRunResult> => {
        calls.push({ host, command, options });
        return { stdout: "ready\n", stderr: "", status: 0 };
      },
    });
    const box = await provider.provision({
      boxId: "box-p",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });

    const health = await provider.probe(box, { timeoutMs: 7_000 });
    assert.equal(health.ok, true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.host, "root@127.0.0.1:35000");
    assert.equal(calls[0]?.command, "printf ready");
    assert.equal(calls[0]?.options.timeoutMs, 7_000);
  });

  test("probe: a non-zero ssh exit gates the box to ok:false (does not throw)", async () => {
    const fake = fakeDocker();
    const provider = new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), {
      ...fake.override,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "", stderr: "boom", status: 255 }),
    });
    const box = await provider.provision({
      boxId: "box-p",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });
    const health = await provider.probe(box, { timeoutMs: 5_000 });
    assert.equal(health.ok, false);
    if (!health.ok) assert.match(health.reason, /255/);
  });

  test("capabilities are { sshAddressable:true, ephemeral:true, usesLedger:true }", () => {
    const provider = makeProvider();
    assert.deepEqual(provider.capabilities, {
      sshAddressable: true,
      ephemeral: true,
      usesLedger: true,
    });
    assert.equal(provider.kind, "docker");
  });
});

// ---------------------------------------------------------------------------
// Real code-path integration: a PATH-shimmed fake `docker` binary so the
// provider's default subprocess transport (`execFile`-style) is exercised with
// zero network. This proves the provider actually shells out to `docker`.
// ---------------------------------------------------------------------------
describe("DockerBoxProvider over a PATH-shimmed fake docker binary", () => {
  let oldPath: string | undefined;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-docker-"));
    oldPath = process.env.PATH;
    const bin = path.join(root, "bin");
    const state = path.join(root, "state");
    await fs.mkdir(state, { recursive: true });
    // A tiny POSIX-sh docker: `run` mints an id and a port and records them;
    // `port` echoes the published mapping; `rm` deletes the record; `ps` lists
    // survivors as ID<TAB>box-id<TAB>ports. It is the same daemon model as the
    // injected fake, but exercised through the provider's REAL subprocess seam.
    await writeExecutable(
      path.join(bin, "docker"),
      `#!/bin/sh
state='${state}'
sub="$1"; shift
case "$sub" in
  run)
    boxid=""
    for a in "$@"; do
      case "$a" in symphony.box-id=*) boxid="\${a#symphony.box-id=}";; esac
    done
    n=$(ls "$state" | wc -l | tr -d ' ')
    id="c$((n+1))$(printf '%0.sf' 1 2 3 4 5 6 7 8 9)"
    port=$((36000 + n))
    printf '%s\\t%s\\n' "$boxid" "$port" > "$state/$id"
    printf '%s\\n' "$id"
    ;;
  port)
    id="$1"
    if [ -f "$state/$id" ]; then
      port=$(cut -f2 "$state/$id")
      printf '0.0.0.0:%s\\n' "$port"
    else
      echo "no such container" 1>&2; exit 1
    fi
    ;;
  rm)
    id=""
    for a in "$@"; do id="$a"; done
    if [ -f "$state/$id" ]; then rm -f "$state/$id"; printf '%s\\n' "$id";
    else echo "Error: No such container: $id" 1>&2; exit 1; fi
    ;;
  ps)
    for f in "$state"/*; do
      [ -f "$f" ] || continue
      id=$(basename "$f")
      boxid=$(cut -f1 "$f"); port=$(cut -f2 "$f")
      printf '%s\\t%s\\t0.0.0.0:%s->22/tcp\\n' "$id" "$boxid" "$port"
    done
    ;;
  *) echo "unexpected: $sub" 1>&2; exit 127;;
esac
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  });

  afterEach(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("provision -> list -> destroy round-trips through the real docker subprocess seam", async () => {
    // No runDocker override: the provider uses its default execFile transport,
    // which resolves the PATH-shimmed `docker` and runs the real code path.
    const provider = new DockerBoxProvider(settingsWith({ image: IMAGE }), makeDeps(), {
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });

    const box = await provider.provision({
      boxId: "real-1",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });
    assert.equal(box.boxId, "real-1");
    assert.match(box.workerHost, /^root@127\.0\.0\.1:\d+$/);

    const listed = await provider.list();
    assert.equal(
      listed.some((b) => b.boxId === "real-1"),
      true,
    );

    await provider.destroy(box, { timeoutMs: 5_000, reason: "shrink" });
    assert.equal(
      (await provider.list()).some((b) => b.boxId === "real-1"),
      false,
    );
    // Idempotent destroy through the real seam (now exit-1 "No such container").
    await provider.destroy(box, { timeoutMs: 5_000, reason: "shrink" });
  });
});

// ---------------------------------------------------------------------------
// Gated live slice: runs the shared conformance suite against the REAL docker
// daemon. Collected-but-skipped unless SYMPHONY_TS_RUN_LIVE_DOCKER_E2E=1.
// ---------------------------------------------------------------------------
const LIVE = process.env.SYMPHONY_TS_RUN_LIVE_DOCKER_E2E === "1";
const liveImage =
  process.env.SYMPHONY_TS_DOCKER_E2E_IMAGE ?? "lscr.io/linuxserver/openssh-server:latest";

describe.skipIf(!LIVE)(
  "DockerBoxProvider live conformance (SYMPHONY_TS_RUN_LIVE_DOCKER_E2E=1)",
  () => {
    runProviderConformanceSuite(
      () => new DockerBoxProvider(settingsWith({ image: liveImage }), makeDeps()),
      {
        suiteName: "DockerBoxProvider (live docker)",
        boxIds: ["symphony-live-a", "symphony-live-b"],
        provisionTimeoutMs: 120_000,
        probeTimeoutMs: 30_000,
        destroyTimeoutMs: 30_000,
        makeProvisionRequest: (boxId): ProvisionRequest => ({
          boxId,
          labels: [LABEL_POOL],
          timeoutMs: 120_000,
        }),
      },
    );
  },
);
