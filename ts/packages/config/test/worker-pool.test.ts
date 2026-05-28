import { test } from "vitest";
import { parseConfig } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

test("worker.pool defaults to absent when not configured", () => {
  const settings = parseConfig({});
  assert.equal(settings.worker.pool, undefined);
});

test("worker.pool: snake_case keys are normalized and provider enum is enforced", () => {
  const settings = parseConfig({
    worker: {
      pool: {
        provider: "sandbox",
        max_pool_size: 8,
        warm_pool_size: 2,
        ttl_ms: 60_000,
        health_recheck_ms: 5_000,
        sandbox: { kind: "e2b", template: "node-22", timeout_ms: 30_000 },
      },
    },
  });
  assert.equal(settings.worker.pool?.provider, "sandbox");
  assert.equal(settings.worker.pool?.maxPoolSize, 8);
  assert.equal(settings.worker.pool?.warmPoolSize, 2);
  assert.equal(settings.worker.pool?.ttlMs, 60_000);
  assert.equal(settings.worker.pool?.healthRecheckMs, 5_000);
  assert.equal(settings.worker.pool?.sandbox?.kind, "e2b");
  assert.equal(settings.worker.pool?.sandbox?.template, "node-22");
  assert.equal(settings.worker.pool?.sandbox?.timeoutMs, 30_000);
});

test("worker.pool: invalid provider rejected", () => {
  assert.throws(
    () => parseConfig({ worker: { pool: { provider: "nope" } } }),
    /provider/,
  );
});

test("worker.pool: broker requires endpoint", () => {
  assert.throws(
    () => parseConfig({ worker: { pool: { provider: "broker", broker: {} } } }),
    /endpoint/,
  );
});

test("worker.pool: broker block accepted", () => {
  const settings = parseConfig({
    worker: {
      pool: {
        provider: "broker",
        broker: { endpoint: "https://broker.example.com", apiKey: "tok" },
      },
    },
  });
  assert.equal(settings.worker.pool?.provider, "broker");
  assert.equal(settings.worker.pool?.broker?.endpoint, "https://broker.example.com");
  assert.equal(settings.worker.pool?.broker?.apiKey, "tok");
});
