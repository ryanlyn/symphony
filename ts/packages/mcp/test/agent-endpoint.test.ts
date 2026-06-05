import { parseConfig } from "@symphony/config";
import { test, vi } from "vitest";

import { assert } from "../../../test/assert.js";

import { acquireAgentMcpEndpoint } from "@symphony/mcp";

test("local MCP endpoint reports a connectable URL when configured server binds wildcard", async () => {
  const settings = parseConfig({
    tracker: { kind: "linear", project_slug: "mono" },
    server: { host: "0.0.0.0", port: 43210 },
  });
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("", { status: 405 }));

  try {
    const lease = await acquireAgentMcpEndpoint(settings);
    try {
      assert.equal(lease.url, "http://127.0.0.1:43210/claude-mcp");
    } finally {
      await lease.release();
    }
  } finally {
    fetchSpy.mockRestore();
  }
});
