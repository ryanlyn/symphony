import { test } from "vitest";
import { createState, Orchestrator, normalizeIssue, parseConfig, slotKey } from "@symphony/cli";
import { systemClock } from "@symphony/ports";

import { assert } from "../../../test/assert.js";

test("orchestrator claims ensemble slots independently and snapshots backend-neutral fields", () => {
  const settings = parseConfig({
    agent: { ensemble_size: 2 },
    status_overrides: { Todo: { agent: { kind: "claude" } } },
  });
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: "Todo",
  });

  const first = orchestrator.claim(issue);
  const second = orchestrator.claim(issue);
  const third = orchestrator.claim(issue);

  assert.equal(first?.slotIndex, 0);
  assert.equal(second?.slotIndex, 1);
  assert.equal(third, null);
  assert.equal(first?.agentKind, "claude");

  orchestrator.applyUpdate(issue.id, 0, {
    type: "turn_completed",
    sessionId: "session-1",
    resumeId: "resume-1",
    executorPid: "123",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 0 },
  });

  const snapshot = orchestrator.snapshot();
  assert.equal(snapshot.running[0]?.sessionId, "session-1");
  assert.equal(snapshot.running[0]?.resumeId, "resume-1");
  assert.equal(snapshot.running[0]?.executorPid, "123");
  assert.equal(snapshot.usageTotals.totalTokens, 15);

  orchestrator.finish(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().retrying[0]?.attempt, 1);
});

test("refreshRunningIssue updates the tracker state of all slots for a running issue", () => {
  const orchestrator = new Orchestrator(parseConfig({ agent: { ensemble_size: 2 } }));
  const issue = normalizeIssue({ id: "i1", identifier: "MT-1", title: "Title", state: "Todo" });
  assert.ok(orchestrator.claim(issue));
  assert.ok(orchestrator.claim(issue));
  assert.equal(orchestrator.snapshot().running[0]?.issue.state, "Todo");
  assert.equal(orchestrator.snapshot().running[1]?.issue.state, "Todo");

  orchestrator.refreshRunningIssue({ ...issue, state: "In Progress" });

  assert.equal(orchestrator.snapshot().running[0]?.issue.state, "In Progress");
  assert.equal(orchestrator.snapshot().running[1]?.issue.state, "In Progress");
});

test("orchestrator keeps per-entry usage totals monotonic across runner corrections", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = normalizeIssue({
    id: "usage-non-monotonic",
    identifier: "MT-USAGE",
    title: "Usage",
    state: "Todo",
  });

  assert.ok(orchestrator.claim(issue));
  orchestrator.applyUpdate(issue.id, 0, {
    type: "usage",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  orchestrator.applyUpdate(issue.id, 0, {
    type: "usage",
    usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
  });

  const snapshot = orchestrator.snapshot();
  assert.deepEqual(snapshot.running[0]?.usageTotals, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    secondsRunning: 0,
  });
  assert.deepEqual(snapshot.usageTotals, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    secondsRunning: 0,
  });
});

