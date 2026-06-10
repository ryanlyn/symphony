import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { PROVIDER_KINDS, withDerivedMaxInFlight } from "@symphony/domain";
import type {
  BoxPoolProvider,
  BoxPoolSettings,
  RunningEntry,
  WorkerSettings,
} from "@symphony/domain";

// The provider enum mirrors the spec (Section 5): each cloud driver is its own kind.
const expectedProviderKinds: ReadonlyArray<BoxPoolProvider> = [
  "fake",
  "static-ssh",
  "docker",
  "fly",
  "e2b",
  "modal",
];

// A full BoxPoolSettings literal: every required field plus the optional spend/providerOptions/cap.
// `slotsPerMachine` is the single own field; `maxInFlight` is installed as a derived getter.
const boxPoolFixture: BoxPoolSettings = withDerivedMaxInFlight({
  enabled: true,
  provider: "static-ssh",
  min: 0,
  max: 4,
  warm: 1,
  slotsPerMachine: 1,
  ttlMs: 3_600_000,
  idleReapMs: 300_000,
  acquireTimeoutMs: 30_000,
  reapIntervalMs: 15_000,
  staleHeartbeatMs: 600_000,
  drainDeadlineMs: 30_000,
  maxBoxesPerIssue: 2,
  spend: {
    maxConcurrentBoxes: 4,
    maxBoxSeconds: 7_200,
    dailyBoxSeconds: 86_400,
  },
  providerOptions: {
    ssh_hosts: ["user@host-a:22", "user@host-b:22"],
  },
});

// A minimal BoxPoolSettings literal: only the required fields, optionals omitted.
const minimalBoxPoolFixture: BoxPoolSettings = withDerivedMaxInFlight({
  enabled: false,
  provider: "fake",
  min: 0,
  max: 1,
  warm: 1,
  slotsPerMachine: 1,
  ttlMs: 3_600_000,
  idleReapMs: 300_000,
  acquireTimeoutMs: 30_000,
  reapIntervalMs: 15_000,
  staleHeartbeatMs: 600_000,
  drainDeadlineMs: 30_000,
});

// The co-residence opt-in and tunnel ceiling are additive optionals (STEP 3); a
// literal that sets them stays valid and `withDerivedMaxInFlight` carries them through.
const coResidentBoxPoolFixture: BoxPoolSettings = withDerivedMaxInFlight({
  enabled: true,
  provider: "fake",
  min: 0,
  max: 4,
  warm: 0,
  slotsPerMachine: 2,
  ttlMs: 3_600_000,
  idleReapMs: 300_000,
  acquireTimeoutMs: 30_000,
  reapIntervalMs: 15_000,
  staleHeartbeatMs: 600_000,
  drainDeadlineMs: 30_000,
  coResidence: true,
  maxConcurrentTunnels: 8,
});

// WorkerSettings.boxPool is additive and optional - existing configs omit it entirely.
const workerWithoutPool: WorkerSettings = {
  sshHosts: [],
  sshTimeoutMs: 60_000,
};
const workerWithPool: WorkerSettings = {
  sshHosts: [],
  sshTimeoutMs: 60_000,
  boxPool: minimalBoxPoolFixture,
};

const runningEntryFixture: RunningEntry = {
  issue: {
    id: "issue-1",
    identifier: "MT-1",
    title: "Fixture",
    state: "Todo",
    stateType: "unstarted",
    labels: [],
    blockers: [],
  },
  identifier: "MT-1",
  slotIndex: 0,
  ensembleSize: 1,
  agentKind: "codex",
  turnCount: 0,
  startedAt: new Date(0),
  usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
  lastReportedInputTokens: 0,
  lastReportedOutputTokens: 0,
  lastReportedTotalTokens: 0,
  retryAttempt: null,
};

// RunningEntry.affinityHost is optional: a running entry without it stays valid.
const runningEntryWithAffinity: RunningEntry = {
  ...runningEntryFixture,
  affinityHost: "user@host-a:22",
};

// @ts-expect-error provider must be one of PROVIDER_KINDS.
const invalidProvider: BoxPoolProvider = "broker";

