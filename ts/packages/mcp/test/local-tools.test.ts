import { access, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseConfig } from "@symphony/config";
import { BoardStore } from "@symphony/local-tracker";
import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { executeTool, toolSpecs } from "@symphony/mcp";

async function localSettings() {
  const dir = await mkdtemp(path.join(tmpdir(), "board-tools-"));
  await mkdir(dir, { recursive: true });
  return { dir, settings: parseConfig({ tracker: { kind: "local", path: dir } }, {}) };
}

test("local toolSpecs lists the board read and write tools", async () => {
  const { settings } = await localSettings();
  assert.deepEqual(
    toolSpecs(settings).map((t) => t.name),
    ["local_update_status", "local_comment", "local_create_issue", "local_read_issue"],
  );
});

test("local tools create, update status, and comment on the board", async () => {
  const { dir, settings } = await localSettings();

  const created = await executeTool(
    "local_create_issue",
    { title: "Fix it", status: "Todo" },
    settings,
  );
  assert.equal(created.success, true);

  const moved = await executeTool(
    "local_update_status",
    { issueId: "BOARD-1", status: "In Progress" },
    settings,
  );
  assert.equal(moved.success, true);

  const commented = await executeTool(
    "local_comment",
    { issueId: "BOARD-1", body: "opened PR" },
    settings,
  );
  assert.equal(commented.success, true);

  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /status: In Progress/);
  assert.match(file, /agent: opened PR/);
});

test("local_create_issue persists the body so it round-trips as the issue description", async () => {
  const { dir, settings } = await localSettings();
  const body = "Steps to reproduce:\n1. open the app\n2. it crashes";

  const created = await executeTool("local_create_issue", { title: "Crash", body }, settings);
  assert.equal(created.success, true);
  // The tool's own returned issue carries the body through as the description.
  assert.equal((created.result as { issue: { description: string } }).issue.description, body);

  // And it is actually persisted: a fresh BoardStore reading the same dir (the path the daemon
  // polls) sees the body as the description, proving the write reaches disk, not just the response.
  const reread = await new BoardStore(dir).getByIds(["BOARD-1"]);
  assert.equal(reread.length, 1);
  assert.equal(reread[0]!.description, body);
});

test("local_read_issue reads back the status, title, description, and both comments", async () => {
  const { settings } = await localSettings();

  const created = await executeTool(
    "local_create_issue",
    { title: "Read it", body: "the details", status: "Todo" },
    settings,
  );
  assert.equal(created.success, true);

  await executeTool("local_update_status", { issueId: "BOARD-1", status: "In Progress" }, settings);
  await executeTool("local_comment", { issueId: "BOARD-1", body: "opened PR" }, settings);
  await executeTool("local_comment", { issueId: "BOARD-1", body: "checks green" }, settings);

  const read = await executeTool("local_read_issue", { issueId: "BOARD-1" }, settings);
  assert.equal(read.success, true);
  const result = read.result as {
    issue: { id: string; status: string; title: string; description: string };
    comments: string[];
  };
  assert.equal(result.issue.id, "BOARD-1");
  assert.equal(result.issue.status, "In Progress");
  assert.equal(result.issue.title, "Read it");
  assert.equal(result.issue.description, "the details");
  assert.equal(result.comments.length, 2);
  assert.match(result.comments[0]!, /agent: opened PR/);
  assert.match(result.comments[1]!, /agent: checks green/);
});

test("local_read_issue fails for a missing or invalid id", async () => {
  const { settings } = await localSettings();
  const missing = await executeTool("local_read_issue", { issueId: "BOARD-404" }, settings);
  assert.equal(missing.success, false);
  const invalid = await executeTool("local_read_issue", { issueId: "nope" }, settings);
  assert.equal(invalid.success, false);
});

test("local tools reject unknown names", async () => {
  const { settings } = await localSettings();
  const result = await executeTool("local_bogus", {}, settings);
  assert.equal(result.success, false);
});

test("local_create_issue writes under HOME for a ~ path, not a literal ~ under cwd", async () => {
  // Regression: the write path (MCP tools) must expand "~" the same way the read path
  // (LocalTrackerClient, which the daemon polls) does. Before the shared resolver the
  // tool wrote a literal "<cwd>/~/board" segment, so agent writes never reached the
  // polled HOME/board and the run loop re-dispatched forever.
  const home = await mkdtemp(path.join(tmpdir(), "board-mcp-home-"));
  const settings = parseConfig({ tracker: { kind: "local", path: "~/board" } }, {});

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const created = await executeTool("local_create_issue", { title: "FromTilde" }, settings);
    assert.equal(created.success, true);

    // The issue file lands under the expanded HOME/board directory.
    await access(path.join(home, "board", "BOARD-1.md"));

    // And NOT under a literal "~" segment relative to cwd.
    let literalExists = true;
    try {
      await access(path.join(process.cwd(), "~", "board", "BOARD-1.md"));
    } catch {
      literalExists = false;
    }
    assert.equal(literalExists, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
