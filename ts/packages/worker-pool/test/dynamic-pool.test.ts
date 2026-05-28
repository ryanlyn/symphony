import { test, expect } from "vitest";
import type { ClockPort, TimerHandle } from "@symphony/ports";
import type { Settings, WorkerPoolSettings } from "@symphony/domain";

import { FakeProvider } from "./fake-provider.js";

import { WorkerPool, type WorkerPoolEvent } from "@symphony/worker-pool";


function makeSettings(pool: Partial<WorkerPoolSettings> = {}): Settings {
  return {
    worker: {
      sshHosts: [],
      sshTimeoutMs: 60_000,
      pool: { provider: "sandbox", maxPoolSize: 4, warmPoolSize: 0, ...pool },
    },
    agent: { maxConcurrentAgents: 10 },
  } as unknown as Settings;
}

class FakeClock implements ClockPort {
  current = new Date(2026, 0, 1).getTime();
  now(): Date {
    return new Date(this.current);
  }
  setTimeout(_callback: () => void, _delayMs: number): TimerHandle {
    return {};
  }
  clearTimeout(): void {}
  advance(ms: number): void {
    this.current += ms;
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

test("sandbox reserve returns null and kicks background provisioning", async () => {
  const provider = new FakeProvider();
  const events: WorkerPoolEvent[] = [];
  const pool = new WorkerPool({
    settings: () => makeSettings(),
    providers: { sandbox: provider },
    onEvent: (event) => events.push(event),
  });

  expect(pool.reserve("issue:0")).toBeNull();
  await settle();

  expect(provider.provisionCount).toBe(1);
  const lease = pool.reserve("issue:0");
  expect(lease?.handle.providerKind).toBe("sandbox");
  expect(lease?.handle.target.workerHost).toContain("fake@");
  expect(events.map((event) => event.type)).toContain("worker_provisioned");
  expect(events.map((event) => event.type)).toContain("worker_acquired");
});

test("warm reuse: release of a healthy lease keeps it ready when under warm size", async () => {
  const provider = new FakeProvider();
  const pool = new WorkerPool({
    settings: () => makeSettings({ warmPoolSize: 2 }),
    providers: { sandbox: provider },
  });

  // Provision via the reserve-miss path.
  pool.reserve("issue:0");
  await settle();
  const lease = pool.reserve("issue:0");
  expect(lease).not.toBeNull();

  await pool.release(lease!.handle.id);
  expect(provider.releaseCount).toBe(0); // warm reuse — provider not called
  expect(pool.snapshot().ready).toBe(1);

  const reused = pool.reserve("issue:1");
  expect(reused?.handle.id).toBe(lease!.handle.id);
});

test("release with recycle destroys even when warm pool has room", async () => {
  const provider = new FakeProvider();
  const pool = new WorkerPool({
    settings: () => makeSettings({ warmPoolSize: 2 }),
    providers: { sandbox: provider },
  });
  pool.reserve("issue:0");
  await settle();
  const lease = pool.reserve("issue:0");
  await pool.release(lease!.handle.id, { recycle: true });

  expect(provider.releaseCount).toBe(1);
  expect(provider.recycleCount).toBe(1);
  expect(pool.snapshot().ready).toBe(0);
});

test("maintain refills warm pool up to warmPoolSize", async () => {
  const provider = new FakeProvider();
  const pool = new WorkerPool({
    settings: () => makeSettings({ warmPoolSize: 3, maxPoolSize: 5 }),
    providers: { sandbox: provider },
  });
  await pool.maintain();
  await settle();

  expect(provider.provisionCount).toBe(3);
  expect(pool.snapshot().ready).toBe(3);
});

test("TTL reap drops ready leases and defers assigned leases until release", async () => {
  const clock = new FakeClock();
  const provider = new FakeProvider(clock);
  provider.ttlMs = 100;
  const pool = new WorkerPool({
    settings: () => makeSettings({ warmPoolSize: 1, ttlMs: 100 }),
    providers: { sandbox: provider },
    clock,
  });
  await pool.maintain();
  await settle();
  expect(pool.snapshot().ready).toBe(1);

  // Assign the warm lease.
  const lease = pool.reserve("issue:0");
  expect(lease).not.toBeNull();

  clock.advance(500);
  await pool.maintain();

  // Assigned lease survives but is flagged; release destroys it instead of warming.
  expect(provider.releaseCount).toBe(0);
  await pool.release(lease!.handle.id);
  expect(provider.recycleCount).toBe(1);
});

test("health recycle: maintain reprobes ready leases past healthRecheckMs", async () => {
  const clock = new FakeClock();
  const provider = new FakeProvider(clock);
  const pool = new WorkerPool({
    settings: () => makeSettings({ warmPoolSize: 1, healthRecheckMs: 100 }),
    providers: { sandbox: provider },
    clock,
  });
  await pool.maintain();
  await settle();
  const ready = pool.snapshot().byKind.sandbox?.ready ?? 0;
  expect(ready).toBe(1);

  // Mark the next health probe as failing.
  for (const [ref] of provider.health) provider.health.set(ref, false);
  // Force a fresh ref to fail by populating from the lease handle:
  // (the snapshot doesn't expose handles, so set globally:)
  provider.health.set("fake-1", false);
  clock.advance(500);
  await pool.maintain();
  await settle();

  expect(provider.recycleCount).toBeGreaterThanOrEqual(1);
});

test("ready() probes health for dynamic leases", async () => {
  const provider = new FakeProvider();
  const pool = new WorkerPool({
    settings: () => makeSettings(),
    providers: { sandbox: provider },
  });
  pool.reserve("a:0");
  await settle();
  const lease = pool.reserve("a:0");
  provider.health.set(lease!.handle.providerRef ?? "", false);

  expect(await pool.ready(lease!.handle.id)).toBe(false);
  expect(provider.healthCheckCount).toBeGreaterThan(0);
});

test("stop destroys all leases", async () => {
  const provider = new FakeProvider();
  const pool = new WorkerPool({
    settings: () => makeSettings({ warmPoolSize: 2 }),
    providers: { sandbox: provider },
  });
  await pool.maintain();
  await settle();
  await pool.stop();

  expect(provider.releaseCount).toBe(2);
  expect(pool.snapshot().total).toBe(0);
});
