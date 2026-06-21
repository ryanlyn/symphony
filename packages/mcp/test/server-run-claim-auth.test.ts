import { parseConfig as parseWorkflowConfig } from "@lorenz/config";
import type { Settings } from "@lorenz/domain";
import { registerLinearTracker } from "@lorenz/linear-tracker";
import { ToolRegistry } from "@lorenz/tool-sdk";
import { createTrackerToolProvider, TrackerRegistry } from "@lorenz/tracker-sdk";
import { Hono } from "hono";
import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  createMcpAuthScope,
  issueMcpToken,
  issueRunMcpToken,
  mountMcp,
  revokeMcpToken,
  revokeRunClaim,
  type RunClaim,
} from "@lorenz/mcp";

// Private registries so the mount is exercised without mutating process defaults.
const trackers = new TrackerRegistry();
const tools = new ToolRegistry();
registerLinearTracker({ trackers, tools });
tools.register(createTrackerToolProvider(trackers));

function linearSettings(): Settings {
  return parseWorkflowConfig(
    { tracker: { kind: "linear", api_key: "linear-token", project_slug: "mono" } },
    {},
    {},
    trackers,
  );
}

const baseClaim = (overrides: Partial<RunClaim> = {}): RunClaim => ({
  runKey: "run-1",
  workerHost: "host-a",
  issueId: "ISSUE-1",
  generation: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  settingsScope: "mcp:scope-a",
  ...overrides,
});

function mountWith(
  options: Parameters<typeof mountMcp>[2],
): { app: Hono; authScope: string } {
  const app = new Hono();
  const authScope = createMcpAuthScope();
  mountMcp(app, linearSettings(), { authScope, tools, ...options });
  return { app, authScope };
}

async function toolsListStatus(app: Hono, token: string): Promise<number> {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return response.status;
}

async function toolsCall(app: Hono, token: string, name: string): Promise<number> {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  return response.status;
}

test("Token B: a resolved, live, allowed claim authorizes the request", async () => {
  const { app } = mountWith({ isRunLive: () => true });
  const token = issueRunMcpToken(baseClaim({ allowedTools: ["tracker_query"] }));
  try {
    assert.equal(await toolsCall(app, token, "tracker_query"), 200);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: a non-tool request (tools/list) is gated by the claim, not the allowlist", async () => {
  const { app } = mountWith({ isRunLive: () => true });
  const token = issueRunMcpToken(baseClaim({ allowedTools: ["tracker_query"] }));
  try {
    assert.equal(await toolsListStatus(app, token), 200);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: a disallowed tool/call is denied 401", async () => {
  const { app } = mountWith({ isRunLive: () => true });
  const token = issueRunMcpToken(baseClaim({ allowedTools: ["tracker_query"] }));
  try {
    assert.equal(await toolsCall(app, token, "tracker_update_status"), 401);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: an expired claim is denied 401 even for a live, allowed tool", async () => {
  const { app } = mountWith({ isRunLive: () => true });
  const token = issueRunMcpToken(baseClaim({ expiresAt: 1_000, allowedTools: ["tracker_query"] }));
  try {
    assert.equal(await toolsCall(app, token, "tracker_query"), 401);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: a non-live run is denied 401", async () => {
  const { app } = mountWith({ isRunLive: () => false });
  const token = issueRunMcpToken(baseClaim());
  try {
    assert.equal(await toolsListStatus(app, token), 401);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: a stale generation is denied 401 via the injected liveness fence", async () => {
  // The injected oracle accepts only the current generation (2); the claim is stale (1).
  const { app } = mountWith({ isRunLive: (_run, _host, generation) => generation === 2 });
  const token = issueRunMcpToken(baseClaim({ generation: 1 }));
  try {
    assert.equal(await toolsListStatus(app, token), 401);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: the injected oracle receives runKey, workerHost, and generation from the claim", async () => {
  let seen: [string, string, number] | null = null;
  const { app } = mountWith({
    isRunLive: (runKey, workerHost, generation) => {
      seen = [runKey, workerHost, generation];
      return true;
    },
  });
  const token = issueRunMcpToken(baseClaim({ runKey: "run-9", workerHost: "host-z", generation: 7 }));
  try {
    await toolsListStatus(app, token);
    assert.deepEqual(seen, ["run-9", "host-z", 7]);
  } finally {
    revokeRunClaim(token);
  }
});

test("Legacy back-compat: a valid settings-wide token (Token A) still authorizes", async () => {
  const { app, authScope } = mountWith({ isRunLive: () => true });
  const token = issueMcpToken(authScope);
  try {
    assert.equal(await toolsListStatus(app, token), 200);
  } finally {
    revokeMcpToken(token);
  }
});

test("Legacy back-compat: an unknown bearer (neither Token B nor Token A) is denied 401", async () => {
  const { app } = mountWith({ isRunLive: () => true });
  assert.equal(await toolsListStatus(app, "not-a-real-token"), 401);
});

test("A Token A token is NOT silently treated as a per-run claim", async () => {
  // A settings-wide token must take the legacy path, not resolveRunClaim. With a
  // never-live oracle, a Token A request still succeeds because it never reaches
  // the per-run re-check.
  const { app, authScope } = mountWith({ isRunLive: () => false });
  const token = issueMcpToken(authScope);
  try {
    assert.equal(await toolsListStatus(app, token), 200);
  } finally {
    revokeMcpToken(token);
  }
});
