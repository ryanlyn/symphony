import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseConfig } from "@symphony/config";
import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { BoardStore, LocalTrackerClient } from "@symphony/local-tracker";

test("LocalTrackerClient reads candidates by active states from the board dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "board-client-"));
  await mkdir(dir, { recursive: true });
  const store = new BoardStore(dir);
  await store.create({ title: "Active", status: "Todo" });
  await store.create({ title: "Done", status: "Done" });

  const settings = parseConfig(
    { tracker: { kind: "local", path: dir, active_states: ["Todo"], terminal_states: ["Done"] } },
    {},
  );
  const client = new LocalTrackerClient(settings);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((i) => i.identifier),
    ["BOARD-1"],
  );
  assert.deepEqual(
    (await client.fetchIssuesByStates(["Done"])).map((i) => i.identifier),
    ["BOARD-2"],
  );
  assert.deepEqual(
    (await client.fetchIssuesByIds(["BOARD-2"])).map((i) => i.title),
    ["Done"],
  );
});
