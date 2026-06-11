import { test } from "vitest";
import { BoxDriverRegistry } from "@symphony/box-sdk";
import type { DriverDeps, ProvisionRequest, SshRunOptions, SshRunResult } from "@symphony/box-sdk";
import { runDriverConformanceSuite } from "@symphony/box-sdk/conformance";
import { assert } from "@symphony/test-utils";

import {
  StaticSshBoxDriver,
  registerStaticSshBoxDriver,
  staticSshBoxDriverFactory,
} from "../src/index.js";

// A deterministic clock so `createdAtMs` is reproducible. The driver owns no
// timers (it delegates the probe timeout to `runSsh`), so set/clear are inert.
function fixedClock(initial: Date): DriverDeps["clock"] {
  return {
    now: () => initial,
    setTimeout: () => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
}

// A recording SSH transport injected through DriverDeps. The pool injects the
// real engine runner in production; tests observe the exact argv/timeout here.
interface SshCall {
  host: string;
  command: string;
  options: SshRunOptions;
}

function recordingSsh(result: SshRunResult = { stdout: "ready\n", stderr: "", status: 0 }): {
  calls: SshCall[];
  runSsh: DriverDeps["runSsh"];
} {
  const calls: SshCall[] = [];
  return {
    calls,
    runSsh: async (host, command, options = {}) => {
      calls.push({ host, command, options });
      return Promise.resolve(result);
    },
  };
}

function makeDeps(runSsh?: DriverDeps["runSsh"]): DriverDeps {
  return {
    clock: fixedClock(new Date("2026-05-29T10:00:00.000Z")),
    logEvent: () => undefined,
    runSsh: runSsh ?? recordingSsh().runSsh,
  };
}

const HOSTS = ["worker-a:2200", "worker-b:2200"] as const;

// ---------------------------------------------------------------------------
// Conformance suite over a fake SSH transport (always-on, zero network).
// `boxIds` are the configured hosts because static-ssh is a fixed-inventory
// driver (min==max==len, idempotent provision keyed on the address). The
// unreachable variant injects a rejecting runSsh so probe gates to ok:false.
// ---------------------------------------------------------------------------

runDriverConformanceSuite(() => new StaticSshBoxDriver({ ssh_hosts: [...HOSTS] }, makeDeps()), {
  suiteName: "StaticSshBoxDriver (fake ssh)",
  boxIds: HOSTS,
  makeProvisionRequest: (boxId): ProvisionRequest => ({
    boxId,
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  }),
  makeUnreachable: () => {
    // A created-but-unreachable machine: the injected runSsh rejects, so probe
    // must report ok:false (mirroring an unroutable configured host).
    const driver = new StaticSshBoxDriver(
      { ssh_hosts: ["unreachable-host:2200"] },
      makeDeps(async () => {
        throw new Error("ssh_timeout: unreachable-host:2200 5000");
      }),
    );
    return { driver, boxId: "unreachable-host:2200" };
  },
});

// Both spellings configure the SAME fixed inventory: each configured address is
// provisionable (and lists once provisioned) and a non-configured address is
// rejected. `list()` is provisioned-minus-destroyed, so we provision the set to
// observe it (a fresh driver has nothing provisioned yet).
async function assertReadsBothHosts(driver: StaticSshBoxDriver): Promise<void> {
  for (const host of HOSTS) {
    await driver.provision({ boxId: host, labels: [], timeoutMs: 30_000 });
  }
  const listed = (await driver.list()).map((box) => box.boxId).sort();
  assert.deepEqual(listed, [...HOSTS].sort());
  await assert.rejects(
    () => driver.provision({ boxId: "not-configured:22", labels: [], timeoutMs: 30_000 }),
    /static_ssh_unknown_host/,
  );
}

test("reads ssh_hosts (snake_case) from the driver options", async () => {
  await assertReadsBothHosts(new StaticSshBoxDriver({ ssh_hosts: [...HOSTS] }, makeDeps()));
});

test("reads sshHosts (camelCase) from the driver options", async () => {
  await assertReadsBothHosts(new StaticSshBoxDriver({ sshHosts: [...HOSTS] }, makeDeps()));
});

test("provision hands out fixed addresses idempotently (min==max==len)", async () => {
  const driver = new StaticSshBoxDriver({ ssh_hosts: [...HOSTS] }, makeDeps());

  const first = await driver.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });
  const second = await driver.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });

  // The workerHost IS the configured address; idempotent on boxId.
  assert.equal(first.workerHost, HOSTS[0]);
  assert.equal(first.boxId, HOSTS[0]);
  assert.deepEqual(second, first);

  // Idempotent: a second provision of the same address does NOT duplicate it.
  const listed = (await driver.list()).map((box) => box.boxId);
  assert.deepEqual(
    listed.filter((id) => id === HOSTS[0]),
    [HOSTS[0]],
  );
});

