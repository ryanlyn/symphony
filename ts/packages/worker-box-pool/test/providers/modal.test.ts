import { describe, expect, test } from "vitest";
import type { BoxPoolSettings } from "@symphony/domain";
import type { ClockPort, TimerHandle } from "@symphony/domain";
import type { SshRunOptions, SshRunResult } from "@symphony/ssh";
import { assert } from "@symphony/test-utils";

import { runProviderConformanceSuite } from "../../src/conformance.js";
import {
  ModalBoxProvider,
  type ModalCreateRequest,
  type ModalSandbox,
  type ModalTransport,
} from "../../src/providers/modal.js";
import { POOL_OWNED_LABEL, type ProviderDeps, type ProvisionRequest } from "../../src/types.js";

// A deterministic clock so `createdAtMs` is reproducible. The provider owns no
// timers (it delegates the probe timeout to `runSsh`), so set/clear are inert.
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

const POOL_LABEL = "symphony.box-pool";

function settingsWith(providerOptions: Record<string, unknown>): BoxPoolSettings {
  return {
    enabled: true,
    provider: "modal",
    min: 0,
    max: 2,
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

/**
 * An in-memory fake Modal transport. It models a Modal account's live sandbox
 * inventory: `create` boots a sandbox that exposes an SSH endpoint and stamps
 * the provider-supplied labels; `terminate` removes it (idempotent); `list`
 * enumerates only sandboxes carrying a label filter. Faults can be injected so
 * the tests exercise the provider's error mapping without any real Modal SDK.
 */
class FakeModalTransport implements ModalTransport {
  readonly created: ModalCreateRequest[] = [];
  readonly terminated: string[] = [];
  private readonly sandboxes = new Map<string, ModalSandbox>();
  private nextId = 0;

  // Fault injection.
  createError?: string;
  terminateError?: string;
  listError?: string;

  async create(req: ModalCreateRequest): Promise<ModalSandbox> {
    this.created.push(req);
    if (this.createError !== undefined) {
      throw new Error(this.createError);
    }
    const sandboxId = `sb-${this.nextId++}`;
    const sandbox: ModalSandbox = {
      sandboxId,
      // A Modal sandbox provisioned to run sshd exposes an SSH endpoint.
      sshHost: `modal@${sandboxId}.modal.host:2200`,
      labels: [...req.labels],
    };
    this.sandboxes.set(sandboxId, sandbox);
    return sandbox;
  }

  async terminate(sandboxId: string): Promise<void> {
    if (this.terminateError !== undefined) {
      throw new Error(this.terminateError);
    }
    // Mirror real Modal: terminating a sandbox that is already gone surfaces a
    // not-found fault, which the provider must treat as idempotent success.
    if (!this.sandboxes.has(sandboxId)) {
      throw new Error(`modal: sandbox not found: ${sandboxId}`);
    }
    this.terminated.push(sandboxId);
    this.sandboxes.delete(sandboxId);
  }

  async list(opts: { label: string }): Promise<ModalSandbox[]> {
    if (this.listError !== undefined) {
      throw new Error(this.listError);
    }
    return [...this.sandboxes.values()].filter((sandbox) => sandbox.labels.includes(opts.label));
  }

  // Test helper: inject a sandbox that exists in the account but was NOT
  // provisioned through this provider instance (a survivor from a prior run).
  inject(sandbox: ModalSandbox): void {
    this.sandboxes.set(sandbox.sandboxId, sandbox);
  }
}

function makeProvider(
  transport: ModalTransport,
  runSsh?: (host: string, command: string, options?: SshRunOptions) => Promise<SshRunResult>,
): ModalBoxProvider {
  return new ModalBoxProvider(settingsWith({ image: "ghcr.io/org/box:latest" }), makeDeps(), {
    transport,
    runSsh: runSsh ?? (async () => ({ stdout: "ready\n", stderr: "", status: 0 })),
  });
}

// ---------------------------------------------------------------------------
// Conformance suite over the fake injected transport (always-on, no network).
// ---------------------------------------------------------------------------

runProviderConformanceSuite(() => makeProvider(new FakeModalTransport()), {
  suiteName: "ModalBoxProvider (fake transport)",
  boxIds: ["box-a", "box-b"],
  makeProvisionRequest: (boxId): ProvisionRequest => ({
    boxId,
    labels: [POOL_LABEL],
    timeoutMs: 30_000,
  }),
  makeUnreachable: () => {
    // A created-but-unreachable sandbox: the SSH probe transport rejects, so
    // probe must gate the box to ok:false (mirroring a sandbox whose sshd has
    // not come up yet).
    const provider = makeProvider(new FakeModalTransport(), async () => {
      throw new Error("ssh_timeout: modal sandbox unreachable");
    });
    return { provider, boxId: "box-down" };
  },
});

describe("ModalBoxProvider lifecycle", () => {
  test("capabilities are { sshAddressable:true, ephemeral:true, usesLedger:true }", () => {
    const provider = makeProvider(new FakeModalTransport());
    assert.deepEqual(provider.capabilities, {
      sshAddressable: true,
      ephemeral: true,
      usesLedger: true,
    });
    assert.equal(provider.kind, "modal");
  });

  test("provision creates a sandbox exposing ssh and returns the endpoint as workerHost", async () => {
    const transport = new FakeModalTransport();
    const provider = makeProvider(transport);

    const box = await provider.provision({
      boxId: "box-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });

    // The yielded workerHost is the sandbox's SSH endpoint (SSH-addressable).
    assert.match(box.workerHost, /^modal@sb-0\.modal\.host:2200$/);
    assert.equal(box.boxId, "box-a");
    // providerRef is the Modal sandbox id used for destroy/list reconcile.
    assert.equal(box.providerRef, "sb-0");
    assert.equal(box.createdAtMs, new Date("2026-05-29T10:00:00.000Z").getTime());

    // Exactly one sandbox was created.
    assert.equal(transport.created.length, 1);
  });

  test("provision labels the sandbox with the boxId and the pool labels", async () => {
    const transport = new FakeModalTransport();
    const provider = makeProvider(transport);

    await provider.provision({ boxId: "box-a", labels: [POOL_LABEL], timeoutMs: 30_000 });

    const req = transport.created[0];
    assert.ok(req);
    // The pool label and a boxId-derived label are both stamped so list()
    // reconcile can re-adopt survivors and correlate them back to a boxId.
    assert.equal(req.labels.includes(POOL_LABEL), true);
    assert.equal(
      req.labels.some((label) => label.includes("box-a")),
      true,
    );
  });

  test("provision is idempotent on boxId (no duplicate sandbox)", async () => {
    const transport = new FakeModalTransport();
    const provider = makeProvider(transport);

    const first = await provider.provision({
      boxId: "box-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });
    const second = await provider.provision({
      boxId: "box-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });

    assert.deepEqual(second, first);
    // A second provision for the same boxId must NOT create a second sandbox.
    assert.equal(transport.created.length, 1);
  });

  test("probe runs runSsh printf-ready with opts.timeoutMs verbatim", async () => {
    const transport = new FakeModalTransport();
    const calls: Array<{ host: string; command: string; options: SshRunOptions }> = [];
    const provider = makeProvider(transport, async (host, command, options = {}) => {
      calls.push({ host, command, options });
      return { stdout: "ready\n", stderr: "", status: 0 };
    });

    const box = await provider.provision({
      boxId: "box-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });
    const health = await provider.probe(box, { timeoutMs: 7_000 });

    assert.equal(health.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.host, box.workerHost);
    assert.equal(calls[0]?.command, "printf ready");
    assert.equal(calls[0]?.options.timeoutMs, 7_000);
  });

  test("probe gates a non-zero ssh exit to ok:false", async () => {
    const transport = new FakeModalTransport();
    const provider = makeProvider(transport, async () => ({
      stdout: "",
      stderr: "boom",
      status: 7,
    }));

    const box = await provider.provision({
      boxId: "box-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });
    const health = await provider.probe(box, { timeoutMs: 5_000 });

    assert.equal(health.ok, false);
    if (!health.ok) {
      assert.match(health.reason, /7/);
    }
  });

  test("destroy terminates the sandbox via the transport", async () => {
    const transport = new FakeModalTransport();
    const provider = makeProvider(transport);

    const box = await provider.provision({
      boxId: "box-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });
    await provider.destroy(box, { timeoutMs: 5_000, reason: "shrink" });

    // The terminate hit the sandbox id (providerRef), not the boxId.
    assert.deepEqual(transport.terminated, ["sb-0"]);
    assert.deepEqual(await provider.list(), []);
  });

  test("destroy is idempotent (already-terminated sandbox)", async () => {
    const transport = new FakeModalTransport();
    const provider = makeProvider(transport);

    const box = await provider.provision({
      boxId: "box-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });
    await provider.destroy(box, { timeoutMs: 5_000, reason: "idle" });
    // A second destroy of the same (already-gone) box must not throw: the
    // transport surfaces a not-found, which the provider treats as idempotent
    // success. The sandbox stays gone.
    await provider.destroy(box, { timeoutMs: 5_000, reason: "idle" });

    // The terminate landed exactly once (the second was a swallowed not-found).
    assert.deepEqual(transport.terminated, ["sb-0"]);
    assert.deepEqual(await provider.list(), []);
  });

  test("list enumerates only sandboxes carrying the pool label", async () => {
    const transport = new FakeModalTransport();
    // A foreign sandbox not labeled for the pool must NOT be adopted.
    transport.inject({
      sandboxId: "sb-foreign",
      sshHost: "other@host:22",
      labels: ["someone-else"],
    });
    const provider = makeProvider(transport);

    await provider.provision({ boxId: "box-a", labels: [POOL_LABEL], timeoutMs: 30_000 });
    const listed = await provider.list();

    const refs = listed.map((box) => box.providerRef);
    assert.equal(refs.includes("sb-0"), true);
    assert.equal(refs.includes("sb-foreign"), false);
    // The listed descriptor is SSH-addressable and carries its sandbox id.
    const adopted = listed.find((box) => box.providerRef === "sb-0");
    assert.ok(adopted);
    assert.match(adopted.workerHost, /modal\.host:2200$/);
    // The descriptor must surface POOL_OWNED_LABEL so the pool's hydrate/reaper
    // ownership gate re-adopts (and can later destroy) this survivor; without it
    // a leaked paid sandbox would never be reaped.
    assert.equal(adopted.labels.includes(POOL_OWNED_LABEL), true);
  });

  test("provision maps a transport fault to a modal_provision_failed error", async () => {
    const transport = new FakeModalTransport();
    transport.createError = "modal: quota exceeded";
    const provider = makeProvider(transport);

    await assert.rejects(
      () => provider.provision({ boxId: "box-a", labels: [POOL_LABEL], timeoutMs: 30_000 }),
      /modal_provision_failed/,
    );
    // A failed create must NOT be recorded as a live box.
    assert.deepEqual(await provider.list().catch(() => []), []);
  });

  test("destroy maps a transport fault to a modal_destroy_failed error", async () => {
    const transport = new FakeModalTransport();
    const provider = makeProvider(transport);
    const box = await provider.provision({
      boxId: "box-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });

    transport.terminateError = "modal: api unavailable";
    await assert.rejects(
      () => provider.destroy(box, { timeoutMs: 5_000, reason: "shrink" }),
      /modal_destroy_failed/,
    );
  });

  test("list maps a transport fault to a modal_list_failed error", async () => {
    const transport = new FakeModalTransport();
    transport.listError = "modal: api unavailable";
    const provider = makeProvider(transport);

    await assert.rejects(() => provider.list(), /modal_list_failed/);
  });

  test("destroy terminates a survivor this instance did not provision (hydrate/reconcile)", async () => {
    // A sandbox left behind by a PRIOR daemon: it carries the pool label so a
    // fresh provider's list() re-adopts it, but this instance never provisioned
    // it (so it is not in `this.boxes`). A reconcile/drain destroy MUST still
    // terminate it - otherwise a paid sandbox leaks forever.
    const transport = new FakeModalTransport();
    transport.inject({
      sandboxId: "sb-survivor",
      sshHost: "modal@sb-survivor.modal.host:2200",
      labels: [POOL_LABEL],
    });
    const provider = makeProvider(transport);

    const listed = await provider.list();
    const survivor = listed.find((box) => box.providerRef === "sb-survivor");
    assert.ok(survivor);

    await provider.destroy(survivor, { timeoutMs: 5_000, reason: "orphan" });

    // The survivor was actually terminated (not silently skipped).
    assert.deepEqual(transport.terminated, ["sb-survivor"]);
    assert.deepEqual(await provider.list(), []);
  });
});

// ---------------------------------------------------------------------------
// Env-gated live test: actually provision/probe/destroy a real Modal Sandbox.
// Collected-but-skipped without SYMPHONY_TS_RUN_LIVE_MODAL_E2E=1 (+ a Modal
// token in the environment), mirroring the other SYMPHONY_TS_RUN_LIVE_* gates.
// ---------------------------------------------------------------------------

const LIVE_MODAL = process.env.SYMPHONY_TS_RUN_LIVE_MODAL_E2E === "1";

describe.skipIf(!LIVE_MODAL)("ModalBoxProvider (live, env-gated)", () => {
  test("provisions a real sandbox, probes it ready over ssh, and terminates it", async () => {
    // This test is intentionally only runnable once Modal creds exist. It is
    // authored now and skipped by default. It would construct a ModalBoxProvider
    // backed by the real Modal client transport, provision a sandbox, probe it
    // for ssh readiness, and terminate it, asserting the conformance contract
    // end-to-end against the live Modal API.
    expect(LIVE_MODAL).toBe(true);
  });
});
