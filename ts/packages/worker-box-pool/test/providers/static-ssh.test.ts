import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, test } from "vitest";
import type { BoxPoolSettings } from "@symphony/domain";
import type { ClockPort, TimerHandle } from "@symphony/domain";
import type { SshRunOptions, SshRunResult } from "@symphony/ssh";
import { assert } from "@symphony/test-utils";

import { runProviderConformanceSuite } from "../../src/conformance.js";
import { createBoxPool } from "../../src/pool.js";
import { StaticSshBoxProvider } from "../../src/providers/static-ssh.js";
import { clearBoxProviderRegistry, registerBoxProvider } from "../../src/registry.js";
import { installEvalSsh, type EvalSshHandle } from "../../src/test-support/evalSsh.js";
import type { ProviderDeps, ProvisionRequest } from "../../src/types.js";

// A deterministic clock so `createdAtMs` is reproducible. The provider owns no
// timers (it delegates the probe timeout to `runSsh`), so set/clear are inert.
function fixedClock(initial: Date): ClockPort {
  return {
    now: () => initial,
    setTimeout: (): TimerHandle => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
}

function makeDeps(): ProviderDeps {
  return { clock: fixedClock(new Date("2026-05-29T10:00:00.000Z")), logEvent: () => undefined };
}

// A minimal BoxPoolSettings carrying providerOptions for the static-ssh kind.
// `sshTimeoutMs` is NOT part of BoxPoolSettings (it is WorkerSettings.sshTimeoutMs);
// the pool threads worker.sshTimeoutMs into probe(opts.timeoutMs) at call time.
function settingsWith(providerOptions: Record<string, unknown>): BoxPoolSettings {
  return {
    enabled: true,
    provider: "static-ssh",
    min: 0,
    max: 1,
    warm: 1,
    maxInFlight: 1,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 30_000,
    reapIntervalMs: 15_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
    providerOptions,
  };
}

const HOSTS = ["worker-a:2200", "worker-b:2200"] as const;

// ---------------------------------------------------------------------------
// Conformance suite over the eval-ssh transport (always-on, zero daemon).
// `boxIds` are the configured hosts because static-ssh is a fixed-inventory
// provider (min==max==len, idempotent provision keyed on the address). The
// unreachable variant points at an unroutable host so probe gates to ok:false.
// ---------------------------------------------------------------------------

let evalSsh: EvalSshHandle | undefined;
let prevSshConfig: string | undefined;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-static-ssh-"));
  evalSsh = await installEvalSsh(root);
  // The eval-ssh shim must run regardless of any ambient ssh config wiring.
  prevSshConfig = process.env.SYMPHONY_SSH_CONFIG;
  delete process.env.SYMPHONY_SSH_CONFIG;
});

afterEach(async () => {
  await evalSsh?.restore();
  evalSsh = undefined;
  if (prevSshConfig === undefined) delete process.env.SYMPHONY_SSH_CONFIG;
  else process.env.SYMPHONY_SSH_CONFIG = prevSshConfig;
});

runProviderConformanceSuite(
  () => new StaticSshBoxProvider(settingsWith({ ssh_hosts: [...HOSTS] }), makeDeps()),
  {
    suiteName: "StaticSshBoxProvider (eval-ssh)",
    boxIds: HOSTS,
    makeProvisionRequest: (boxId): ProvisionRequest => ({
      boxId,
      labels: ["symphony.box-pool"],
      timeoutMs: 30_000,
    }),
    makeUnreachable: () => {
      // An unroutable destination: `eval` of the printf will succeed locally, so
      // we instead point the provider at a host whose probe is forced to fail by
      // a synthetic transport that rejects. Use an injected runSsh that throws so
      // probe reports ok:false (mirroring a created-but-unreachable machine).
      const provider = new StaticSshBoxProvider(
        settingsWith({ ssh_hosts: ["unreachable-host:2200"] }),
        makeDeps(),
        {
          runSsh: async () => {
            throw new Error("ssh_timeout: unreachable-host:2200 5000");
          },
        },
      );
      return { provider, boxId: "unreachable-host:2200" };
    },
  },
);

// Both spellings configure the SAME fixed inventory: each configured address is
// provisionable (and lists once provisioned) and a non-configured address is
// rejected. `list()` is provisioned-minus-destroyed, so we provision the set to
// observe it (a fresh provider has nothing provisioned yet).
async function assertReadsBothHosts(provider: StaticSshBoxProvider): Promise<void> {
  for (const host of HOSTS) {
    await provider.provision({ boxId: host, labels: [], timeoutMs: 30_000 });
  }
  const listed = (await provider.list()).map((box) => box.boxId).sort();
  assert.deepEqual(listed, [...HOSTS].sort());
  await assert.rejects(
    () => provider.provision({ boxId: "not-configured:22", labels: [], timeoutMs: 30_000 }),
    /static_ssh_unknown_host/,
  );
}