test("provision assigns a synthetic boxId a free host; rejects only when inventory is exhausted", async () => {
  const driver = new StaticSshBoxDriver({ ssh_hosts: [...HOSTS] }, makeDeps());

  // The pool mints synthetic ids (NOT host strings). Each is assigned a free
  // configured host and served (the driver is NOT dead on arrival).
  const a = await driver.provision({ boxId: "box-0", labels: [], timeoutMs: 30_000 });
  const b = await driver.provision({ boxId: "box-1", labels: [], timeoutMs: 30_000 });
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
    () => driver.provision({ boxId: "box-2", labels: [], timeoutMs: 30_000 }),
    /static_ssh_unknown_host/,
  );
});

test("probe runs deps.runSsh printf-ready with the opts.timeoutMs (worker.sshTimeoutMs source)", async () => {
  // Capture the exact command + timeout the driver hands to deps.runSsh. The pool
  // threads worker.sshTimeoutMs into probe(opts.timeoutMs); the driver must
  // pass that through to runSsh verbatim.
  const ssh = recordingSsh();
  const driver = new StaticSshBoxDriver({ ssh_hosts: [...HOSTS] }, makeDeps(ssh.runSsh));

  const box = await driver.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });

  const health = await driver.probe(box, { timeoutMs: 7_000 });
  assert.equal(health.ok, true);

  assert.equal(ssh.calls.length, 1);
  assert.equal(ssh.calls[0]?.host, HOSTS[0]);
  assert.equal(ssh.calls[0]?.command, "printf ready");
  assert.equal(ssh.calls[0]?.options.timeoutMs, 7_000);
});

test("probe sends ONLY the readiness command (no workspace/hook commands)", async () => {
  const ssh = recordingSsh();
  const driver = new StaticSshBoxDriver({ ssh_hosts: [...HOSTS] }, makeDeps(ssh.runSsh));
  const box = await driver.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });

  const health = await driver.probe(box, { timeoutMs: 5_000 });
  assert.equal(health.ok, true);

  // The probe sent exactly the readiness command over the injected transport and
  // NO workspace/hook command (the driver runs no hooks and creates no files).
  const trace = ssh.calls.map((call) => call.command).join("\n");
  assert.match(trace, /printf ready/);
  assert.notMatch(trace, /git init/);
  assert.notMatch(trace, /rm -rf/);
  assert.equal(ssh.calls.length, 1);
});

test("destroy forgets the host, runs NO hooks, and never deletes the machine", async () => {
  const ssh = recordingSsh();
  const driver = new StaticSshBoxDriver({ ssh_hosts: [...HOSTS] }, makeDeps(ssh.runSsh));
  const box = await driver.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });

  await driver.destroy(box, { timeoutMs: 5_000, reason: "shrink" });
  // Idempotent: a second destroy of the same (already-forgotten) box is a no-op.
  await driver.destroy(box, { timeoutMs: 5_000, reason: "shrink" });

  // destroy merely FORGETS the host (the shared contract: list() reflects
  // provisioned-minus-destroyed), so the forgotten address drops out of list().
  const afterDestroy = (await driver.list()).map((entry) => entry.boxId);
  assert.equal(afterDestroy.includes(HOSTS[0]), false);

  // The machine is NEVER deleted: the configured address is still part of the
  // fixed inventory, so a re-provision re-hands the SAME address (it would have
  // thrown static_ssh_unknown_host if destroy had removed it from the host set).
  const reprovisioned = await driver.provision({
    boxId: HOSTS[0],
    labels: ["symphony.box-pool"],
    timeoutMs: 30_000,
  });
  assert.equal(reprovisioned.workerHost, HOSTS[0]);
  assert.equal(
    (await driver.list()).some((entry) => entry.boxId === HOSTS[0]),
    true,
  );

  // destroy ran ZERO ssh commands (it just forgets the host locally): no hooks,
  // no remote teardown, no machine deletion was ever attempted over SSH.
  assert.equal(ssh.calls.length, 0);
});

test("capabilities are { sshAddressable:true, ephemeral:false, usesLedger:false }", () => {
  const driver = new StaticSshBoxDriver({ ssh_hosts: [...HOSTS] }, makeDeps());
  assert.deepEqual(driver.capabilities, {
    sshAddressable: true,
    ephemeral: false,
    usesLedger: false,
  });
  assert.equal(driver.kind, "static-ssh");
});

test("throws when neither ssh_hosts nor sshHosts is a non-empty string array", () => {
  assert.throws(() => new StaticSshBoxDriver({}, makeDeps()), /static_ssh_hosts_required/);
  assert.throws(
    () => new StaticSshBoxDriver({ ssh_hosts: [] }, makeDeps()),
    /static_ssh_hosts_required/,
  );
  assert.throws(
    () => new StaticSshBoxDriver({ sshHosts: [123] }, makeDeps()),
    /static_ssh_hosts_required/,
  );
});

test("registerStaticSshBoxDriver registers the factory idempotently", () => {
  const registry = new BoxDriverRegistry();
  registerStaticSshBoxDriver({ boxDrivers: registry });
  // A second registration is a no-op (the kind is already registered).
  registerStaticSshBoxDriver({ boxDrivers: registry });

  const factory = registry.require("static-ssh");
  assert.equal(factory, staticSshBoxDriverFactory);

  // The factory constructs a working driver from the operator's driver options.
  const driver = factory.create({ ssh_hosts: [...HOSTS] }, makeDeps());
  assert.equal(driver.kind, "static-ssh");
});