test("PROVIDER_KINDS lists the six box-pool providers", () => {
  assert.deepEqual([...PROVIDER_KINDS], [...expectedProviderKinds]);
  for (const kind of expectedProviderKinds) {
    assert.ok(PROVIDER_KINDS.includes(kind));
  }
  assert.equal(PROVIDER_KINDS.length, 6);
});

test("BoxPoolSettings shape compiles with and without optionals", () => {
  assert.equal(boxPoolFixture.provider, "static-ssh");
  assert.equal(boxPoolFixture.slotsPerMachine, 1);
  assert.equal(boxPoolFixture.spend?.dailyBoxSeconds, 86_400);
  assert.deepEqual(boxPoolFixture.providerOptions?.ssh_hosts, ["user@host-a:22", "user@host-b:22"]);
  assert.equal(minimalBoxPoolFixture.spend, undefined);
  assert.equal(minimalBoxPoolFixture.maxBoxesPerIssue, undefined);
});

test("BoxPoolSettings.coResidence and maxConcurrentTunnels are optional and additive", () => {
  // Absent on the minimal/default fixtures: omitting them stays valid (no widening of the
  // single-tenant path) and the derived maxInFlight getter still holds.
  assert.equal(minimalBoxPoolFixture.coResidence, undefined);
  assert.equal(minimalBoxPoolFixture.maxConcurrentTunnels, undefined);
  assert.equal(boxPoolFixture.coResidence, undefined);
  assert.equal(boxPoolFixture.maxConcurrentTunnels, undefined);

  // Present on the co-resident fixture: both carry through and maxInFlight still mirrors
  // slotsPerMachine (the factory installs the getter regardless of the new optionals).
  assert.equal(coResidentBoxPoolFixture.coResidence, true);
  assert.equal(coResidentBoxPoolFixture.maxConcurrentTunnels, 8);
  assert.equal(coResidentBoxPoolFixture.slotsPerMachine, 2);
  assert.equal(coResidentBoxPoolFixture.maxInFlight, 2);
  assert.equal(coResidentBoxPoolFixture.maxInFlight, coResidentBoxPoolFixture.slotsPerMachine);
});

test("BoxPoolSettings.maxInFlight is a derived getter that always equals slotsPerMachine", () => {
  // Default 1: the derived alias mirrors the canonical field.
  assert.equal(boxPoolFixture.slotsPerMachine, 1);
  assert.equal(boxPoolFixture.maxInFlight, 1);
  assert.equal(boxPoolFixture.maxInFlight, boxPoolFixture.slotsPerMachine);

  // Build with a non-default value: maxInFlight tracks it with no second field to set.
  const multi = withDerivedMaxInFlight({
    enabled: true,
    provider: "fake",
    min: 0,
    max: 4,
    warm: 0,
    slotsPerMachine: 3,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 30_000,
    reapIntervalMs: 15_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
  });
  assert.equal(multi.slotsPerMachine, 3);
  assert.equal(multi.maxInFlight, 3);

  // It is a live getter, not a snapshot: mutating slotsPerMachine re-derives maxInFlight,
  // so the two can never drift even if a later writer bumps the canonical field.
  multi.slotsPerMachine = 5;
  assert.equal(multi.maxInFlight, 5);
  assert.equal(multi.maxInFlight, multi.slotsPerMachine);

  // maxInFlight is read-only at runtime (no setter) so it cannot be assigned out of sync.
  const descriptor = Object.getOwnPropertyDescriptor(multi, "maxInFlight");
  assert.ok(descriptor);
  assert.equal(typeof descriptor?.get, "function");
  assert.equal(descriptor?.set, undefined);
});

test("WorkerSettings.boxPool is optional and additive", () => {
  assert.equal(workerWithoutPool.boxPool, undefined);
  assert.equal(workerWithPool.boxPool?.provider, "fake");
});

test("RunningEntry.affinityHost is optional", () => {
  assert.equal(runningEntryFixture.affinityHost, undefined);
  assert.equal(runningEntryWithAffinity.affinityHost, "user@host-a:22");
});

test("BoxPoolProvider rejects unknown providers", () => {
  assert.equal(invalidProvider, "broker");
});