test("reads ssh_hosts (snake_case) from providerOptions", async () => {
  await assertReadsBothHosts(
    new StaticSshBoxProvider(settingsWith({ ssh_hosts: [...HOSTS] }), makeDeps()),
  );
});

test("reads sshHosts (camelCase) from providerOptions", async () => {
  await assertReadsBothHosts(
    new StaticSshBoxProvider(settingsWith({ sshHosts: [...HOSTS] }), makeDeps()),
  );
});

test("provision hands out fixed addresses idempotently (min==max==len)", async () => {
  const provider = new StaticSshBoxProvider(settingsWith({ ssh_hosts: [...HOSTS] }), makeDeps());

  const first = await provider.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });
  const second = await provider.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });

  // The workerHost IS the configured address; idempotent on boxId.
  assert.equal(first.workerHost, HOSTS[0]);
  assert.equal(first.boxId, HOSTS[0]);
  assert.deepEqual(second, first);

  // Idempotent: a second provision of the same address does NOT duplicate it.
  const listed = (await provider.list()).map((box) => box.boxId);
  assert.deepEqual(
    listed.filter((id) => id === HOSTS[0]),
    [HOSTS[0]],
  );
});

test("provision assigns a synthetic boxId a free host; rejects only when inventory is exhausted", async () => {
  const provider = new StaticSshBoxProvider(settingsWith({ ssh_hosts: [...HOSTS] }), makeDeps());

  // The pool mints synthetic ids (NOT host strings). Each is assigned a free
  // configured host and served (the provider is NOT dead on arrival).
  const a = await provider.provision({ boxId: "box-0", labels: [], timeoutMs: 30_000 });
  const b = await provider.provision({ boxId: "box-1", labels: [], timeoutMs: 30_000 });
  assert.equal((HOSTS as readonly string[]).includes(a.workerHost), true);
  assert.equal((HOSTS as readonly string[]).includes(b.workerHost), true);
  // Two distinct synthetic ids land on two distinct configured hosts.
  assert.notEqual(a.workerHost, b.workerHost);
  // The boxId stays the pool's key (it is NOT rewritten to the host).
  assert.equal(a.boxId, "box-0");
  assert.equal(b.boxId, "box-1");

  // The fixed inventory (2 hosts) is now exhausted: a THIRD distinct synthetic id
  // has no free host and is rejected (the pool never invents hosts).
  await assert.rejects(
    () => provider.provision({ boxId: "box-2", labels: [], timeoutMs: 30_000 }),
    /static_ssh_unknown_host/,
  );
});

test("probe runs runSsh printf-ready with the opts.timeoutMs (worker.sshTimeoutMs source)", async () => {
  // Capture the exact command + timeout the provider hands to runSsh. The pool
  // threads worker.sshTimeoutMs into probe(opts.timeoutMs); the provider must
  // pass that through to runSsh verbatim.
  const calls: Array<{ host: string; command: string; options: SshRunOptions }> = [];
  const provider = new StaticSshBoxProvider(settingsWith({ ssh_hosts: [...HOSTS] }), makeDeps(), {
    runSsh: async (host, command, options = {}): Promise<SshRunResult> => {
      calls.push({ host, command, options });
      return { stdout: "ready\n", stderr: "", status: 0 };
    },
  });

  const box = await provider.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });

  const health = await provider.probe(box, { timeoutMs: 7_000 });
  assert.equal(health.ok, true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.host, HOSTS[0]);
  assert.equal(calls[0]?.command, "printf ready");
  assert.equal(calls[0]?.options.timeoutMs, 7_000);
});

test("probe over the eval-ssh transport reports the box healthy", async () => {
  const provider = new StaticSshBoxProvider(settingsWith({ ssh_hosts: [...HOSTS] }), makeDeps());
  const box = await provider.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });

  const health = await provider.probe(box, { timeoutMs: 5_000 });
  assert.equal(health.ok, true);

  // The probe sent exactly the readiness command over the eval-ssh transport and
  // NO workspace/hook command (the provider runs no hooks and creates no files).
  const trace = await evalSsh!.readTrace();
  assert.match(trace, /printf ready/);
  assert.notMatch(trace, /git init/);
  assert.notMatch(trace, /rm -rf/);
});

