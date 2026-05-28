import { promises as fs } from "node:fs";
import path from "node:path";

import { test } from "vitest";

import { assert } from "../../../test/assert.js";
import { tempDir } from "../../../test/helpers.js";

import { FileHostAssignmentStore } from "@symphony/runtime";

test("FileHostAssignmentStore returns null for unknown issues when the file is missing", async () => {
  const dir = await tempDir("symphony-host-assignments-missing");
  const store = await FileHostAssignmentStore.load({
    filePath: path.join(dir, "host_assignments.json"),
  });
  assert.equal(store.get("nonexistent"), null);
});

test("FileHostAssignmentStore persists set/delete and reloads on restart", async () => {
  const dir = await tempDir("symphony-host-assignments-persist");
  const filePath = path.join(dir, "nested", "host_assignments.json");

  const first = await FileHostAssignmentStore.load({ filePath });
  first.set("MT-1", { workerHost: "worker-a", identifier: "MT-1" });
  first.set("MT-2", { workerHost: "worker-b", identifier: "MT-2" });
  first.delete("MT-2");
  await first.flush();

  const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  assert.ok(raw["MT-1"]);
  assert.equal((raw["MT-1"] as { workerHost: string }).workerHost, "worker-a");
  assert.equal(raw["MT-2"], undefined);

  const reloaded = await FileHostAssignmentStore.load({ filePath });
  assert.equal(reloaded.get("MT-1"), "worker-a");
  assert.equal(reloaded.get("MT-2"), null);
});

test("FileHostAssignmentStore skips redundant writes when host and identifier are unchanged", async () => {
  const dir = await tempDir("symphony-host-assignments-redundant");
  const filePath = path.join(dir, "host_assignments.json");
  const store = await FileHostAssignmentStore.load({ filePath });

  store.set("MT-1", { workerHost: "worker-a", identifier: "MT-1" });
  await store.flush();
  const firstMtime = (await fs.stat(filePath)).mtimeMs;

  store.set("MT-1", { workerHost: "worker-a", identifier: "MT-1" });
  await store.flush();
  const secondMtime = (await fs.stat(filePath)).mtimeMs;

  assert.equal(secondMtime, firstMtime);
});
