import { describe, expect, test } from "vitest";
import type { BoxPoolSettings } from "@symphony/domain";
import type { ClockPort, TimerHandle } from "@symphony/ports";
import { parseSshTarget, sshArgs, type SshRunOptions, type SshRunResult } from "@symphony/ssh";

import { assert } from "../../../../test/assert.js";
import { runProviderConformanceSuite } from "../../src/conformance.js";
import { FlyBoxProvider, type FlyFetch, type FlyFetchResponse } from "../../src/providers/fly.js";
import {
  POOL_OWNED_LABEL,
  type BoxDescriptor,
  type ProviderDeps,
  type ProvisionRequest,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test scaffolding: a deterministic clock + a fake Fly Machines HTTP transport.
// The provider drives the Machines REST API through an injected `fetch`-shaped
// client, so every always-on test asserts request/arg construction and parsing
// with zero network and zero cost.
// ---------------------------------------------------------------------------

function fixedClock(initial: Date): ClockPort {
  return {
    now: () => initial,
    setTimeout: (): TimerHandle => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
}

function makeDeps(): { deps: ProviderDeps; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    deps: {
      clock: fixedClock(new Date("2026-05-29T10:00:00.000Z")),
      logEvent: (event) => events.push(event),
    },
    events,
  };
}

const APP = "symphony-pool";
const TOKEN = "fly-secret-token";

function settings(extra: Record<string, unknown> = {}): BoxPoolSettings {
  return {
    enabled: true,
    provider: "fly",
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
    providerOptions: {
      app: APP,
      image: "ghcr.io/org/box-sshd:latest",
      region: "iad",
      api_token: TOKEN,
      ...extra,
    },
  };
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): FlyFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

/**
 * Builds a fake Fly Machines transport whose responses are scripted by an
 * in-memory machine store keyed on machine id. Records every request so tests
 * can assert verb/url/headers/body construction.
 */
function makeFakeFly(
  options: {
    onCreate?: (body: Record<string, unknown>) => FlyFetchResponse;
    listResponse?: () => FlyFetchResponse;
    onDestroy?: (machineId: string) => FlyFetchResponse;
  } = {},
): { fetch: FlyFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const machines = new Map<string, Record<string, unknown>>();

  const fetch: FlyFetch = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method, url, headers, body });

    const createMatch = /\/v1\/apps\/([^/]+)\/machines$/.exec(url);
    const itemMatch = /\/v1\/apps\/([^/]+)\/machines\/([^/?]+)(\?.*)?$/.exec(url);

    if (method === "POST" && createMatch) {
      if (options.onCreate) return options.onCreate(body as Record<string, unknown>);
      const id = `91857940a44389-${machines.size}`;
      const config = (body as Record<string, unknown>).config as Record<string, unknown>;
      const created = {
        id,
        name: (body as Record<string, unknown>).name ?? `m-${id}`,
        state: "started",
        region: (body as Record<string, unknown>).region ?? "iad",
        private_ip: `fdaa:0:1::${machines.size + 1}`,
        config,
      };
      machines.set(id, created);
      return jsonResponse(200, created);
    }
    if (method === "GET" && createMatch) {
      if (options.listResponse) return options.listResponse();
      return jsonResponse(200, [...machines.values()]);
    }
    if (method === "DELETE" && itemMatch) {
      const id = itemMatch[2]!;
      if (options.onDestroy) return options.onDestroy(id);
      machines.delete(id);
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(404, { error: "not found" });
  };

  return { fetch, requests };
}

function provider(
  overrides: {
    fetch?: FlyFetch;
    runSsh?: (host: string, command: string, opts?: SshRunOptions) => Promise<SshRunResult>;
    settingsExtra?: Record<string, unknown>;
  } = {},
): FlyBoxProvider {
  const { fetch } = makeFakeFly();
  const { deps } = makeDeps();
  return new FlyBoxProvider(settings(overrides.settingsExtra), deps, {
    fetch: overrides.fetch ?? fetch,
    runSsh:
      overrides.runSsh ??
      (async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 })),
  });
}

const provisionRequest = (boxId: string): ProvisionRequest => ({
  boxId,
  labels: ["symphony.box-pool", `symphony.app:${APP}`],
  timeoutMs: 30_000,
  providerOptions: settings().providerOptions,
});

// ---------------------------------------------------------------------------
// Shared conformance suite over the fake Machines transport.
// ---------------------------------------------------------------------------