test("orchestrator assigns SSH worker hosts by least loaded capacity", () => {
  const settings = parseConfig({
    worker: { ssh_hosts: ["worker-a:2200", "worker-b:2200"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 2 },
  });
  const orchestrator = new Orchestrator(settings);
  const firstIssue = normalizeIssue({ id: "i1", identifier: "MT-1", title: "One", state: "Todo" });
  const secondIssue = normalizeIssue({ id: "i2", identifier: "MT-2", title: "Two", state: "Todo" });
  const thirdIssue = normalizeIssue({
    id: "i3",
    identifier: "MT-3",
    title: "Three",
    state: "Todo",
  });

  assert.equal(orchestrator.claim(firstIssue)?.workerHost, "worker-a:2200");
  assert.equal(orchestrator.claim(secondIssue)?.workerHost, "worker-b:2200");
  assert.equal(orchestrator.claim(thirdIssue), null);

  orchestrator.finish(firstIssue.id, 0, false);
  assert.equal(orchestrator.claim(thirdIssue)?.workerHost, "worker-a:2200");
});

test("orchestrator snapshots capacity-blocked dispatch candidates", () => {
  const globalSettings = parseConfig({ agent: { max_concurrent_agents: 1 } });
  const globalOrchestrator = new Orchestrator(globalSettings);
  const running = normalizeIssue({
    id: "running",
    identifier: "MT-RUN",
    title: "Running",
    state: "Todo",
  });
  const blocked = normalizeIssue({
    id: "blocked",
    identifier: "MT-BLOCK",
    title: "Blocked",
    state: "Todo",
  });
  assert.ok(globalOrchestrator.claim(running));
  assert.deepEqual(globalOrchestrator.eligibleIssues([blocked]), []);
  assert.equal(globalOrchestrator.snapshot().blocked[0]?.reason, "global_concurrency_cap");

  const localSettings = parseConfig({
    agent: { max_concurrent_agents: 5 },
    status_overrides: { Todo: { agent: { max_concurrent_agents: 1 } } },
  });
  const localOrchestrator = new Orchestrator(localSettings);
  assert.ok(localOrchestrator.claim(running));
  assert.deepEqual(localOrchestrator.eligibleIssues([blocked]), []);
  assert.equal(localOrchestrator.snapshot().blocked[0]?.reason, "local_concurrency_cap");

  const workerSettings = parseConfig({
    worker: { ssh_hosts: ["worker-a"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 5 },
  });
  const workerOrchestrator = new Orchestrator(workerSettings);
  assert.ok(workerOrchestrator.claim(running));
  assert.deepEqual(workerOrchestrator.eligibleIssues([blocked]), []);
  assert.equal(workerOrchestrator.snapshot().blocked[0]?.reason, "worker_host_capacity");
});

test("orchestrator gates retry attempts until backoff is due and clears terminal retries", () => {
  const settings = parseConfig({ agent: { max_retry_backoff_ms: 2_000 } });
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "retry-1",
    identifier: "MT-RETRY",
    title: "Retry",
    state: "Todo",
  });
  const doneIssue = normalizeIssue({ ...issue, state: "Done", stateType: "completed" });

  assert.ok(orchestrator.claim(issue));
  orchestrator.finish(issue.id, 0, true);
  const retry = orchestrator.snapshot().retrying[0];
  assert.equal(retry?.attempt, 1);
  assert.deepEqual(orchestrator.eligibleIssues([issue]), []);

  retry!.dueAt = new Date(Date.now() - 1);
  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, "MT-RETRY");
  assert.equal(orchestrator.claim(issue)?.retryAttempt, 1);
  orchestrator.finish(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().retrying[0]?.attempt, 2);

  assert.deepEqual(orchestrator.eligibleIssues([doneIssue]), []);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
});

test("orchestrator uses Elixir retry delays for failures and active continuations", () => {
  const settings = parseConfig({ agent: { max_retry_backoff_ms: 60_000 } });
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "retry-delay",
    identifier: "MT-RETRY-DELAY",
    title: "Retry delay",
    state: "Todo",
  });

  assert.ok(orchestrator.claim(issue));
  const beforeFailure = Date.now();
  orchestrator.finish(issue.id, 0, true, "agent exited", "failure");
  let retry = orchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 1);
  assert.ok(retry.dueAt.getTime() - beforeFailure >= 9_900);

  const continuationOrchestrator = new Orchestrator(settings);
  assert.ok(continuationOrchestrator.claim(issue));
  const beforeContinuation = Date.now();
  continuationOrchestrator.finish(issue.id, 0, true, undefined, "continuation");
  retry = continuationOrchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 1);
  const continuationDelay = retry.dueAt.getTime() - beforeContinuation;
  assert.ok(continuationDelay >= 900 && continuationDelay <= 1_500);

  retry.dueAt = new Date(Date.now() - 1);
  assert.equal(continuationOrchestrator.claim(issue)?.retryAttempt, 1);
  const beforeSecondContinuation = Date.now();
  continuationOrchestrator.finish(issue.id, 0, true, undefined, "continuation");
  retry = continuationOrchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 1);
  const secondContinuationDelay = retry.dueAt.getTime() - beforeSecondContinuation;
  assert.ok(secondContinuationDelay >= 900 && secondContinuationDelay <= 1_500);

  retry.dueAt = new Date(Date.now() - 1);
  assert.equal(continuationOrchestrator.claim(issue)?.retryAttempt, 1);
  const beforeFailureAfterContinuations = Date.now();
  continuationOrchestrator.finish(
    issue.id,
    0,
    true,
    "transient failure after healthy continuations",
    "failure",
  );
  retry = continuationOrchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 2);
  const failureDelay = retry.dueAt.getTime() - beforeFailureAfterContinuations;
  assert.ok(failureDelay >= 19_900 && failureDelay <= 20_500);
});

