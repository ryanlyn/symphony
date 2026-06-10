// Codex HIGH #1 regression: the FULL workflow Settings must be threaded end-to-end
// to the per-run endpoint open, NOT the coordinator's BoxPoolSettings.
//
// This pins the integration the per-package unit suites cannot: the REAL
// `createPerRunEndpointManager` over a stub-at-the-ssh-child
// `acquireAgentMcpEndpointForRun` (structurally identical to the production one,
// reading `settings.server.port` exactly as the real `acquireRemoteMcpEndpoint`
// does), driven by the REAL `createDispatchCoordinator` over a fake machine pool.
// The ONLY thing stubbed is the leaf endpoint acquirer (so no token/local-server/
// ssh child is actually minted); the WHOLE settings-threading path the bug lived
// on is the real code.
//
// The bug: the coordinator forwarded its `BoxPoolSettings` (cast to `Settings`) to
// `mcpEndpointManager.open`, so `settings.server.port` was undefined and the real
// `acquireAgentMcpEndpointForRun` threw `remote_acp_mcp_requires_server_port` ->
// every acquire skipped with box_pool_acquire_error and the pool never dispatched.
// The fix threads the FULL workflow `Settings` (with `server.port`) through the
// `AcquireRunSlotRequest`. These tests assert the full Settings flows through and
// the endpoint opens, AND that the box-pool-only settings WOULD have failed (so
// this test would have caught the original bug).
//
// Tests import the compiled package barrels (the suite runs against tsc --build).

import { test } from "vitest";
import { parseConfig } from "@symphony/config";
import type { BoxPoolSettings } from "@symphony/domain";
import type { AgentMcpEndpointLease } from "@symphony/mcp";
import type { AcquireResult, BoxLease, BoxPool, BoxPoolSnapshot, Settings } from "@symphony/cli";

import {
  createDispatchCoordinator,
  createPerRunEndpointManager,
} from "../packages/dispatch-coordinator/dist/index.js";

import { assert } from "./assert.js";

// The REAL coordinator + per-run endpoint manager. `@symphony/dispatch-coordinator`
// is a transitive dep (not declared at the workspace root), so it is imported via
// its compiled barrel by relative path - the same tsc --build output the cli
// re-export resolves to - to drive the genuine settings-threading code path.

// ---------------------------------------------------------------------------
// The stub-at-the-ssh-child endpoint acquirer: structurally identical to the
// production `acquireAgentMcpEndpointForRun(settings, workerHost, runKey)`, and -
// like the real one's `acquireRemoteMcpEndpoint` - it reads `settings.server.port`
// and rejects when it is missing (`remote_acp_mcp_requires_server_port`). It mints
// NO real token/local-server/ssh child; it returns a recognizable fake lease. This
// is the SOLE seam; the per-run manager + coordinator settings threading are real.
// ---------------------------------------------------------------------------

function makeFakeEndpoint(port: number): AgentMcpEndpointLease & { readonly localPort: number } {
  return {
    url: `http://127.0.0.1:46000/claude-mcp#${port}`,
    token: `tok-${port}`,
    acpServer: () => ({ type: "http", name: "symphony_linear", url: "", headers: [] }),
    localPort: port,
    async release(): Promise<void> {},
  };
}

interface AcquireCall {
  settings: Settings;
  workerHost: string;
  runKey: string;
}

function makeStubAcquireForRun(
  calls: AcquireCall[],
): (settings: Settings, workerHost: string, runKey: string) => Promise<AgentMcpEndpointLease> {
  return async (settings, workerHost, runKey) => {
    calls.push({ settings, workerHost, runKey });
    // The exact field the real acquireRemoteMcpEndpoint reads. A BoxPoolSettings
    // forwarded here leaves it undefined -> the real code path throws this error.
    const port = settings.server?.port;
    if (typeof port !== "number" || port <= 0) {
      throw new Error("remote_acp_mcp_requires_server_port");
    }
    return makeFakeEndpoint(port);
  };
}

// ---------------------------------------------------------------------------
// A minimal fake machine BoxPool: each acquire mints a fresh leased box on a real
// ssh-addressable host so the per-run manager opens (not the local-null path).
// ---------------------------------------------------------------------------

interface FakeLease extends BoxLease {
  readonly settles: Array<{ kind: "release" | "fail"; arg?: string }>;
}

function makeFakeLease(boxId: string, workerHost: string): FakeLease {
  const settles: Array<{ kind: "release" | "fail"; arg?: string }> = [];
  return {
    leaseId: `lease-${boxId}`,
    boxId,
    workerHost,
    acquiredAtMs: 0,
    expiresAtMs: null,
    settles,
    async release(outcome?: "healthy" | "poison"): Promise<void> {
      settles.push({ kind: "release", arg: outcome });
    },
    async fail(reason: string): Promise<void> {
      settles.push({ kind: "fail", arg: reason });
    },
    heartbeat(): void {},
  };
}