runProviderConformanceSuite(
  () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    return new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });
  },
  {
    suiteName: "FlyBoxProvider (fake Machines API)",
    boxIds: ["box-aaa", "box-bbb"],
    makeProvisionRequest: provisionRequest,
    makeUnreachable: () => {
      const { fetch } = makeFakeFly();
      const { deps } = makeDeps();
      const prov = new FlyBoxProvider(settings(), deps, {
        fetch,
        // A created-but-unreachable machine: probe SSH transport rejects.
        runSsh: async () => {
          throw new Error("ssh_timeout: fly 5000");
        },
      });
      return { provider: prov, boxId: "box-down" };
    },
  },
);

describe("FlyBoxProvider", () => {
  test("capabilities are { sshAddressable:true, ephemeral:true, usesLedger:true }", () => {
    assert.deepEqual(provider().capabilities, {
      sshAddressable: true,
      ephemeral: true,
      usesLedger: true,
    });
    assert.equal(provider().kind, "fly");
  });

  test("provision POSTs to the Machines create endpoint with auth + image + region", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });

    await prov.provision(provisionRequest("box-aaa"));

    const post = requests.find((r) => r.method === "POST");
    assert.ok(post);
    // Default Machines API host, app-scoped create path.
    assert.equal(post!.url, `https://api.machines.dev/v1/apps/${APP}/machines`);
    assert.equal(post!.headers["Authorization"], `Bearer ${TOKEN}`);
    assert.equal(post!.headers["Content-Type"], "application/json");
    const body = post!.body as Record<string, unknown>;
    assert.equal(body.region, "iad");
    const config = body.config as Record<string, unknown>;
    assert.equal(config.image, "ghcr.io/org/box-sshd:latest");
  });

  test("provision labels the machine via config.metadata (boxId + pool label)", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });

    await prov.provision(provisionRequest("box-aaa"));

    const post = requests.find((r) => r.method === "POST")!;
    const config = (post.body as Record<string, unknown>).config as Record<string, unknown>;
    const metadata = config.metadata as Record<string, string>;
    // The pool label + the boxId are stamped so list()-reconcile can re-adopt.
    assert.equal(metadata["symphony_box_pool"], "true");
    assert.equal(metadata["symphony_box_id"], "box-aaa");
  });

  test("provision returns an SSH-addressable workerHost using the private_ip + ssh_user/ssh_port", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings({ ssh_user: "agent", ssh_port: 2222 }), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });

    const box = await prov.provision(provisionRequest("box-aaa"));

    // user@[<private-ipv6>]:port — addressable from the Fly private network.
    // The v6 literal is bracketed so the SSH parser can split off the port.
    assert.equal(box.workerHost, "agent@[fdaa:0:1::1]:2222");
    assert.equal(box.providerRef, "91857940a44389-0");
    assert.deepEqual([...box.labels].sort(), ["symphony.app:symphony-pool", "symphony.box-pool"]);
  });

  test("provision defaults ssh_user=root and ssh_port=22 when not configured", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });

    const box = await prov.provision(provisionRequest("box-aaa"));
    assert.equal(box.workerHost, "root@[fdaa:0:1::1]:22");
  });

  test("provision honors an explicit ssh_host_template override", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(
      settings({ ssh_host_template: "{machineId}.vm.{app}.internal", ssh_user: "agent" }),
      deps,
      {
        fetch,
        runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
      },
    );

    const box = await prov.provision(provisionRequest("box-aaa"));
    assert.equal(box.workerHost, "agent@91857940a44389-0.vm.symphony-pool.internal:22");
  });

  test("workerHost for an IPv6 private_ip parses through @symphony/ssh (bracketed host + -p port)", async () => {
    // A Fly private IPv6 (fdaa:0:...) must yield a workerHost the SSH parser can
    // split into a destination + a port. An unbracketed v6 literal with a glued
    // :port collapses to a single host with NO -p, so the probe/runner cannot
    // connect (Codex finding #3). Render the v6 literal bracketed so the SSH
    // bracketedHost path lifts the trailing :port into -p.
    const { fetch } = makeFakeFly({
      onCreate: () =>
        jsonResponse(200, {
          id: "m-v6",
          state: "started",
          region: "iad",
          private_ip: "fdaa:0:1::1",
          config: { image: "img", metadata: { symphony_box_pool: "true" } },
        }),
    });
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings({ ssh_user: "agent", ssh_port: 2222 }), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });

    const box = await prov.provision(provisionRequest("box-aaa"));

    const target = parseSshTarget(box.workerHost);
    // The port must be carried OUT of the destination (not glued into the host).
    assert.equal(target.port, "2222");
    assert.equal(target.destination, "agent@[fdaa:0:1::1]");

    const args = sshArgs(box.workerHost, "printf ready");
    assert.equal(args.includes("-p"), true);
    assert.equal(args[args.indexOf("-p") + 1], "2222");
    assert.equal(args.includes("agent@[fdaa:0:1::1]"), true);
    // The glued `host:port` form must NOT appear as an argv entry.
    assert.equal(
      args.some((a) => a.includes(":2222")),
      false,
    );
  });

  test("workerHost for an IPv4 private_ip parses through @symphony/ssh (bare host + -p port)", async () => {
    const { fetch } = makeFakeFly({
      onCreate: () =>
        jsonResponse(200, {
          id: "m-v4",
          state: "started",
          region: "iad",
          private_ip: "10.0.0.7",
          config: { image: "img", metadata: { symphony_box_pool: "true" } },
        }),
    });
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings({ ssh_user: "agent", ssh_port: 2222 }), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });

    const box = await prov.provision(provisionRequest("box-aaa"));
    // IPv4 stays unbracketed.
    assert.equal(box.workerHost, "agent@10.0.0.7:2222");

    const target = parseSshTarget(box.workerHost);
    assert.equal(target.port, "2222");
    assert.equal(target.destination, "agent@10.0.0.7");

    const args = sshArgs(box.workerHost, "printf ready");
    assert.equal(args.includes("-p"), true);
    assert.equal(args[args.indexOf("-p") + 1], "2222");
    assert.equal(args.includes("agent@10.0.0.7"), true);
  });

  test("workerHost for a DNS ssh_host_template parses through @symphony/ssh (bare host + -p port)", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(
      settings({ ssh_host_template: "{machineId}.vm.{app}.internal", ssh_user: "agent" }),
      deps,
      {
        fetch,
        runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
      },
    );

    const box = await prov.provision(provisionRequest("box-aaa"));
    const target = parseSshTarget(box.workerHost);
    assert.equal(target.port, "22");
    assert.equal(target.destination, "agent@91857940a44389-0.vm.symphony-pool.internal");

    const args = sshArgs(box.workerHost, "printf ready");
    assert.equal(args.includes("-p"), true);
    assert.equal(args[args.indexOf("-p") + 1], "22");
  });

  test("camelCase providerOptions are honored (app/image/apiToken/sshUser)", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const camel: BoxPoolSettings = {
      enabled: true,
      provider: "fly",
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
      providerOptions: {
        app: "camel-app",
        image: "img:camel",
        apiToken: "camel-token",
        sshUser: "camel",
      },
    };
    const prov = new FlyBoxProvider(camel, deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });

    const box = await prov.provision({ boxId: "box-z", labels: [], timeoutMs: 30_000 });

    const post = requests.find((r) => r.method === "POST")!;
    assert.equal(post.url, "https://api.machines.dev/v1/apps/camel-app/machines");
    assert.equal(post.headers["Authorization"], "Bearer camel-token");
    assert.match(box.workerHost, /^camel@/);
  });

  test("provision throws fly_app_required when app is missing", () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    assert.throws(
      () =>
        new FlyBoxProvider({ ...settings({ app: undefined }) }, deps, {
          fetch,
          runSsh: async (): Promise<SshRunResult> => ({ stdout: "", stderr: "", status: 0 }),
        }),
      /fly_app_required/,
    );
  });

  test("provision throws fly_image_required when image is missing", () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    assert.throws(
      () =>
        new FlyBoxProvider({ ...settings({ image: undefined }) }, deps, {
          fetch,
          runSsh: async (): Promise<SshRunResult> => ({ stdout: "", stderr: "", status: 0 }),
        }),
      /fly_image_required/,
    );
  });

  test("provision throws fly_api_token_required when no token and no FLY_API_TOKEN env", () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const prev = process.env.FLY_API_TOKEN;
    delete process.env.FLY_API_TOKEN;
    try {
      assert.throws(
        () =>
          new FlyBoxProvider({ ...settings({ api_token: undefined }) }, deps, {
            fetch,
            runSsh: async (): Promise<SshRunResult> => ({ stdout: "", stderr: "", status: 0 }),
          }),
        /fly_api_token_required/,
      );
    } finally {
      if (prev === undefined) delete process.env.FLY_API_TOKEN;
      else process.env.FLY_API_TOKEN = prev;
    }
  });

  test("api token falls back to FLY_API_TOKEN env when not in providerOptions", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const prev = process.env.FLY_API_TOKEN;
    process.env.FLY_API_TOKEN = "env-token";
    try {
      const prov = new FlyBoxProvider({ ...settings({ api_token: undefined }) }, deps, {
        fetch,
        runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
      });
      await prov.provision(provisionRequest("box-aaa"));
      const post = requests.find((r) => r.method === "POST")!;
      assert.equal(post.headers["Authorization"], "Bearer env-token");
    } finally {
      if (prev === undefined) delete process.env.FLY_API_TOKEN;
      else process.env.FLY_API_TOKEN = prev;
    }
  });

  test("provision maps a non-2xx create response to a fly_provision_failed error", async () => {
    const { fetch } = makeFakeFly({
      onCreate: () => jsonResponse(422, { error: "image not found" }),
    });
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });

    await assert.rejects(() => prov.provision(provisionRequest("box-aaa")), /fly_provision_failed/);
  });

  test("probe runs runSsh printf-ready against the workerHost with opts.timeoutMs", async () => {
    const calls: Array<{ host: string; command: string; options: SshRunOptions }> = [];
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (host, command, options = {}): Promise<SshRunResult> => {
        calls.push({ host, command, options });
        return { stdout: "ready\n", stderr: "", status: 0 };
      },
    });

    const box = await prov.provision(provisionRequest("box-aaa"));
    const health = await prov.probe(box, { timeoutMs: 9_000 });

    assert.equal(health.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.host, box.workerHost);
    assert.equal(calls[0]?.command, "printf ready");
    assert.equal(calls[0]?.options.timeoutMs, 9_000);
  });

  test("probe gates a non-zero ssh exit to ok:false with a reason", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "", stderr: "boom", status: 255 }),
    });
    const box = await prov.provision(provisionRequest("box-aaa"));
    const health = await prov.probe(box, { timeoutMs: 5_000 });
    assert.equal(health.ok, false);
    if (!health.ok) assert.match(health.reason, /255/);
  });

  test("probe gates an ssh transport error to ok:false (does not throw)", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => {
        throw new Error("ssh_timeout: host 5000");
      },
    });
    const box = await prov.provision(provisionRequest("box-aaa"));
    const health = await prov.probe(box, { timeoutMs: 5_000 });
    assert.equal(health.ok, false);
    if (!health.ok) assert.match(health.reason, /ssh_timeout/);
  });

  test("destroy issues DELETE to the machine endpoint with force=true", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });
    const box = await prov.provision(provisionRequest("box-aaa"));

    await prov.destroy(box, { timeoutMs: 5_000, reason: "shrink" });

    const del = requests.find((r) => r.method === "DELETE");
    assert.ok(del);
    assert.equal(
      del!.url,
      `https://api.machines.dev/v1/apps/${APP}/machines/${box.providerRef}?force=true`,
    );
    assert.equal(del!.headers["Authorization"], `Bearer ${TOKEN}`);
  });

  test("destroy is idempotent: a 404 (already gone) is swallowed", async () => {
    const { fetch } = makeFakeFly({
      onDestroy: () => jsonResponse(404, { error: "machine not found" }),
    });
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });
    const box: BoxDescriptor = {
      boxId: "box-aaa",
      workerHost: "root@fdaa:0:1::1:22",
      providerRef: "already-gone",
      createdAtMs: 0,
      labels: ["symphony.box-pool"],
      metadata: {},
    };
    // Must NOT throw on a 404.
    await prov.destroy(box, { timeoutMs: 5_000, reason: "orphan" });
  });

  test("destroy maps a 5xx error to fly_destroy_failed", async () => {
    const { fetch } = makeFakeFly({
      onDestroy: () => jsonResponse(500, { error: "internal" }),
    });
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });
    const box: BoxDescriptor = {
      boxId: "box-aaa",
      workerHost: "root@fdaa:0:1::1:22",
      providerRef: "m-boom",
      createdAtMs: 0,
      labels: ["symphony.box-pool"],
      metadata: {},
    };
    await assert.rejects(
      () => prov.destroy(box, { timeoutMs: 5_000, reason: "drain" }),
      /fly_destroy_failed/,
    );
  });

  test("destroy aborts and throws (never hangs) when the Fly API stalls past the timeout", async () => {
    // A fetch that NEVER resolves on its own - it settles only when the bounded
    // abort signal fires, mimicking a stuck Fly Machines API call. Without the
    // deadline this would block recycle()/drain() forever.
    const hangingFetch: FlyFetch = (_url, init) =>
      new Promise<FlyFetchResponse>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        });
      });
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch: hangingFetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });
    const box: BoxDescriptor = {
      boxId: "box-aaa",
      workerHost: "root@fdaa:0:1::1:22",
      providerRef: "m-stuck",
      createdAtMs: 0,
      labels: ["symphony.box-pool"],
      metadata: {},
    };
    await assert.rejects(
      () => prov.destroy(box, { timeoutMs: 20, reason: "drain" }),
      /fly_request_timeout/,
    );
  });

  test("list GETs the app machines endpoint and parses only pool-labeled survivors", async () => {
    const mixed = [
      {
        id: "m-ours",
        state: "started",
        private_ip: "fdaa:0:1::a",
        config: {
          image: "img",
          metadata: { symphony_box_pool: "true", symphony_box_id: "box-1" },
        },
      },
      {
        // Unlabeled machine that belongs to the app but NOT to the pool: skipped.
        id: "m-foreign",
        state: "started",
        private_ip: "fdaa:0:1::b",
        config: { image: "other", metadata: {} },
      },
    ];
    const { fetch, requests } = makeFakeFly({ listResponse: () => jsonResponse(200, mixed) });
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });

    const listed = await prov.list();

    const get = requests.find((r) => r.method === "GET");
    assert.ok(get);
    assert.equal(get!.url, `https://api.machines.dev/v1/apps/${APP}/machines`);
    // Only the pool-labeled survivor is adopted; the foreign machine is dropped.
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.boxId, "box-1");
    assert.equal(listed[0]?.providerRef, "m-ours");
    assert.match(listed[0]!.workerHost, /fdaa:0:1::a/);
    // The descriptor surfaces POOL_OWNED_LABEL so the pool's hydrate/reconcile
    // ownership gate re-adopts (and can later clean up) this paid survivor.
    // Without it a crash-leaked machine is a permanent paid orphan.
    assert.equal(listed[0]!.labels.includes(POOL_OWNED_LABEL), true);
  });

  test("list maps a non-2xx response to fly_list_failed", async () => {
    const { fetch } = makeFakeFly({
      listResponse: () => jsonResponse(401, { error: "unauthorized" }),
    });
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings(), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });
    await assert.rejects(() => prov.list(), /fly_list_failed/);
  });

  test("uses a configured api_host_name override for the base url", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(settings({ api_host_name: "https://api.example.test" }), deps, {
      fetch,
      runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
    });
    await prov.provision(provisionRequest("box-aaa"));
    const post = requests.find((r) => r.method === "POST")!;
    assert.equal(post.url, `https://api.example.test/v1/apps/${APP}/machines`);
  });
});

