import { afterEach, beforeEach, expect, test } from "vitest";
import { BoxDriverRegistry, POOL_OWNED_LABEL } from "@symphony/box-sdk";
import type { DriverDeps, ProvisionRequest, SshRunOptions, SshRunResult } from "@symphony/box-sdk";
import { runDriverConformanceSuite } from "@symphony/box-sdk/conformance";

import {
  E2BBoxDriver,
  E2B_BOX_POOL_LABEL,
  e2bBoxDriverFactory,
  registerE2bBoxDriver,
  type E2BSandboxClient,
  type E2BSandboxHandle,
  type E2BSandboxInfo,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// A fake injected E2B client. The driver takes no hard dependency on the E2B
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

// A deterministic clock so `createdAtMs` is reproducible. The driver owns no
// timers (it delegates the probe timeout to runSsh), so set/clear are inert.
function fixedClock(initial: Date): DriverDeps["clock"] {
  return {
    now: () => initial,
    setTimeout: () => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
}

// A runSsh stub that always succeeds (status 0). Tests that care about the probe
// argv override it. The driver must call runSsh with the SSH-addressable
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

function makeDeps(
  events: Record<string, unknown>[] = [],
  runSsh: DriverDeps["runSsh"] = okRunSsh().fn,
): DriverDeps {
  return {
    clock: fixedClock(new Date("2026-05-29T10:00:00.000Z")),
    logEvent: (event) => {
      events.push(event);
    },
    runSsh,
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

// ---------------------------------------------------------------------------
// Shared conformance suite over the fake client. boxIds are arbitrary pool
// idempotency keys (E2B is an ephemeral cloud driver; provision is keyed on
// the pool boxId via sandbox metadata). The unreachable variant injects an
// ssh probe failure.
// ---------------------------------------------------------------------------

runDriverConformanceSuite(
  () => {
    const client = new FakeE2BClient();
    const ssh = okRunSsh();
    return new E2BBoxDriver({}, makeDeps([], ssh.fn), { client });
  },
  {
    suiteName: "E2BBoxDriver",
    boxIds: ["box-a", "box-b"],
    makeUnreachable: () => {
      const client = new FakeE2BClient();
      const driver = new E2BBoxDriver(
        {},
        // A probe that fails (e.g. sshd not up yet) gates the box to ok:false.
        makeDeps([], async () => ({ status: 255, stdout: "", stderr: "connection refused" })),
        { client },
      );
      return { driver, boxId: "box-down" };
    },
  },
);

// ---------------------------------------------------------------------------
// E2B-specific lifecycle, label/metadata, idempotency, and error-mapping tests.
// ---------------------------------------------------------------------------

let client: FakeE2BClient;
let events: Record<string, unknown>[];
let ssh: ReturnType<typeof okRunSsh>;

function makeDriver(template?: string): E2BBoxDriver {
  return new E2BBoxDriver(template ? { image: template } : {}, makeDeps(events, ssh.fn), {
    client,
  });
}

beforeEach(() => {
  client = new FakeE2BClient();
  events = [];
  ssh = okRunSsh();
});

afterEach(() => {
  // No global state to reset; the driver is fully instance-scoped.
});

test("capabilities mark E2B as SSH-addressable, ephemeral, ledger-backed", () => {
  const driver = makeDriver();
  expect(driver.kind).toBe("e2b");
  expect(driver.capabilities).toEqual({
    sshAddressable: true,
    ephemeral: true,
    usesLedger: true,
  });
});

test("provision starts a sandbox tagged with the box-pool label, boxId, and request labels", async () => {
  const driver = makeDriver("ghcr.io/org/box:latest");
  const box = await driver.provision(provisionRequest("box-1"));

  expect(client.createCalls).toHaveLength(1);
  const call = client.createCalls[0];
  // The base image flows through from the `image` driver option as the template.
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
  expect(box.driverRef).toBe("sbx-1");
  expect(box.labels).toEqual(["symphony.box-pool", "team=core"]);
  expect(box.metadata.sandboxId).toBe("sbx-1");
});

test("provision is idempotent on boxId: a second call re-adopts the running sandbox", async () => {
  const driver = makeDriver();
  const first = await driver.provision(provisionRequest("box-1"));
  const second = await driver.provision(provisionRequest("box-1"));

  // No second sandbox is created; the existing one is re-adopted by metadata.
  expect(client.createCalls).toHaveLength(1);
  expect(second.driverRef).toBe(first.driverRef);
  expect(second.workerHost).toBe(first.workerHost);
});

test("provision re-adopts a survivor discovered via list() (cross-instance recovery)", async () => {
  // Simulate a sandbox left running by a prior daemon: it carries the box-pool
  // label + boxId metadata but this driver instance never created it.
  client.sandboxes.set("sbx-orphan", {
    sandboxId: "sbx-orphan",
    metadata: {
      [E2B_BOX_POOL_LABEL]: "true",
      "symphony.box-id": "box-1",
    },
  });
  const driver = makeDriver();
  const box = await driver.provision(provisionRequest("box-1"));

  // The survivor is re-adopted, not duplicated.
  expect(client.createCalls).toHaveLength(0);
  expect(box.driverRef).toBe("sbx-orphan");
});

test("destroy kills the sandbox and is idempotent (already-gone is ok)", async () => {
  const driver = makeDriver();
  const box = await driver.provision(provisionRequest("box-1"));

  await driver.destroy(box, { timeoutMs: 30_000, reason: "idle" });
  expect(client.killed).toEqual(["sbx-1"]);
  expect(client.sandboxes.has("sbx-1")).toBe(false);

  // A second destroy is tolerated: the sandbox is already gone.
  await driver.destroy(box, { timeoutMs: 30_000, reason: "idle" });
});

test("destroy swallows a not-found error (the box is already gone)", async () => {
  const driver = makeDriver();
  const box = await driver.provision(provisionRequest("box-1"));
  client.notFoundOnKill.add("sbx-1");

  // A "not found" from kill must NOT propagate: the desired end state (gone) holds.
  await driver.destroy(box, { timeoutMs: 30_000, reason: "drain" });
  expect(client.killed).toContain("sbx-1");
});

test("list returns only pool-owned running sandboxes, mapped to descriptors", async () => {
  const driver = makeDriver();
  await driver.provision(provisionRequest("box-1"));
  // An unrelated, non-pool sandbox must NOT be returned (we never destroy what we do not own).
  client.sandboxes.set("sbx-foreign", { sandboxId: "sbx-foreign", metadata: {} });

  const listed = await driver.list();
  expect(listed.map((b) => b.driverRef).sort()).toEqual(["sbx-1"]);
  const adopted = listed.find((b) => b.driverRef === "sbx-1");
  expect(adopted?.boxId).toBe("box-1");
  // The descriptor must surface POOL_OWNED_LABEL so the pool's hydrate/reaper
  // ownership gate re-adopts (and can later destroy) this survivor; without it
  // a leaked paid sandbox would never be reaped.
  expect(adopted?.labels).toContain(POOL_OWNED_LABEL);
  expect(adopted?.labels).toEqual([POOL_OWNED_LABEL, "symphony.box-pool", "team=core"]);
});

test("probe runs runSsh printf-ready against the workerHost with the supplied timeout", async () => {
  const driver = makeDriver();
  const box = await driver.provision(provisionRequest("box-1"));

  const health = await driver.probe(box, { timeoutMs: 12_345 });
  expect(health.ok).toBe(true);
  expect(ssh.calls).toHaveLength(1);
  expect(ssh.calls[0].host).toBe("root@1.2.3.4:22");
  expect(ssh.calls[0].command).toContain("ready");
  expect(ssh.calls[0].options?.timeoutMs).toBe(12_345);
});

test("probe gates to ok:false (not throwing) when the SSH transport errors", async () => {
  const driver = new E2BBoxDriver(
    {},
    makeDeps(events, async () => {
      throw new Error("ssh_timeout");
    }),
    { client },
  );
  const box = await driver.provision(provisionRequest("box-1"));

  const health = await driver.probe(box, { timeoutMs: 1_000 });
  expect(health.ok).toBe(false);
  if (!health.ok) {
    expect(health.reason).toContain("ssh_timeout");
  }
});

test("provision maps a client create failure to a typed e2b_provision_failed error", async () => {
  client.createError = new Error("quota exceeded");
  const driver = makeDriver();

  await expect(driver.provision(provisionRequest("box-1"))).rejects.toThrow(
    /^e2b_provision_failed: quota exceeded$/,
  );
});

test("destroy maps a non-not-found client kill failure to a typed e2b_destroy_failed error", async () => {
  const driver = makeDriver();
  const box = await driver.provision(provisionRequest("box-1"));
  client.killError = new Error("api unavailable");

  await expect(driver.destroy(box, { timeoutMs: 30_000, reason: "ttl" })).rejects.toThrow(
    /^e2b_destroy_failed: api unavailable$/,
  );
});

test("list maps a client list failure to a typed e2b_list_failed error", async () => {
  client.listError = new Error("api unavailable");
  const driver = makeDriver();

  await expect(driver.list()).rejects.toThrow(/^e2b_list_failed: api unavailable$/);
});

test("throws e2b_client_unavailable when no client is injected and no SDK is wired", () => {
  // The extension takes no hard SDK dependency: with no injected client and no
  // resolvable default, constructing the driver must fail loud rather than
  // silently no-op.
  expect(() => new E2BBoxDriver({}, makeDeps())).toThrow(/e2b_client_unavailable/);
});

test("registerE2bBoxDriver without io registers a fail-loud factory", () => {
  const registry = new BoxDriverRegistry();
  registerE2bBoxDriver({ boxDrivers: registry });
  // A second registration is a no-op (the kind is already registered).
  registerE2bBoxDriver({ boxDrivers: registry });

  // Enabling the kind without a configured client fails loud at pool
  // construction with an actionable message, not at first provision.
  const factory = registry.require("e2b");
  expect(() => factory.create({}, makeDeps())).toThrow(
    "box_pool_driver_unavailable: e2b requires an injected client; register a configured e2b driver via registerE2bBoxDriver(registries, { client }) before enabling it",
  );
});

test("registerE2bBoxDriver with io registers a working factory closing over the client", () => {
  const registry = new BoxDriverRegistry();
  registerE2bBoxDriver({ boxDrivers: registry }, { client: new FakeE2BClient() });

  const driver = registry.require("e2b").create({}, makeDeps());
  expect(driver.kind).toBe("e2b");
});

test("e2bBoxDriverFactory constructs a working driver over the injected client", async () => {
  const factory = e2bBoxDriverFactory({ client });
  expect(factory.kind).toBe("e2b");

  const driver = factory.create({ image: "tmpl" }, makeDeps(events, ssh.fn));
  const box = await driver.provision(provisionRequest("box-1"));
  expect(box.workerHost).toBe("root@1.2.3.4:22");
  expect(client.createCalls[0]?.template).toBe("tmpl");
});