function makeFakeMachinePool(): BoxPool & { readonly leases: Map<string, FakeLease> } {
  const leases = new Map<string, FakeLease>();
  let nextBox = 0;
  return {
    leases,
    async acquire(): Promise<AcquireResult> {
      const boxId = `box-${nextBox++}`;
      const lease = makeFakeLease(boxId, `ssh://${boxId}`);
      leases.set(boxId, lease);
      return { status: "leased", lease };
    },
    canAcquire: () => true,
    isEnabled: () => true,
    reconcile(): void {},
    swapProvider(): void {},
    onMachineRecycling(): void {},
    async hydrate(): Promise<void> {},
    async drain(): Promise<void> {},
    snapshot(): BoxPoolSnapshot {
      return {
        enabled: true,
        provider: "fake",
        total: leases.size,
        warmIdle: 0,
        leased: leases.size,
        provisioning: 0,
        degraded: 0,
        inFlight: leases.size,
        spend: { concurrentBoxes: 0, boxSecondsUsed: 0, dailyBoxSecondsUsed: 0, dayKey: "" },
        boxes: [],
      };
    },
  };
}

// A FULL workflow Settings carrying a concrete server.port (the field the
// BoxPoolSettings does NOT have). parseConfig builds a real Settings; we set the
// port the remote endpoint acquire requires.
function fullSettingsWithServerPort(port = 51_873): Settings {
  const settings = parseConfig({
    tracker: { kind: "memory", active_states: ["Todo"], terminal_states: ["Done"] },
  }) as unknown as Settings;
  settings.server.host = "127.0.0.1";
  settings.server.port = port;
  return settings;
}

// The coordinator-owned BoxPoolSettings (no server.port). This is what the buggy
// coordinator forwarded to open() - the test below proves that path would FAIL.
function boxPoolOnlySettings(): BoxPoolSettings {
  return {
    enabled: true,
    provider: "fake",
  } as unknown as BoxPoolSettings;
}

const baseReq = { labels: [] as ReadonlyArray<string>, timeoutMs: 5_000 };

test("real per-run manager: the FULL Settings (with server.port) flows through acquireRunSlot.open and the endpoint opens", async () => {
  const calls: AcquireCall[] = [];
  const manager = createPerRunEndpointManager({ acquireForRun: makeStubAcquireForRun(calls) });
  const pool = makeFakeMachinePool();
  // The coordinator holds box-pool-only settings (no server.port) - exactly the
  // production wiring. The FULL Settings must arrive via the acquire request.
  const coordinator = createDispatchCoordinator({
    pool,
    mcpEndpointManager: manager,
    settings: boxPoolOnlySettings(),
  });

  const fullSettings = fullSettingsWithServerPort(51_873);
  const result = await coordinator.acquireRunSlot({
    ...baseReq,
    issueId: "issue-real",
    slotIndex: 0,
    settings: fullSettings,
  });

  // The endpoint opened: a real RunSlot bound with the per-run endpoint attached.
  assert.equal(result.status, "bound");
  if (result.status !== "bound") return;
  assert.ok(result.slot.mcpEndpoint);

  // The REAL per-run manager forwarded the FULL Settings to acquireForRun: the
  // server.port the remote endpoint needs is present (NOT undefined, as it would be
  // if the coordinator had threaded its BoxPoolSettings).
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.workerHost, "ssh://box-0");
  assert.equal(calls[0]?.runKey !== undefined, true);
  assert.equal(calls[0]?.settings.server.port, 51_873);
  assert.equal(calls[0]?.settings.server.host, "127.0.0.1");
});

test("real per-run manager: threading the box-pool-only settings WOULD fail at open (the original bug, caught here)", async () => {
  // This is the bug-detector: the box-pool-only settings (no server.port) flowed to
  // the SAME real per-run manager throw `remote_acp_mcp_requires_server_port` from
  // the stub acquirer - exactly as the production acquireAgentMcpEndpointForRun
  // does. So a coordinator that threaded its BoxPoolSettings would never open an
  // endpoint, and this assertion would have failed the buggy implementation.
  const calls: AcquireCall[] = [];
  const manager = createPerRunEndpointManager({ acquireForRun: makeStubAcquireForRun(calls) });

  let thrown: unknown;
  try {
    await manager.open({
      // The cast mirrors the OLD buggy coordinator forwarding BoxPoolSettings as
      // Settings; the real manager + stub acquirer reject the missing server.port.
      settings: boxPoolOnlySettings() as unknown as Settings,
      workerHost: "ssh://box-0",
      runKey: "issue-real#0",
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error);
  assert.equal((thrown as Error).message, "remote_acp_mcp_requires_server_port");
});

test("real per-run manager: a local/pending host mints nothing even with full Settings (acp keeps its own endpoint)", async () => {
  const calls: AcquireCall[] = [];
  const manager = createPerRunEndpointManager({ acquireForRun: makeStubAcquireForRun(calls) });

  const lease = await manager.open({
    settings: fullSettingsWithServerPort(),
    workerHost: "pending://issue/0",
    runKey: "issue/0",
  });

  // The local path returns null and never calls the acquirer (the byte-identical
  // single-tenant path), independent of the threaded Settings.
  assert.equal(lease, null);
  assert.equal(calls.length, 0);
});