test("orchestrator retry dispatch reopens slots blocked only by stale claims", () => {
  const settings = parseConfig();
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "stale-retry",
    identifier: "MT-STALE",
    title: "Retry stale claim",
    state: "Todo",
  });
  orchestrator.state.claimed.add(slotKey(issue.id, 0));
  orchestrator.state.retryAttempts.set(issue.id, {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    dueAt: new Date(Date.now() - 1),
    error: "agent exited: boom",
  });

  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, "MT-STALE");
  const claim = orchestrator.claim(issue);
  assert.equal(claim?.slotIndex, 0);
  assert.equal(claim?.retryAttempt, 1);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
});

test("orchestrator retries an ensemble issue in its original slot", () => {
  const settings = parseConfig({ agent: { ensemble_size: 3 } });
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "ensemble-retry",
    identifier: "MT-ENSEMBLE-RETRY",
    title: "Retry slot",
    state: "Todo",
  });

  orchestrator.state.retryAttempts.set(issue.id, {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    dueAt: new Date(Date.now() - 1),
    slotIndex: 2,
    error: "agent exited",
  });

  assert.equal(orchestrator.claim(issue)?.slotIndex, 2);
});

test("orchestrator workerCapacityAvailable consults capacityProbe.canAcquire when present", () => {
  const settings = parseConfig();
  let available = false;
  const probe = { governs: () => true, canAcquire: () => available };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "probe-capacity",
    identifier: "MT-PROBE",
    title: "Probe",
    state: "Todo",
  });

  assert.deepEqual(orchestrator.eligibleIssues([issue]), []);
  assert.equal(orchestrator.snapshot().blocked[0]?.reason, "worker_host_capacity");
  assert.equal(orchestrator.claim(issue), null);

  available = true;
  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, "MT-PROBE");
  assert.ok(orchestrator.claim(issue));
});

test("orchestrator claim bypass sets workerHost to pending:// sentinel (never null) when probe present", () => {
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "sentinel-issue",
    identifier: "MT-SENTINEL",
    title: "Sentinel",
    state: "Todo",
  });

  const entry = orchestrator.claim(issue);
  assert.equal(entry?.workerHost, `pending://${issue.id}/0`);
  assert.notEqual(entry?.workerHost, null);
  assert.equal(entry?.affinityHost, null);
  assert.equal(orchestrator.snapshot().running[0]?.workerHost, `pending://${issue.id}/0`);
});

test("orchestrator claim bypass sets affinityHost = retry.workerHost (retry affinity preserved)", () => {
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "affinity-issue",
    identifier: "MT-AFFINITY",
    title: "Affinity",
    state: "Todo",
  });

  orchestrator.state.retryAttempts.set(issue.id, {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    dueAt: new Date(Date.now() - 1),
    slotIndex: 0,
    workerHost: "warm-box-7:2200",
    error: "agent exited",
  });

  const entry = orchestrator.claim(issue);
  assert.equal(entry?.workerHost, `pending://${issue.id}/0`);
  assert.equal(entry?.affinityHost, "warm-box-7:2200");
  assert.equal(entry?.retryAttempt, 1);
});

test("orchestrator static sshHosts path unchanged when no capacity probe is present", () => {
  const settings = parseConfig({
    worker: { ssh_hosts: ["worker-a:2200", "worker-b:2200"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 2 },
  });
  const orchestrator = new Orchestrator(settings);
  const first = normalizeIssue({ id: "s1", identifier: "MT-S1", title: "One", state: "Todo" });
  const second = normalizeIssue({ id: "s2", identifier: "MT-S2", title: "Two", state: "Todo" });

  const firstEntry = orchestrator.claim(first);
  const secondEntry = orchestrator.claim(second);
  assert.equal(firstEntry?.workerHost, "worker-a:2200");
  assert.equal(firstEntry?.affinityHost, undefined);
  assert.equal(secondEntry?.workerHost, "worker-b:2200");
  assert.equal(orchestrator.claim(first), null);
});

test("orchestrator setWorkerHost overwrites the pending:// sentinel with the leased host", () => {
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "set-host-issue",
    identifier: "MT-SET",
    title: "Set host",
    state: "Todo",
  });

  const entry = orchestrator.claim(issue);
  assert.equal(entry?.workerHost, `pending://${issue.id}/0`);

  orchestrator.setWorkerHost(issue.id, 0, "leased-box-3:2200");
  assert.equal(orchestrator.snapshot().running[0]?.workerHost, "leased-box-3:2200");
  assert.equal(
    orchestrator.state.running.get(slotKey(issue.id, 0))?.workerHost,
    "leased-box-3:2200",
  );
});

