import path from "node:path";

import { test } from "vitest";
import { parseConfig } from "@lorenz/config";
import { assert, tempDir } from "@lorenz/test-utils";
import type { WorkflowDefinition } from "@lorenz/domain";

import { buildClaimStoreHandle, defaultClaimStorePath } from "../src/claimStore.js";

test("claim store builder keeps memory as the default backend", async () => {
  const workflow = workflowFixture(await tempDir("lorenz-claim-store-memory"));
  const handle = await buildClaimStoreHandle(
    workflow,
    { backend: null, path: null, ownerStaleMs: null },
    {},
  );

  assert.equal(handle.backend, "memory");
  assert.equal(handle.path, null);
  assert.equal(handle.claimStore, undefined);
  await handle.close();
});

test("claim store builder opens an explicit SQLite backend", async () => {
  const root = await tempDir("lorenz-claim-store-sqlite");
  const workflow = workflowFixture(root);
  const dbPath = path.join(root, "claims.db");
  const handle = await buildClaimStoreHandle(
    workflow,
    { backend: "sqlite", path: dbPath, ownerStaleMs: 60_000 },
    {},
  );

  try {
    assert.equal(handle.backend, "sqlite");
    assert.equal(handle.path, dbPath);
    assert.equal(handle.claimStore?.kind, "sqlite");
    assert.deepEqual(handle.claimStore?.capabilities, {
      crashRecovery: true,
      sharedAcrossProcesses: true,
      retryDurability: true,
    });
  } finally {
    await handle.close();
  }
});

test("claim store builder reads explicit backend settings from env", async () => {
  const root = await tempDir("lorenz-claim-store-env");
  const workflow = workflowFixture(root);
  const handle = await buildClaimStoreHandle(
    workflow,
    { backend: null, path: null, ownerStaleMs: null },
    {
      LORENZ_CLAIM_STORE: "sqlite",
      LORENZ_CLAIM_STORE_PATH: path.join(root, "env-claims.db"),
      LORENZ_CLAIM_STORE_OWNER_STALE_MS: "120000",
    },
  );

  try {
    assert.equal(handle.backend, "sqlite");
    assert.equal(handle.path, path.join(root, "env-claims.db"));
    assert.equal(handle.claimStore?.kind, "sqlite");
  } finally {
    await handle.close();
  }
});

test("claim store default path is anchored under the workflow workspace", async () => {
  const root = await tempDir("lorenz-claim-store-default-path");
  const workflow = workflowFixture(root);

  assert.equal(defaultClaimStorePath(workflow), path.join(root, ".lorenz/claim-store/claims.db"));
});

function workflowFixture(root: string): WorkflowDefinition {
  return {
    path: path.join(root, "WORKFLOW.md"),
    config: {},
    content: "",
    settings: parseConfig({
      tracker: { kind: "memory" },
      workspace: { root },
      logging: { log_file: path.join(root, "lorenz.log") },
    }),
  };
}
