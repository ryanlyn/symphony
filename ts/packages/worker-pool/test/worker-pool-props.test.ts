import { test } from "vitest";
import fc from "fast-check";
import type { Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { WorkerPool } from "@symphony/worker-pool";


function makeSettings(sshHosts: string[], cap: number): Settings {
  return {
    worker: { sshHosts, sshTimeoutMs: 60_000, maxConcurrentAgentsPerHost: cap },
    agent: { maxConcurrentAgents: 100 },
  } as unknown as Settings;
}

test("ssh pool never exceeds hosts * cap leases and never over-fills a host", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 5 }),
      fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: 1, max: 40 }),
      (rawHosts, cap, attempts) => {
        const hosts = [...new Set(rawHosts)];
        const pool = new WorkerPool({ settings: () => makeSettings(hosts, cap) });
        const perHost = new Map<string, number>();

        for (let i = 0; i < attempts; i += 1) {
          const lease = pool.reserve(`issue-${i}:0`);
          if (lease === null) {
            // Refusal only happens when every host is saturated.
            assert.ok(hosts.every((host) => (perHost.get(host) ?? 0) >= cap));
            continue;
          }
          const host = lease.handle.target.workerHost;
          assert.ok(typeof host === "string" && hosts.includes(host));
          const next = (perHost.get(host!) ?? 0) + 1;
          assert.ok(next <= cap);
          perHost.set(host!, next);
        }

        assert.ok(pool.leaseCount() <= hosts.length * cap);
      },
    ),
  );
});