// ---------------------------------------------------------------------------
// Live e2e: provisions and destroys a REAL Fly Machine. Collected-but-skipped
// without the gate so it never runs (or costs) in default CI.
// ---------------------------------------------------------------------------

const LIVE = process.env.SYMPHONY_TS_RUN_LIVE_FLY_E2E === "1" && !!process.env.FLY_API_TOKEN;

describe.skipIf(!LIVE)("FlyBoxProvider live e2e (gated)", () => {
  test("provision -> probe -> destroy against a real Fly app", async () => {
    const app = process.env.SYMPHONY_LIVE_FLY_APP;
    const image = process.env.SYMPHONY_LIVE_FLY_IMAGE;
    expect(app, "set SYMPHONY_LIVE_FLY_APP").toBeTruthy();
    expect(image, "set SYMPHONY_LIVE_FLY_IMAGE").toBeTruthy();

    const { deps } = makeDeps();
    const prov = new FlyBoxProvider(
      settings({
        app,
        image,
        api_token: process.env.FLY_API_TOKEN,
        region: process.env.SYMPHONY_LIVE_FLY_REGION ?? "iad",
        ssh_user: process.env.SYMPHONY_LIVE_FLY_SSH_USER ?? "root",
        ssh_port: Number(process.env.SYMPHONY_LIVE_FLY_SSH_PORT ?? "22"),
      }),
      deps,
    );

    const box = await prov.provision({
      boxId: `live-${Date.now()}`,
      labels: ["symphony.box-pool"],
      timeoutMs: 120_000,
    });
    try {
      let health = await prov.probe(box, { timeoutMs: 30_000 });
      const deadline = Date.now() + 120_000;
      while (!health.ok && Date.now() < deadline) {
        health = await prov.probe(box, { timeoutMs: 30_000 });
      }
      expect(health.ok).toBe(true);

      const listed = await prov.list();
      expect(listed.some((b) => b.providerRef === box.providerRef)).toBe(true);
    } finally {
      await prov.destroy(box, { timeoutMs: 60_000, reason: "drain" });
    }
  });
});