test("orchestrator abandonClaim drops running+claimed with NO retry record, leaving the slot re-claimable", () => {
  const settings = parseConfig();
  const available = true;
  const probe = { governs: () => true, canAcquire: () => available };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "abandon-issue",
    identifier: "MT-ABANDON",
    title: "Abandon",
    state: "Todo",
  });

  assert.ok(orchestrator.claim(issue));
  assert.equal(orchestrator.state.claimed.has(slotKey(issue.id, 0)), true);
  const retryAttemptsBefore = orchestrator.state.retryAttempts.size;

  orchestrator.abandonClaim(issue.id, 0);

  assert.equal(orchestrator.state.running.has(slotKey(issue.id, 0)), false);
  assert.equal(orchestrator.state.claimed.has(slotKey(issue.id, 0)), false);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
  assert.equal(orchestrator.state.retryAttempts.size, retryAttemptsBefore);
  assert.equal(orchestrator.snapshot().usageTotals.secondsRunning, 0);

  const reclaim = orchestrator.claim(issue);
  assert.equal(reclaim?.slotIndex, 0);
  assert.equal(reclaim?.workerHost, `pending://${issue.id}/0`);
});

test("orchestrator workerCapacityAvailable falls through to local (true) when probe is present but not governing", () => {
  // A disabled (reloaded-off) pool's probe is still installed for the lifetime, but
  // its canAcquire() returns false. When it no longer governs capacity the
  // orchestrator must NOT block on it; it must fall through to the static/local
  // path. With no ssh_hosts the local path always has capacity (true), so eligible
  // work resumes instead of being permanently blocked as worker_host_capacity.
  const settings = parseConfig();
  const probe = { governs: () => false, canAcquire: () => false };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "fallthrough-local",
    identifier: "MT-FALLTHROUGH-LOCAL",
    title: "Fallthrough local",
    state: "Todo",
  });

  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, "MT-FALLTHROUGH-LOCAL");
  assert.equal(orchestrator.snapshot().blocked.length, 0);
});

test("orchestrator workerCapacityAvailable honors static ssh_hosts when probe is present but not governing", () => {
  // When the probe does not govern, the static sshHosts host-selection path is the
  // source of truth: a saturated host pool still reports no capacity.
  const settings = parseConfig({
    worker: { ssh_hosts: ["worker-a"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 5 },
  });
  const probe = { governs: () => false, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const running = normalizeIssue({
    id: "static-running",
    identifier: "MT-STATIC-RUN",
    title: "Running",
    state: "Todo",
  });
  const blocked = normalizeIssue({
    id: "static-blocked",
    identifier: "MT-STATIC-BLOCK",
    title: "Blocked",
    state: "Todo",
  });

  // The claim takes the static selectWorkerHost path (real host, not the sentinel).
  assert.equal(orchestrator.claim(running)?.workerHost, "worker-a");
  assert.deepEqual(orchestrator.eligibleIssues([blocked]), []);
  assert.equal(orchestrator.snapshot().blocked[0]?.reason, "worker_host_capacity");
});

test("orchestrator claim does NOT set the pending:// sentinel when probe is present but not governing", () => {
  // A non-governing probe must use the normal selectWorkerHost path, which yields
  // null/local (no ssh_hosts) instead of the pending:// bypass sentinel.
  const settings = parseConfig();
  const probe = { governs: () => false, canAcquire: () => false };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "no-sentinel",
    identifier: "MT-NO-SENTINEL",
    title: "No sentinel",
    state: "Todo",
  });

  const entry = orchestrator.claim(issue);
  assert.ok(entry);
  assert.equal(entry?.workerHost, null);
  assert.equal(entry?.affinityHost, undefined);
});
