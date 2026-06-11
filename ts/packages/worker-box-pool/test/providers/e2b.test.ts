import { afterEach, beforeEach, expect, test } from "vitest";
import type { BoxPoolProvider, BoxPoolSettings } from "@symphony/domain";
import type { ClockPort, TimerHandle } from "@symphony/domain";
import type { SshRunOptions, SshRunResult } from "@symphony/ssh";

import { runProviderConformanceSuite } from "../../src/conformance.js";
import {
  E2BBoxProvider,
  E2B_BOX_POOL_LABEL,
  type E2BSandboxClient,
  type E2BSandboxHandle,
  type E2BSandboxInfo,
} from "../../src/providers/e2b.js";
import { POOL_OWNED_LABEL, type ProviderDeps, type ProvisionRequest } from "../../src/types.js";

// A minimal BoxPoolSettings for a cloud provider under test. The pool's numeric
// knobs are irrelevant to a single provider's lifecycle, so they take sane
// defaults; `providerOptions` carries the only provider-relevant config (e.g.
// the sandbox base image flows through as `image`).
function settingsForProvider(
  provider: BoxPoolProvider,
  providerOptions: Record<string, unknown> = {},
): BoxPoolSettings {
  return {
    enabled: true,
    provider,
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

// ---------------------------------------------------------------------------
// A fake injected E2B client. The provider takes no hard dependency on the E2B
// SDK; everything goes through this small interface so the always-on tests run
// with zero network/cost. The fake records every lifecycle call so a test can
// assert argument construction, metadata/label handling, and idempotency.
// ---------------------------------------------------------------------------

interface CreateCall {
  metadata: Record<string, string>;
  template?: string;
  timeoutMs?: number;
}

class FakeE2BClient implements E2BSandboxClient {
  // Running sandboxes keyed by sandboxId.
  readonly sandboxes = new Map<string, E2BSandboxInfo>();
  readonly createCalls: CreateCall[] = [];
  readonly killed: string[] = [];

  // Failure injection.
  createError: Error | undefined;
  killError: Error | undefined;
  listError: Error | undefined;
  // Sandboxes whose id is in this set throw "not found" on kill (already gone).
  readonly notFoundOnKill = new Set<string>();

  private counter = 0;
  // SSH host/port the created sandbox advertises. Tests can override.
  sshHost = "1.2.3.4";
  sshPort = 22;
  sshUser = "root";

  async create(opts: {
    metadata: Record<string, string>;
    template?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<E2BSandboxHandle> {
    this.createCalls.push({
      metadata: opts.metadata,
      template: opts.template,
      timeoutMs: opts.timeoutMs,
    });
    if (this.createError) {
      throw this.createError;
    }
    this.counter += 1;
    const sandboxId = `sbx-${this.counter}`;
    const info: E2BSandboxInfo = { sandboxId, metadata: opts.metadata };
    this.sandboxes.set(sandboxId, info);
    return {
      sandboxId,
      getSshEndpoint: () => ({ host: this.sshHost, port: this.sshPort, user: this.sshUser }),
    };
  }

  async kill(sandboxId: string): Promise<void> {
    this.killed.push(sandboxId);
    if (this.killError) {
      throw this.killError;
    }
    if (this.notFoundOnKill.has(sandboxId)) {
      throw new Error("sandbox not found");
    }
    this.sandboxes.delete(sandboxId);
  }

  async list(): Promise<E2BSandboxInfo[]> {
    if (this.listError) {
      throw this.listError;
    }
    return [...this.sandboxes.values()];
  }
}

// A deterministic clock so `createdAtMs` is reproducible. The provider owns no
// timers (it delegates the probe timeout to runSsh), so set/clear are inert.
function fixedClock(initial: Date): ClockPort {
  return {
    now: () => initial,
    setTimeout: (): TimerHandle => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
}

function makeDeps(events: Record<string, unknown>[] = []): ProviderDeps {
  return {
    clock: fixedClock(new Date("2026-05-29T10:00:00.000Z")),
    logEvent: (event) => {
      events.push(event);
    },
  };
}

function provisionRequest(
  boxId: string,
  overrides: Partial<ProvisionRequest> = {},
): ProvisionRequest {
  return {
    boxId,
    labels: ["symphony.box-pool", "team=core"],
    timeoutMs: 30_000,
    ...overrides,
  };
}

// A runSsh stub that always succeeds (status 0). Tests that care about the probe
// argv override it. The provider must call runSsh with the SSH-addressable
// workerHost it returned from provision().
function okRunSsh(): {
  fn: (host: string, command: string, options?: SshRunOptions) => Promise<SshRunResult>;
  calls: { host: string; command: string; options?: SshRunOptions }[];
} {
  const calls: { host: string; command: string; options?: SshRunOptions }[] = [];
  return {
    calls,
    fn: async (host, command, options) => {
      calls.push({ host, command, options });
      return { status: 0, stdout: "ready", stderr: "" };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared conformance suite over the fake client. boxIds are arbitrary pool
// idempotency keys (E2B is an ephemeral cloud provider; provision is keyed on
// the pool boxId via sandbox metadata). The unreachable variant injects an
// ssh probe failure.
// ---------------------------------------------------------------------------

runProviderConformanceSuite(
  () => {
    const client = new FakeE2BClient();
    const ssh = okRunSsh();
    return new E2BBoxProvider(settingsForProvider("e2b"), makeDeps(), {
      client,
      runSsh: ssh.fn,
    });
  },
  {
    suiteName: "E2BBoxProvider",
    boxIds: ["box-a", "box-b"],
    makeUnreachable: () => {
      const client = new FakeE2BClient();
      const provider = new E2BBoxProvider(settingsForProvider("e2b"), makeDeps(), {
        client,
        // A probe that fails (e.g. sshd not up yet) gates the box to ok:false.
        runSsh: async () => ({ status: 255, stdout: "", stderr: "connection refused" }),
      });
      return { provider, boxId: "box-down" };
    },
  },
);

// ---------------------------------------------------------------------------
// E2B-specific lifecycle, label/metadata, idempotency, and error-mapping tests.
// ---------------------------------------------------------------------------

let client: FakeE2BClient;
let events: Record<string, unknown>[];
let ssh: ReturnType<typeof okRunSsh>;

function makeProvider(template?: string): E2BBoxProvider {
  return new E2BBoxProvider(
    settingsForProvider("e2b", template ? { image: template } : {}),
    makeDeps(events),
    {
      client,
      runSsh: ssh.fn,
    },
  );
}

beforeEach(() => {
  client = new FakeE2BClient();
  events = [];
  ssh = okRunSsh();
});

afterEach(() => {
  // No global state to reset; the provider is fully instance-scoped.
});

test("capabilities mark E2B as SSH-addressable, ephemeral, ledger-backed", () => {
  const provider = makeProvider();
  expect(provider.kind).toBe("e2b");
  expect(provider.capabilities).toEqual({
    sshAddressable: true,
    ephemeral: true,
    usesLedger: true,
  });
});

test("provision starts a sandbox tagged with the box-pool label, boxId, and request labels", async () => {
  const provider = makeProvider("ghcr.io/org/box:latest");
  const box = await provider.provision(provisionRequest("box-1"));

  expect(client.createCalls).toHaveLength(1);
  const call = client.createCalls[0];
  // The base image flows through from providerOptions.image as the template.
  expect(call.template).toBe("ghcr.io/org/box:latest");
  // Metadata carries the pool-owned marker label (so list() can re-adopt
  // survivors) and the pool's idempotency key.
  expect(call.metadata[E2B_BOX_POOL_LABEL]).toBe("true");
  expect(call.metadata["symphony.box-id"]).toBe("box-1");
  // The request labels are recorded on the descriptor and the sandbox metadata.
  expect(call.metadata["symphony.labels"]).toBe("symphony.box-pool,team=core");

  // The descriptor advertises the SSH endpoint as the workerHost.
  expect(box.boxId).toBe("box-1");
  expect(box.workerHost).toBe("root@1.2.3.4:22");
  expect(box.providerRef).toBe("sbx-1");
  expect(box.labels).toEqual(["symphony.box-pool", "team=core"]);
  expect(box.metadata.sandboxId).toBe("sbx-1");
});

test("provision is idempotent on boxId: a second call re-adopts the running sandbox", async () => {
  const provider = makeProvider();
  const first = await provider.provision(provisionRequest("box-1"));
  const second = await provider.provision(provisionRequest("box-1"));

  // No second sandbox is created; the existing one is re-adopted by metadata.
  expect(client.createCalls).toHaveLength(1);
  expect(second.providerRef).toBe(first.providerRef);
  expect(second.workerHost).toBe(first.workerHost);
});

test("provision re-adopts a survivor discovered via list() (cross-instance recovery)", async () => {
  // Simulate a sandbox left running by a prior daemon: it carries the box-pool
  // label + boxId metadata but this provider instance never created it.
  client.sandboxes.set("sbx-orphan", {
    sandboxId: "sbx-orphan",
    metadata: {
      [E2B_BOX_POOL_LABEL]: "true",
      "symphony.box-id": "box-1",
    },
  });
  const provider = makeProvider();
  const box = await provider.provision(provisionRequest("box-1"));

  // The survivor is re-adopted, not duplicated.
  expect(client.createCalls).toHaveLength(0);
  expect(box.providerRef).toBe("sbx-orphan");
});

test("destroy kills the sandbox and is idempotent (already-gone is ok)", async () => {
  const provider = makeProvider();
  const box = await provider.provision(provisionRequest("box-1"));

  await provider.destroy(box, { timeoutMs: 30_000, reason: "idle" });
  expect(client.killed).toEqual(["sbx-1"]);
  expect(client.sandboxes.has("sbx-1")).toBe(false);

  // A second destroy is tolerated: the sandbox is already gone.
  await provider.destroy(box, { timeoutMs: 30_000, reason: "idle" });
});

test("destroy swallows a provider not-found error (the box is already gone)", async () => {
  const provider = makeProvider();
  const box = await provider.provision(provisionRequest("box-1"));
  client.notFoundOnKill.add("sbx-1");

  // A "not found" from kill must NOT propagate: the desired end state (gone) holds.
  await provider.destroy(box, { timeoutMs: 30_000, reason: "drain" });
  expect(client.killed).toContain("sbx-1");
});

test("list returns only pool-owned running sandboxes, mapped to descriptors", async () => {
  const provider = makeProvider();
  await provider.provision(provisionRequest("box-1"));
  // An unrelated, non-pool sandbox must NOT be returned (we never destroy what we do not own).
  client.sandboxes.set("sbx-foreign", { sandboxId: "sbx-foreign", metadata: {} });

  const listed = await provider.list();
  expect(listed.map((b) => b.providerRef).sort()).toEqual(["sbx-1"]);
  const adopted = listed.find((b) => b.providerRef === "sbx-1");
  expect(adopted?.boxId).toBe("box-1");
  // The descriptor must surface POOL_OWNED_LABEL so the pool's hydrate/reaper
  // ownership gate re-adopts (and can later destroy) this survivor; without it
  // a leaked paid sandbox would never be reaped.
  expect(adopted?.labels).toContain(POOL_OWNED_LABEL);
  expect(adopted?.labels).toEqual([POOL_OWNED_LABEL, "symphony.box-pool", "team=core"]);
});

test("probe runs runSsh printf-ready against the workerHost with the supplied timeout", async () => {
  const provider = makeProvider();
  const box = await provider.provision(provisionRequest("box-1"));

  const health = await provider.probe(box, { timeoutMs: 12_345 });
  expect(health.ok).toBe(true);
  expect(ssh.calls).toHaveLength(1);
  expect(ssh.calls[0].host).toBe("root@1.2.3.4:22");
  expect(ssh.calls[0].command).toContain("ready");
  expect(ssh.calls[0].options?.timeoutMs).toBe(12_345);
});

test("probe gates to ok:false (not throwing) when the SSH transport errors", async () => {
  const provider = new E2BBoxProvider(settingsForProvider("e2b"), makeDeps(events), {
    client,
    runSsh: async () => {
      throw new Error("ssh_timeout");
    },
  });
  const box = await provider.provision(provisionRequest("box-1"));

  const health = await provider.probe(box, { timeoutMs: 1_000 });
  expect(health.ok).toBe(false);
  if (!health.ok) {
    expect(health.reason).toContain("ssh_timeout");
  }
});

test("provision maps a client create failure to a typed e2b_provision_failed error", async () => {
  client.createError = new Error("quota exceeded");
  const provider = makeProvider();

  await expect(provider.provision(provisionRequest("box-1"))).rejects.toThrow(
    /^e2b_provision_failed: quota exceeded$/,
  );
});

test("destroy maps a non-not-found client kill failure to a typed e2b_destroy_failed error", async () => {
  const provider = makeProvider();
  const box = await provider.provision(provisionRequest("box-1"));
  client.killError = new Error("api unavailable");

  await expect(provider.destroy(box, { timeoutMs: 30_000, reason: "ttl" })).rejects.toThrow(
    /^e2b_destroy_failed: api unavailable$/,
  );
});

test("list maps a client list failure to a typed e2b_list_failed error", async () => {
  client.listError = new Error("api unavailable");
  const provider = makeProvider();

  await expect(provider.list()).rejects.toThrow(/^e2b_list_failed: api unavailable$/);
});

test("throws e2b_client_unavailable when no client is injected and no SDK is wired", () => {
  // The package takes no hard SDK dependency: with no injected client and no
  // resolvable default, constructing the provider must fail loud rather than
  // silently no-op.
  expect(() => new E2BBoxProvider(settingsForProvider("e2b"), makeDeps())).toThrow(
    /e2b_client_unavailable/,
  );
});