test("destroy forgets the host, runs NO hooks, and never deletes the machine", async () => {
  const provider = new StaticSshBoxProvider(settingsWith({ ssh_hosts: [...HOSTS] }), makeDeps());
  const box = await provider.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });

  await provider.destroy(box, { timeoutMs: 5_000, reason: "shrink" });
  // Idempotent: a second destroy of the same (already-forgotten) box is a no-op.
  await provider.destroy(box, { timeoutMs: 5_000, reason: "shrink" });

  // destroy merely FORGETS the host (the shared contract: list() reflects
  // provisioned-minus-destroyed), so the forgotten address drops out of list().
  const afterDestroy = (await provider.list()).map((entry) => entry.boxId);
  assert.equal(afterDestroy.includes(HOSTS[0]), false);

  // The machine is NEVER deleted: the configured address is still part of the
  // fixed inventory, so a re-provision re-hands the SAME address (it would have
  // thrown static_ssh_unknown_host if destroy had removed it from the host set).
  const reprovisioned = await provider.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });
  assert.equal(reprovisioned.workerHost, HOSTS[0]);
  assert.equal(
    (await provider.list()).some((entry) => entry.boxId === HOSTS[0]),
    true,
  );

  // destroy ran ZERO ssh commands (it just forgets the host locally): no hooks,
  // no remote teardown, no machine deletion was ever attempted over SSH.
  const trace = await evalSsh!.readTrace();
  assert.notMatch(trace, /rm -rf/);
  assert.notMatch(trace, /shutdown/);
  assert.notMatch(trace, /poweroff/);
});

test("capabilities are { sshAddressable:true, ephemeral:false, usesLedger:false }", () => {
  const provider = new StaticSshBoxProvider(settingsWith({ ssh_hosts: [...HOSTS] }), makeDeps());
  assert.deepEqual(provider.capabilities, {
    sshAddressable: true,
    ephemeral: false,
    usesLedger: false,
  });
  assert.equal(provider.kind, "static-ssh");
});

test("serves a pool lease: the pool mints synthetic box-N ids, not host strings", async () => {
  // The REAL pool mints `box-0`, `box-1`, ... idempotency keys (NOT host
  // strings). The static-ssh provider must assign one of its configured hosts to
  // each synthetic boxId and return it as the workerHost, or the provider is dead
  // on arrival (every acquire fails `static_ssh_unknown_host`).
  clearBoxProviderRegistry();
  registerBoxProvider(
    "static-ssh",
    (settings, deps) =>
      new StaticSshBoxProvider(settings, deps, {
        runSsh: async (): Promise<SshRunResult> => ({ stdout: "ready\n", stderr: "", status: 0 }),
      }),
  );
  try {
    const pool = createBoxPool(
      {
        enabled: true,
        provider: "static-ssh",
        min: 0,
        max: 2,
        warm: 0,
        maxInFlight: 1,
        ttlMs: 3_600_000,
        idleReapMs: 300_000,
        acquireTimeoutMs: 1_000,
        reapIntervalMs: 15_000,
        staleHeartbeatMs: 600_000,
        drainDeadlineMs: 30_000,
        providerOptions: { ssh_hosts: [...HOSTS] },
      },
      {
        // Real-timer clock so the pool's waiter/drain timers actually fire (the
        // fixedClock helper returns inert timers, which a live pool would hang on).
        clock: {
          now: () => new Date("2026-05-29T10:00:00.000Z"),
          setTimeout: (cb, ms): TimerHandle => setTimeout(cb, ms),
          clearTimeout: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
        },
        logEvent: () => undefined,
      },
    );

    const result = await pool.acquire({
      issueId: "issue-1",
      slotIndex: 0,
      labels: [],
      timeoutMs: 1_000,
    });

    // The acquire must lease a configured host (not fail with no_capacity).
    assert.equal(result.status, "leased");
    if (result.status === "leased") {
      assert.equal((HOSTS as readonly string[]).includes(result.lease.workerHost), true);
      await result.lease.release("healthy");
    }
    await pool.drain({ deadlineMs: 1_000 });
  } finally {
    clearBoxProviderRegistry();
  }
});

test("throws when neither ssh_hosts nor sshHosts is a non-empty string array", () => {
  assert.throws(
    () => new StaticSshBoxProvider(settingsWith({}), makeDeps()),
    /static_ssh_hosts_required/,
  );
  assert.throws(
    () => new StaticSshBoxProvider(settingsWith({ ssh_hosts: [] }), makeDeps()),
    /static_ssh_hosts_required/,
  );
  assert.throws(
    () => new StaticSshBoxProvider(settingsWith({ sshHosts: [123] }), makeDeps()),
    /static_ssh_hosts_required/,
  );
});
