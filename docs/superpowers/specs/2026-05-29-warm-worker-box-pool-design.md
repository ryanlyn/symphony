# Warm Worker/Executor Box Pool — Design Spec

Status: approved-for-implementation (TS port only)
Date: 2026-05-29
Scope: `ts/` only. No Elixir changes. Implement to the working tree (no commit/PR), with exhaustive, e2e, all-edge-case test confidence.

This spec is the authoritative reference for implementers. Exhaustive task and per-test-case
detail also lives in the machine-readable plan at `/tmp/crabbox_wf1/plan.json` and the verified
internals dossier at `/tmp/crabbox_wf1/dossier.md` (both produced by the research workflow,
grounded in `file:line` anchors). Read this doc first; consult those for the long tail.

## 1. Goal and inspiration

Inspired by crabbox (https://crabbox.sh — "warm a box, sync the diff, run the suite"): a remote
test/execution control plane built on a **lease model** (provision a time-bounded box, reuse warm
boxes across runs, sync the working tree, run, return the box) with a swappable **provider**
abstraction (brokered cloud / direct SSH / delegated sandboxes like E2B, Modal, Firecracker) and
**spend caps**. We adapt that lease/warm-box/provider model into Symphony as an **embedded** pool —
no broker process, no separate CLI, no IPC — wired through the daemon's existing function-injection
seams.

Crabbox parts we **adopt**: typed acquire/lease/release, warm-idle reuse, provider abstraction
behind one interface, sticky re-acquire (affinity), spend caps, label-based reconcile of survivors.
Crabbox parts we **drop**: the standalone broker/Durable Object, the CLI front-end, and rsync sync
(Symphony's runner already creates the per-issue workspace over SSH — the pool must NOT duplicate
that).

## 2. The load-bearing insight

`workerHost: string | null` is a single value already threaded end-to-end through the orchestrator,
runtime, agent-runner, workspace, executors, resume-state, and retry. Its meaning is invariant:
**`null` => run locally; a non-null string => a remote SSH destination** (`user@host:port` or a
`~/.ssh/config` alias).

The pool slots in by becoming the thing that **produces** that string:
- Today: `Orchestrator.selectWorkerHost()` picks from a static `worker.sshHosts` array at claim time.
- New: when a pool is configured, the orchestrator defers host selection; the runtime **leases a box
  just before running** and writes the leased box's SSH address back as the run's `workerHost`,
  then **releases/fails the lease** in the same `finally` that already handles cleanup/abort/stall.

Because the downstream pipeline only ever sees a `workerHost` string, nothing downstream changes.

Key verified seams (anchors in `ts/`):
- Host decision: `orchestrator/src/index.ts:150-161` (`selectWorkerHost`), policy `policies/src/workerHost.ts`; capacity gate `orchestrator/src/index.ts:163-166`.
- Runtime threading: `runtime/src/index.ts:391` (read claim), `419,424-438` (call runner), `509-511` (the `finally` that releases the run handle), reload `519-532` (top of each poll tick), `ActiveRunHandle` generation guard `191-220`.
- Runner: `agent-runner/src/index.ts:97` (workerHost), `98-106` (workspace create + beforeRun), `139-149` (executor.startSession), `181-193` (afterRun finally).
- Workspace (remote, over SSH): `workspace/src/index.ts:25-51`, remote create `256-301`, marker `:8`.
- Executors branch local-vs-SSH on workerHost: codex `codex/src/executor.ts:54-61`; acp `acp/src/index.ts:81,475-493,517-526`.
- SSH primitives: `ssh/src/index.ts:82-89,121-130,160-168`, timeout guard `32-33`, `$SYMPHONY_SSH_CONFIG` is the universal `-F` injection point.
- Dormant lease contract to adopt as the pool's shape: `ports/src/index.ts:50-57` (`WorkerHostPort.acquire -> WorkerHostLease{ workerHost, release() }`).
- Reverse-MCP-tunnel pool (DO NOT extend — different concern): `worker-host-pool/src/index.ts`.
- Config: `config/src/index.ts` (manual zod-shape + hand-written coercion), defaults `:283`, aliases `:186-190/:885`, `cloneSettings` `:785-802` (hot path via `settingsForIssueState`).

## 3. Architecture

New sibling package `@symphony/worker-box-pool` (`ts/packages/worker-box-pool`). Depends on
`@symphony/domain`, `@symphony/ports`, `@symphony/ssh` only. **No** `@symphony/workspace` dep (the
pool never touches workspaces or hooks). No cloud SDK deps in the package's runtime `dependencies`
(cloud drivers shell out to provider CLIs / use injected clients so the package stays light and
testable).

Files:
- `src/types.ts` — all shared types (no cycles): `BoxProvider`, `BoxDescriptor`, `BoxHealth`, `ProvisionRequest`, `ProviderCapabilities`, `ProviderDeps`, `BoxLease`, `BoxPool`, `AcquireRequest`, `AcquireResult`, `WarmupStrategy`, `TeardownReason`, `BoxState`, `BoxRecord`, `LedgerRow`, `BoxPoolSnapshot`, `BoxProviderFactory`, `BoxOutcome`, `Mutex`.
- `src/mutex.ts` — tiny promise-chain async mutex (`runExclusive`).
- `src/ledger.ts` — write-ahead JSON ledger (cloud providers only) + daily-spend sidecar `spend.json` (UTC day-key, survives restart). Atomic tmp+rename.
- `src/registry.ts` — `registerBoxProvider` / `resolveProvider` / `clearBoxProviderRegistry`.
- `src/conformance.ts` — `runProviderConformanceSuite(makeProvider, opts)`: the shared BoxProvider contract test body, imported by every provider's test (fake, static-ssh, and each cloud driver).
- `src/lease.ts` — `createLease`: `leaseId`-owned, `settled`-flag-idempotent; `release(outcome='healthy')` keeps the box, `fail(reason)` poisons it for recycle; `heartbeat()`; settle runs inside the per-box mutex; stale leaseId / DESTROYED state are no-ops that never touch `inFlight`.
- `src/pool.ts` — the `BoxPool`: inventory `Map<boxId,BoxRecord>`, lease table, FIFO waiter queue, a **synchronous capacity-reservation counter** taken before any `await` (so two concurrent growth decisions can't exceed `max`), per-box mutex, spend accounting, `acquire`/`canAcquire`/`reconcile`/`hydrate`/`drain`/`snapshot`. Owns the reaper `ClockPort` timer and calls `handle.unref?.()` on it.
- `src/reaper.ts` — single serial tick: ttl/idle reap (respecting `min`), LEASED-past-ttl `markedForDestroy` (recycled when `inFlight->0` inside the per-box mutex), DEGRADED on probe fail, orphan detection (stale heartbeat AND run gone, distinguished from a long-but-alive single turn), `provider.list()` authoritative reconcile (re-adopt labeled-ours, destroy ONLY labeled-pool-owned-unknown, NEVER unlabeled, mark registered-but-missing DESTROYED), top-up toward `min`/`warm` within budget.
- `src/providers/fake.ts` — in-memory `FakeBoxProvider` (`fake://box-<id>`), deterministic clock, failure injection, zero-fs-I/O assertable. `capabilities { sshAddressable:false, ephemeral:false, usesLedger:false }`.
- `src/providers/static-ssh.ts` — `StaticSshBoxProvider`: hands out fixed addresses from `providerOptions.ssh_hosts` (idempotent, `min==max==len`); reads BOTH `ssh_hosts` (snake) AND `sshHosts` (camel) because config passes `providerOptions` through un-normalized; `probe` = `runSsh(host,'printf ready',{timeoutMs: worker.sshTimeoutMs})`; `destroy` is a no-op that forgets the host (never deletes a machine, runs NO hooks).
- `src/providers/docker.ts`, `src/providers/fly.ts`, `src/providers/e2b.ts`, `src/providers/modal.ts` — the four cloud drivers (Section 5).
- `src/test-support/evalSsh.ts` — reusable `installEvalSsh` (adapted from `test/workspace-prompt-resume.test.ts:668`) so static-ssh + live tests share one eval-ssh transport shim.
- `src/index.ts` — barrel: re-exports public API; imports each provider module so they self-register; exposes `createBoxPool`.

Public interfaces (authoritative signatures in `/tmp/crabbox_wf1/plan.json` -> `publicInterfaces`):
- `BoxProvider { kind; provision(req); probe(box,opts); destroy(box,opts); list(); capabilities }`
- `BoxPool { acquire(req); canAcquire(); reconcile(next); hydrate(); drain({deadlineMs,signal}); snapshot() }`
- `BoxLease { leaseId; boxId; workerHost; acquiredAtMs; expiresAtMs; release(outcome?); fail(reason); heartbeat() }`
- `AcquireResult = {status:'leased'; lease} | {status:'no_capacity'; reason:'acquire_timeout'|'spend_cap'|'pool_disabled'|'provider_error'}`
- `BoxOutcome = 'healthy' | 'poison'`
- `createBoxPool(settings, { clock, logEvent, ledgerPath? }): BoxPool` — NO workspace/hook deps.
- `BoxState = 'PROVISIONING'|'WARMING'|'WARM_IDLE'|'LEASED'|'RETURNING'|'DEGRADED'|'DESTROYING'|'DESTROYED'|'DRAINING'`

## 4. Integration (the critical-correctness edits)

These edits were adversarially critiqued; each fixes a verified failure mode. Do not regress them.

1. **Domain** (`domain/src/index.ts`): add `PROVIDER_KINDS = ['fake','static-ssh','docker','fly','e2b','modal'] as const` + derived `BoxPoolProvider` near `:15`; add `BoxPoolSettings`; add `boxPool?:` to `WorkerSettings` (`164-178`); add `affinityHost?: string | null` to `RunningEntry`. All additive/optional.
2. **Config** (`config/src/index.ts`): `parseBoxPool` under `worker.boxPool` (absent => disabled => byte-identical for all existing configs); strict sub-schema; snake_case aliases (but `providerOptions` is intentionally NOT normalized — providers read both spellings); cross-field guards (`max>=min`, `warm<=max`, static-ssh requires `ssh_hosts`); **anti-double-capacity guard**: reject `boxPool.enabled` together with non-empty `worker.sshHosts`. `cloneSettings` must DEEP-copy `boxPool` including nested `providerOptions` arrays and `spend` (shallow `{...}` aliases `ssh_hosts` across the hot per-issue clone). A regression test pins that absent `box_pool` yields a Settings clone deep-equal to the pre-change shape.
3. **Orchestrator** (`orchestrator/src/index.ts`): optional 4th ctor param `capacityProbe?: { canAcquire(): boolean }`. When present: `workerCapacityAvailable()` returns `capacityProbe.canAcquire()`; `claim()` BYPASSES `selectWorkerHost`, setting `entry.workerHost` to a `pending://<issueId>/<slot>` **sentinel** (never `null`, so no projection shows a misleading "local") AND `entry.affinityHost = retry?.workerHost ?? null` (so retry affinity survives the bypass). Add `setWorkerHost(issueId,slot,host)` (overwrite the sentinel) and `abandonClaim(issueId,slot)` (delete running+claimed with NO retry record — the inverse of `claim`, distinct from `finish()` which schedules backoff).
4. **Runtime — acquire/release** (`runtime/src/index.ts`): add `boxPool?: BoxPool` to `SymphonyRuntimeOptions`; construct the Orchestrator with a `capacityProbe` delegating to `boxPool.canAcquire()`. In `runClaim`, before `this.runner(...)`: acquire using `affinityKey = RunningEntry.affinityHost` (NOT the sentinel). On `no_capacity`: emit a `worker_host_capacity`-flavored skip, call `orchestrator.abandonClaim(...)` (NOT `finish` — avoids backoff churn), release the handle, return WITHOUT running and WITHOUT history. On `leased`: `setWorkerHost(...)` to the real address before the runner, pass it to the runner, and wrap `onUpdate` to also call `lease.heartbeat()`. In the `finally`: a **structured** `boxOutcome` (`classifyBoxOutcome(error)`) decides `lease.release('healthy')` vs `lease.fail(reason)` — `poison` ONLY for typed box-transport faults (`ssh_timeout`, `remote_home_lookup_failed`, `workspace_prepare_failed`, ssh-hook failure); `healthy` for `ssh_not_found` (LOCAL ENOENT — ssh binary missing), `invalid_ssh_timeout`, `agent_run_aborted`, and ordinary agent failures. A run finished externally due to a stall is classified `poison`. All lease ops are `leaseId`+`settled`+state-guarded so a stale generation is a no-op.
5. **Runtime — reload** (`519-532`): after swapping settings, `boxPool?.reconcile(workflow.settings.worker.boxPool)`. A reload that throws the anti-double-capacity guard keeps last-good AND surfaces the guard message in `workflow_reload_failed`.
6. **Runtime — drain**: do NOT make `stop()` async (it is sync void at `301-307`). Add `async drainBoxPool()` (idempotent) that awaits `boxPool?.drain({deadlineMs: worker.boxPool.drainDeadlineMs})`. `main.ts` awaits it in its `finally` AFTER `runtime.start()` resolves (start returns once stopped), so paid cloud boxes are destroyed before exit.
7. **Daemon/CLI** (`apps/cli/src/daemon.ts`, `main.ts`, `index.ts`, `package.json`): `buildBoxPool(settings,env)` constructs the pool when enabled, registers providers (built-ins self-register on import), `await boxPool?.hydrate()` at startup; `resolveProvider` throws `box_pool_provider_unavailable` at startup for an enabled-but-unavailable kind (fail loud). Re-export the public types for test imports. When disabled, `boxPool` is `undefined` and behavior is byte-identical.

## 5. Cloud drivers (author + env-gated; no live cloud run this round)

All four are implemented behind `BoxProvider`. **Transport invariant:** every provider yields an
**SSH-addressable** `workerHost` (`capabilities.sshAddressable=true`), because Symphony's executor
uses SSH. Delegated sandboxes (E2B, Modal) are provisioned to run `sshd` and expose an SSH endpoint;
a non-SSH/delegated transport would require executor changes and is OUT OF SCOPE (note it as a
future extension). Each driver provisions, labels (so `list()`-reconcile can adopt survivors),
probes via `runSsh` printf-ready, destroys via the provider API/CLI, and lists by label filter.

**Daemon-constructibility (fail loud at startup):** `docker` and `fly` need NO injected dependency
(`docker` shells out to the `docker` subprocess; `fly` uses `fetch`), so the stock daemon constructs
them directly. **`e2b` and `modal` are NOT constructible by the stock daemon:** they are authored
behind injected interfaces (`E2BSandboxClient` / `ModalTransport`) that this package deliberately
does not depend on, and the daemon ships no production client/transport for them. Their built-in
factory therefore fails LOUD at construction (during `createBoxPool`/`buildBoxPool`, consistent with
`resolveProvider`'s fail-loud contract) with an actionable
`box_pool_provider_unavailable: <kind> requires an injected <client|transport>; register a custom
'<kind>' factory via registerBoxProvider(...) before enabling it` whenever no client/transport was
threaded through `ProviderDeps`. To enable `e2b`/`modal`, a deployment MUST register a custom factory
(via `registerBoxProvider`) that injects a real client/transport BEFORE enabling the kind (last write
wins over the built-in); otherwise enabling them fails fast at daemon startup rather than constructing
a pool that only throws at first provision. The always-on `e2b`/`modal` unit tests bypass this by
constructing the provider class directly with a fake injected client/transport.

Two test tiers per driver:
- **Always-on unit tests** of the driver's logic via the repo's PATH-shim fake-binary pattern (a
  fake `docker`/`flyctl` on `PATH`) or an injected fake SDK client: assert command/argument
  construction, label parsing, idempotent destroy, list filtering, capability flags, error mapping.
  These hit the real driver code paths with zero network/cost and run in `mise run check`.
- **Env-gated live tests** that actually provision/destroy, collected-but-skipped without the gate
  (mirroring `SYMPHONY_TS_RUN_LIVE_*`). Authored now; runnable on demand once creds exist.

Drivers and gates:
- `docker` — `docker run -d` a base image running `sshd`, publish a port, `workerHost=user@127.0.0.1:<port>`; `probe` via ssh; `destroy`=`docker rm -f`; `list`=`docker ps` filtered by a `symphony.box-pool` label. Live gate `SYMPHONY_TS_RUN_LIVE_DOCKER_E2E=1` (+ docker present). Closest to always-runnable.
- `fly` — Fly Machines (via `flyctl`/Machines API): create a machine from an image with sshd, return its SSH endpoint; destroy via machines destroy; list by app+label. Live gate `SYMPHONY_TS_RUN_LIVE_FLY_E2E=1` (+ `FLY_API_TOKEN`).
- `e2b` — E2B sandbox via the E2B API/SDK (injected client): start a sandbox configured for SSH access, return endpoint; kill on destroy; list running sandboxes by metadata label. Live gate `SYMPHONY_TS_RUN_LIVE_E2B_E2E=1` (+ `E2B_API_KEY`).
- `modal` — Modal Sandbox via the local Modal client/CLI: create a sandbox exposing ssh, return endpoint; terminate on destroy; list by label. Live gate `SYMPHONY_TS_RUN_LIVE_MODAL_E2E=1` (+ Modal token).

`PROVIDER_KINDS` therefore = `['fake','static-ssh','docker','fly','e2b','modal']`. The shared
conformance suite runs against every driver (always-on via fakes; live behind each gate).

## 6. Config shape (under `worker.box_pool`, snake_case in YAML)

```yaml
worker:
  box_pool:
    enabled: true
    provider: docker          # fake | static-ssh | docker | fly | e2b | modal
    min: 0
    max: 4
    warm: 1
    max_in_flight: 1          # only 1 is safe vs the workerHost-keyed MCP tunnel refCount
    ttl_ms: 3600000
    idle_reap_ms: 300000
    acquire_timeout_ms: 30000
    reap_interval_ms: 15000
    stale_heartbeat_ms: 600000
    drain_deadline_ms: 30000
    max_boxes_per_issue: 2    # optional fairness cap so an ensemble can't monopolize the pool
    spend:
      max_concurrent_boxes: 4
      max_box_seconds: 7200     # seconds
      daily_box_seconds: 86400  # seconds, UTC-day, persisted across restart via spend.json
    provider_options:          # passed through un-normalized; provider reads snake AND camel
      ssh_hosts: ["user@host-a:22"]   # static-ssh
      image: "ghcr.io/org/box:latest" # docker/fly/e2b/modal base image
```
Defaults when `box_pool` absent: disabled, byte-identical behavior. Durations in ms; spend in
seconds (to match `UsageTotals.secondsRunning`). `max_in_flight` defaults to `1`.

## 7. Test layering (maps to the three requested layers + always-on)

1. **local-fakes / always-on** (`mise run check`): mutex, ledger, registry, conformance(fake),
   lease, pool, reaper, fake provider (zero-I/O), static-ssh via `installEvalSsh`, each cloud
   driver's logic via PATH-shim/injected-client fakes, config (incl. byte-identical regression),
   orchestrator, runtime (fake BoxPool injected), property tests (fast-check `^4.8.0`), and an
   end-to-end demo through the real `runDaemon` with `tracker.kind=memory` + `provider=fake`.
2. **loopback-ssh** (gate `SYMPHONY_TS_RUN_LIVE_SSH_E2E=1`, reuse `setupNativeSshdWorker`,
   `live-ssh.test.ts:195`): real acquire over a real local `sshd` -> runner creates the workspace
   over SSH -> run -> release/fail; retry re-leases the SAME boxId with preserved resume; drain
   force-destroys (no leak).
3. **real-ssh-host (BYO/docker)** (same gate + `SYMPHONY_LIVE_SSH_WORKER_HOSTS`): multi-box, per-box
   isolation, sticky re-acquire across retry.
4. **real-cloud** (per-driver gates above): authored + gated; conformance + provision/probe/destroy/
   hydrate-reconcile/over-spend. Not run in CI; runnable on demand with creds.

Commands: `cd ts && mise run tidy` (autofix), then `cd ts && mise run check` (typecheck + test +
lint) must pass for every layer except the gated live tests. Strict TDD: every task ships failing
tests first.

## 8. Task breakdown

Base tasks T0–T18 are fully specified (with per-test-case lists) in `/tmp/crabbox_wf1/plan.json` ->
`tasks` and `testMatrix`. Ordering note (correction to the raw plan): **T1 (domain) runs FIRST**
because the package's `types.ts` imports `BoxPoolProvider` from `@symphony/domain`. Cloud-driver
tasks are added:
- `Tc1` DockerBoxProvider + always-on fake-`docker` unit tests + gated live test.
- `Tc2` FlyBoxProvider + always-on fake-`flyctl`/HTTP unit tests + gated live test.
- `Tc3` E2BBoxProvider + always-on injected-client unit tests + gated live test.
- `Tc4` ModalBoxProvider + always-on injected-client unit tests + gated live test.
- `Tc5` Barrel-wire: a single agent adds all provider imports/exports + registrations to `index.ts`
  (avoids concurrent edits to the barrel).

Recommended implementation order: T1 -> T0 -> {T3,T4,T5,T7} -> T6 -> T8 -> T9 -> T10 -> T11 ->
T12 -> {Tc1,Tc2,Tc3,Tc4} -> Tc5 -> T13 -> T2 -> T14 -> T15 -> T16 -> T17 -> T18 -> final
`mise run tidy` + `mise run check`.

## 9. Edge cases (must all be handled + tested)

The exhaustive list (24 items) is in `/tmp/crabbox_wf1/plan.json` -> `edgeCases`. Headline items:
affinity not lost on bypass; awaitable drain (no cloud-box leak on SIGINT); pool never runs
workspace hooks (no double-fired `afterCreate`); `providerOptions` snake_case reaches the provider;
`no_capacity` recovers via `abandonClaim` not `finish` (no backoff churn); structured outcome
classification (not ssh-substring matching); reaper-vs-release coordinated by per-box mutex (no
`inFlight` underflow); ledger write-ahead + correlate; daily-spend persists + UTC reset; reservation-
based single-flight growth (can't exceed `max`); `cloneSettings` deep-copy; reaper timer `unref`;
`maxBoxesPerIssue` fairness; `maxInFlight=1` default (MCP-tunnel safety); lease-held window during a
hung `session.stop()` bounded by ttl/heartbeat/orphan-reap.

## 10. Resolved decisions (were open questions; defaults chosen)

- Cloud drivers to build: docker, fly, e2b, modal (all author + gate; no live cloud run).
- Cloud creds: not provided this round; live cloud tests authored + env-gated only.
- Provider enum: each cloud is its own `PROVIDER_KINDS` member (not a single `cloud` family).
- `maxBoxesPerIssue`: default undefined (uncapped); available for operators.
- Stall-as-poison: a stall-finished run poisons the box (recycle), since a stalled agent often
  leaves a box in a bad state.
- `drainDeadlineMs`: default 30s.
- `BoxPoolSnapshot` observability (TUI/HTTP) surfacing: deferred to a follow-up; `snapshot()` stays
  test-facing for now.
- Ledger + `spend.json` location: `<workspace.root>/.symphony/box-pool/`.
