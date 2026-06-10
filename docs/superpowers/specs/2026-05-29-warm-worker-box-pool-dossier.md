Confirmed: no crabbox material exists anywhere in the repo, and the CRABBOX finding was passed as `null`. I will synthesize the dossier from the three populated findings and explicitly flag the crabbox-lessons section as unverifiable.

---

# Warm Worker/Executor Box-Pool Dossier — Symphony TS Port

## 0. Provenance and scope note

This dossier synthesizes three populated research findings (SYMPHONY_INTERNALS, TEST_HARNESS, CONFIG_DOMAIN). The fourth input, **CRABBOX, was `null`** — no crabbox source code, design notes, or references exist anywhere in the worktree (verified: the only "crabbox" hits are the git worktree directory name `ryan--crabbox` itself). Therefore the requested "crabbox lessons to adopt vs drop" section cannot be grounded in any actual crabbox artifact and is reconstructed below from first principles plus the Symphony seams that any such pool must satisfy. **Treat the crabbox section as design guidance, not as a transcription of an existing crabbox implementation.** If a real crabbox spec exists elsewhere, it should be re-fed before final design lock.

All file:line references are relative to the `ts/` tree under `/Users/ryan/dev/symphony/.claude/worktrees/ryan--crabbox`.

---

## 1. The one-paragraph thesis

A warm box pool is the dynamic generalization of today's static `worker.sshHosts` list. The orchestrator already decides *where a run executes* at claim time and threads a single nullable string (`workerHost`) end-to-end; `null` means local, a non-null string means a remote SSH destination. A box pool slots in by (a) becoming the thing that *produces* that `workerHost` string (a leased box's address) instead of `selectLeastLoadedHost` picking from a fixed array, and (b) reporting "no capacity" through the existing `workerCapacityAvailable` / `worker_host_capacity` dispatch signal. The natural contract already exists, unused, as `WorkerHostPort.acquire(workerHost) -> WorkerHostLease{ workerHost, release() }` in `@symphony/ports`. The pool must be a long-lived singleton because config hot-reload swaps the whole `Settings` object every poll tick, so it reconciles on diff rather than being reconstructed.

---

## 2. The `workerHost` lifecycle (end to end)

`workerHost: string | null` is the single load-bearing value. Its meaning is invariant across every layer: **`null` => run locally; non-null string => remote SSH destination** (OpenSSH `user@host:port` form or a `~/.ssh/config` alias).

1. **Decision (claim time, by the orchestrator).** `Orchestrator.selectWorkerHost()` at `packages/orchestrator/src/index.ts:150-161` builds a `Map` of per-host running counts from `this.state.running`, then calls `selectLeastLoadedHost({ hosts: settings.worker.sshHosts, runningCounts, cap: worker.maxConcurrentAgentsPerHost ?? agent.maxConcurrentAgents })`. The policy (`packages/policies/src/workerHost.ts`) returns:
   - `null` when no hosts are configured (run locally),
   - a host string when some host is under cap,
   - `undefined` when every host is at capacity (dispatch is blocked).
2. **Stored on claim.** `Orchestrator.claim()` writes `workerHost` onto the `RunningEntry` (`orchestrator/src/index.ts:116-128`). `workerCapacityAvailable()` (`orchestrator/src/index.ts:163-166`) gates dispatch when the selection returned `undefined`.
3. **Runtime reads the claim.** `SymphonyRuntime.maybeDispatch` passes `claim.workerHost ?? null` into `runClaim` (`runtime/src/index.ts:391`); `runClaim` forwards it to `this.runner({ ..., workerHost, ... })` (`runtime/src/index.ts:419, 424-438`).
4. **Runner threads it through everything.** `runAgentAttempt` reads `input.workerHost ?? null` (`packages/agent-runner/src/index.ts:97`) and threads it into: `createWorkspaceForIssue` (98-102), `runHook` (105), `readResumeState` (108-113), `executor.startSession({ workerHost })` (139-149), and `persistResumeState` (165, 196).
5. **Executor launch branches on it.** Codex executor (`packages/codex/src/executor.ts:46, 54-61`) and ACP (`packages/acp/src/index.ts:67, 82`) branch local-vs-SSH on `workerHost`.

**Pool insertion point.** The clean seam is to (a) lease a box and surface its address as the `workerHost` string the orchestrator stores, and (b) make `workerCapacityAvailable` reflect pool acquire-ability. Two viable shapes:
- *Minimal*: keep `selectWorkerHost` but feed it the pool's currently-leasable box addresses instead of static `sshHosts`, and acquire/release the lease around the run inside the runner (where `workerHost`/`sshTimeoutMs` are consumed, `agent-runner/src/index.ts:90+`).
- *Cleaner long-term*: implement the dormant `WorkerHostPort` lease contract and have the runtime acquire before dispatch / release in the run's `finally`.

Retry and ensemble affinity matter: `RetryEntry` carries `workerHost`/`workspacePath` (`domain/src/index.ts:462-475`) so retries reclaim the same box. The pool must support **sticky re-acquire** keyed on a prior lease, not just round-robin allocation. `ensemble:<n>` labels expand parallel slots (`Issue`, `domain/src/index.ts:93-119`), each needing its own box.

---

## 3. Workspace, agent launch, hooks, and SSH plumbing the pool sits on top of

- **Workspace creation** is single-entry at `@symphony/workspace.createWorkspaceForIssue` (`packages/workspace/src/index.ts:25-51`), branching on `workerHost` (line 30-31): set => `createRemoteWorkspaceForIssue` (SSH); unset => local `fs.mkdir` under `settings.workspace.root` with symlink rejection and `validateWorkspaceCwd` hardening. Remote path resolves `workspace.rootExpression ?? root`, expanding a leading `~` via `printf %s $HOME` over SSH, builds a bash `mkdir -p` script that prints a `__SYMPHONY_WORKSPACE__` marker line (`workspace/src/index.ts:8, 271-290`), and canonicalizes/validates inside `root` (`303-334`). **Timeout caveat to carry into the pool:** workspace *creation* and hooks use `settings.hooks.timeoutMs`, while home-lookup, validation, and resume-state I/O use `settings.worker.sshTimeoutMs`. A pool warming step that pre-creates workspaces must pick the right timeout deliberately.
- **Hooks** (`HooksSettings`, `domain/src/index.ts:317-340`): `afterCreate` / `beforeRun` / `afterRun` / `beforeRemove` run via `bash -lc` locally or over SSH (`workspace/src/index.ts:154-172, 336-348`). `afterCreate` is the obvious **warm-provisioning** surface (a warm box pre-runs `afterCreate`); `beforeRemove` is the **teardown** surface for reaping. `beforeRun` runs in the runner *before* the executor session (`agent-runner/src/index.ts:104-106`); `afterRun` runs best-effort in the `finally` (181-193).
- **Agent launch.** Codex (`codex/src/executor.ts:54-61`): remote => `new CodexProcess(startSshProcess(host, "cd <ws> && ${settings.codex.command}"))`, local => `new CodexProcess(settings.codex.command, workspace)`. ACP (`acp/src/index.ts:475-493`): remote => `startSshProcess(host, "cd <ws> && exec <bridge>")`, plus a **reverse MCP tunnel** via `acquireAgentMcpEndpoint(settings, workerHost)` (`acp/src/index.ts:81`) and capability narrowing via `clientCapabilities(workerHost)` (517-526, disables local-fs caps when remote).
- **SSH command construction.** `startSshProcess` (`packages/ssh/src/index.ts:82-89`) spawns `ssh -T ... bash -lc <cmd>`. `sshArgs` (`ssh/src/index.ts:121-130`) emits `[-F $SYMPHONY_SSH_CONFIG] -T [-p port] destination bash -lc <escaped>`; `parseSshTarget` (160-168) splits `host:port`. `runSsh` enforces an `invalid_ssh_timeout` guard (`ssh/src/index.ts:32-33`). The `SYMPHONY_SSH_CONFIG` env var is the universal `-F` injection point — relevant for both pool boxes and tests.
- **Cleanup and resume.** Workspace teardown is best-effort via `removeIssueWorkspaces` (`workspace/src/index.ts:109-138`), called on startup sweep (`runtime/src/index.ts:662-679`) and reconciliation (`534-599`). Resume state lives at `.git/symphony/resume.json` (`@symphony/resume-state`), keyed on `workerHost` so a `workerHost` mismatch discards the resume id — meaning **a box change between attempts invalidates resume continuity by design**. Generation-scoped `ActiveRunHandle` (`runtime/src/index.ts:191-220`, commit 8a8b89a) guards every state mutation with `if (!handle.isActive) return` so a stale late-resolving run cannot clobber a newer run in the same slot; `release()` only deletes the map entry if it is still the active handle.

---

## 4. The two adapter seams (and which one the pool uses)

There are **two** seams. Do not confuse them.

1. **Agent-runner adapter seam — the real, active production injection point.** `interface RunAgentAttemptAdapters` (`agent-runner/src/index.ts:31-59`): `createWorkspaceForIssue`, `runHook`, `readResumeState`, `resumeStateMatches`, `writeResumeState`, `executorFactory`. Each resolves lazily and throws `agent_runner_adapter_missing: <name>` if absent. Wired in `apps/cli/src/daemon.ts:41-56` (`createRunAgentAttemptAdapters()`), with `executorFactory` returning `CodexAppServerExecutor` (executor `"appserver"`) or `AcpExecutor` (executor `"acp"`).
2. **Runtime-level injected functions.** `SymphonyRuntimeOptions` (`runtime/src/index.ts:160-179`): `removeIssueWorkspaces`, `deleteResumeState`, `appendLogEvent`. Wired in `daemon.ts:65-69`, spread into `SymphonyRuntime` in `apps/cli/src/main.ts:117-123`; called via private wrappers that throw `runtime_adapter_missing: <name>`.
3. **`@symphony/ports` — the dormant abstraction.** `packages/ports/src/index.ts` declares `TrackerPort`, `AgentExecutorPort`, `WorkspacePort`, `McpPort`, `LogSinkPort`, `ClockPort`, `RemoteShellPort`, and crucially `WorkerHostPort { acquire(workerHost): Promise<WorkerHostLease> }` + `WorkerHostLease { workerHost; release(): Promise<void> }` (`ports/src/index.ts:50-57`). **This acquire/release lease shape is the natural box-pool contract** but is currently NOT referenced by runtime/agent-runner (those use function-injection). `systemClock` is the only concrete export (39-43).

**Recommendation for an embedded pool:** adopt the `WorkerHostPort`/`WorkerHostLease` shape as the pool's public interface (it already names the right operations), but wire it through the *function-injection style the runtime actually uses* — i.e., inject pool `acquire`/`release` as runtime-level functions or fold them into the existing adapters, rather than retrofitting the whole `ports` DI scheme. The pool is acquired *before* an executor launches and released in the run's `finally`; the existing reverse-MCP tunnel (`acquireAgentMcpEndpoint`) remains a downstream detail acquired *after* a box is leased.

**Do not extend `@symphony/worker-host-pool`.** Despite the name, `packages/worker-host-pool/src/index.ts` is today **only a reverse-SSH MCP tunnel pool**: `class WorkerHostPool` keyed by `workerHost` holds `RemoteMcpTunnelEntry { remotePort, localHost, localPort, process, refCount, exited }`, ref-counts `ssh -R` tunnels via `@symphony/ssh.startReverseTunnel`, allocates remote ports from `nextRemoteMcpPort` (base 46000, with a recycled free list), and is consumed solely by `@symphony/mcp agentEndpoint.ts`. A warm *box* pool (which host/container a run lands on) is a different concern — **add a sibling package** (e.g. `@symphony/worker-box-pool`); the tunnel pool stays a layer below it.

---

## 5. The config slot

**Where it lives.** `worker.*` maps 1:1 to `WorkerSettings` (`domain/src/index.ts:164-178`): `sshHosts: string[]` (empty => local), `sshTimeoutMs: number`, `maxConcurrentAgentsPerHost?: number`. Recommended placement for the pool is **nested under `worker` as `worker.boxPool`**, beside those fields, because dispatch already routes capacity through `worker_host_capacity` and a box pool is the same "where runs execute" concern. (`maxConcurrentAgentsPerHost` is the per-host analog of a per-box `maxInFlight`.) The alternative — a top-level `boxPool:` block parallel to `worker:`/`agent:` — is cleaner only if the pool is meant to be provider-orthogonal to SSH.

**How config is parsed (carry these conventions exactly).** Config is **manual zod-shape + hand-written value coercion**, not one end-to-end zod model (`packages/config/src/index.ts`):
- Structural zod (`workerRawSchema`, `config:71-77`) makes every field `z.unknown().optional()` inside `.strict()` objects — unknown keys throw `contains unsupported keys`; the root `workflowConfigSchema` (143-162) is `.passthrough()` at top level but each sub-block is `.strict()`.
- Value coercion lives in `parseConfig` (`config:306-380`) using helpers: `positiveInt` (`config:1009`, integer > 0 else `<label> must be a positive integer`), `nonNegativeInt` (1017), `nonNegativeIntWithFallback` (1024), `booleanValue` (1029), `stringValue` (942), `stringArray` (995), `optionalString` (988), `numberValue` (1088).
- Worker parse: `config:334-348` (`sshHosts` via `stringArray`; `sshTimeoutMs` via `positiveInt(..., "worker.ssh_timeout_ms")`; `maxConcurrentAgentsPerHost` via `positiveInt(..., "worker.max_concurrent_agents_per_host")` only when present).
- Defaults (`defaultSettings()`, `config:239-304`): `worker: { sshHosts: [], sshTimeoutMs: 60_000 }` at `config:283`. `maxConcurrentAgentsPerHost` is intentionally absent (undefined => global cap applies per host).
- snake_case->camelCase is a separate concern: `workerAliases` (`config:186-190`) maps `ssh_hosts`/`ssh_timeout_ms`/`max_concurrent_agents_per_host`; applied by `normalizeNested(..., "worker", workerAliases)` (`config:885`) inside the zod preprocess step.
- `cloneSettings` (`config:785-802`) deep-copies the worker block (`{ ...worker, sshHosts: [...worker.sshHosts] }`) — a pool sub-object must be added to this clone or it will alias across reloads.

**Wiring slots to extend for `worker.boxPool`:**
- *Domain* (`domain/src/index.ts`): add a `BoxPoolSettings` interface and `boxPool?: BoxPoolSettings` to `WorkerSettings` (164-178); add `PROVIDER_KINDS = [...] as const` + derived `BoxPoolProvider` type near `TRACKER_KINDS` (`domain:15`), mirroring the `as const` + derived-type pattern.
- *Config schema*: add a nested `.strict()` `boxPool` to `workerRawSchema`; add `boxPoolAliases` and extend the `normalizeNested` call; add a `parseBoxPool()` invoked from the worker section of `parseConfig`; seed defaults in `defaultSettings` worker block; extend `cloneSettings`.
- *Validation*: keep labels prefixed `worker.box_pool.*` so messages match YAML keys (e.g. `worker.box_pool.max must be a positive integer`). Note `validateDispatchConfig` (`config:398-423`) validates only tracker/agent backends — worker fields are enforced at parse time via the helpers and at runtime via `runSsh`'s timeout guard. A pool should follow the same "validate at parse time" convention.
- *Backward compatibility*: default `enabled: false` so existing local and `sshHosts` paths are untouched.

**Front matter and hot reload (the critical operational constraint).** `WORKFLOW.md` is YAML front matter + Liquid template (`packages/workflow/src/index.ts:55-83`); current file has `worker:\n  ssh_timeout_ms: 60000` (`WORKFLOW.md:24-25`); `WORKFLOW_FULL_ACCESS.md` omits `worker:` (local-only). There is **no fs.watch** — reload is poll-driven: `reloadWorkflowIfConfigured` (`runtime/src/index.ts:519-532`) runs at the **top of every poll tick** (`runtime:329`, cadence `polling.intervalMs`, default 5000ms). On success it swaps `this.input.workflow`, sets `this.orchestrator.settings = workflow.settings`, optionally rebuilds the tracker, emits `workflow_reloaded`; on failure it emits `workflow_reload_failed` and **keeps last-good settings**. The whole `Settings` object is replaced each tick.

**Implication (non-negotiable for the design):** the pool must be a **long-lived singleton that diffs prev-vs-next `boxPool` settings on each reload and reconciles** (resize toward min/max, re-warm, adjust caps, reap) — it must not be reconstructed per reload, and it must not assume immutability. Per-issue effective settings additionally layer `statusOverrides` via `settingsForIssueState` (`config:387`).

A reasonable proposed key set (all under `worker.box_pool`, snake_case in YAML): `enabled` (bool, default false), `provider` (enum, default `local`), `min`/`max`/`warm` (box counts; `min`=floor kept alive, `warm`=pre-acquired-ready subset, `max`=hard ceiling), `ttl_ms` (forced recycle lifetime), `idle_reap_ms` (idle teardown above `min`, runs `beforeRemove`), `max_in_flight` (concurrent runs per box, per-box analog of `maxConcurrentAgentsPerHost`), `acquire_timeout_ms` (how long dispatch waits before reporting `worker_host_capacity`), and a nested `spend` block (`max_concurrent_boxes`, `max_box_seconds`, `daily_box_seconds`). Keep spend in **seconds** for consistency with `UsageTotals.secondsRunning` (`domain:509`), even though `ttl_ms`/`idle_reap_ms` are milliseconds. Pool sizing must stay coherent with `agent.maxConcurrentAgents` (`domain:187`) — global concurrency cap is enforced *before* worker capacity. Open product decisions: `min`/`max`/`warm` vs a single fixed `size` (treat `size` as `min==max`); the exact `provider` enum membership (`local`/`ssh`/`docker`/`firecracker`/…); and whether `boxPool` nests under `worker` (recommended) or stands as a top-level block.

**Dispatch integration.** The pool reports capacity into `shouldDispatchIssue`/`dispatchBlockReason` via `state.workerCapacityAvailable` (`packages/dispatch/src/index.ts:66`), so "no box within `acquire_timeout_ms`" or "over spend cap" surfaces as the existing `worker_host_capacity` reason (`DispatchBlockReason`, `domain:483-486`; `DispatchBlockEntry`, `domain:492-499`). A leased box id maps onto `RunningEntry.workerHost` (`domain:526`) and `RetryEntry.workerHost` (`domain:473`) for sticky retry re-acquire.

---

## 6. Test layering (how to prove a pool without cloud)

Runner: **Vitest 4.x**, single root config `ts/vitest.config.ts`, pnpm workspace (33 `@symphony/*` packages + `apps/cli`), `sequence.concurrent: false` (serial), `testTimeout: 30_000` (live tests override up to 900_000ms). No per-package config; every package's `test/` dir is collected by the one root config. Tests import compiled `.js` (the `mise test` task `depends = ["build"]`, so `tsc --build` runs first). No coverage gate. Node 24 / pnpm 9 pinned via `ts/mise.toml`.

There are **four test layers**; a box pool should be exercised across the first two for CI and the third for confidence:

1. **local-fakes (always-on, ungated; the `mise run check` / `pnpm test` default).** Runs on every PR (`.github/workflows/make-all.yml` job `ts-mise-check`). Three fake styles, all hitting **real production code paths** (no mock framework on hot paths):
   - **PATH-shim fake binaries** (dominant pattern): `writeExecutable(path, source)` (`ts/test/helpers.ts:9-13`, chmod 0o755) + prepend its dir to `process.env.PATH`, so production code that spawns `ssh`/`codex`/`claude-agent-acp` picks up the fake. Notable: a fake `ssh` shim asserting arg construction / stderr folding / `ENOENT->ssh_not_found` / timeout (`packages/ssh/test/ssh.test.ts:116-122`); and crucially **`installEvalSsh`** (`ts/test/workspace-prompt-resume.test.ts:668-689`) — an `ssh` shim that intercepts the `$HOME` probe and otherwise `export HOME=<tmp>; eval "$last_arg"`, executing the **full remote-workspace create/remove/hooks code path locally as if over SSH, with zero daemon**. This is the recommended fast "fake SSH transport" for proving pool warm/teardown and remote workspace lifecycle in always-on CI.
   - **MSW HTTP fakes** for the Linear GraphQL API (`ts/test/fake-linear-server.ts`, `createFakeLinearHandlers`).
   - **In-process fake port objects (DI)** for pure orchestration (`packages/agent-runner/test/agent-runner.test.ts:1-78` builds `fakeAdapters` implementing `RunAgentAttemptAdapters`). **This is exactly where a fake pool `acquire`/`release` belongs** — inject a fake `WorkerHostLease` and assert ordering, sticky retry re-acquire, and release-on-`finally`.
   - **Property tests** via `fast-check` v4: 8 `*-props.test.ts` suites, shared arbitraries in `ts/test/arbitraries.ts`. There is already a `packages/policies/test/workerHost-props` suite — a pool's sizing/eviction invariants (e.g. never exceed `max`, never drop below `min`, monotonic spend accounting) are a natural fit here.
   - Custom assert helper `ts/test/assert.ts` wraps Vitest `expect` into a node:assert-style API; tests import `../../../test/assert.js`.

2. **loopback-ssh (real local sshd, single machine).** Gate `SYMPHONY_TS_RUN_LIVE_SSH_E2E=1` -> `pnpm test:live:ssh` (`ts/test/live-ssh.test.ts`). `setupNativeSshdWorker` (`live-ssh.test.ts:195-294`) auto-selects when `SYMPHONY_LIVE_SSH_WORKER_HOSTS` is unset and `/usr/sbin/sshd` + `ssh-keygen` exist (confirmed present on this macOS box). It generates ed25519 host+client keys, reserves a free loopback port, writes a temp `sshd_config`/`ssh_config`, points `SYMPHONY_SSH_CONFIG` at the client config (the exact `-F` var `sshArgs` reads), validates with `sshd -t`, starts its own daemon, and polls readiness via `vi.waitFor(runSsh(host,"printf ready"))`. It does **not** depend on the machine's SSH server being enabled. **Reuse this verbatim** for a pool's real-SSH box proof — do not invent a new loopback runner.

3. **real-ssh-host (BYO remote/docker workers).** Same gate plus `SYMPHONY_LIVE_SSH_WORKER_HOSTS=host1[:port],host2` or the docker-compose fallback (`elixir/test/support/live_e2e_docker/`, node:20 + openssh + global codex/claude, two worker containers). Proves multi-host pool over genuine network SSH, per-host workspace isolation, and resume continuity on a real remote FS. This is the layer that proves **multi-box** allocation.

4. **real-cloud (live Linear + hosted Codex/Claude).** Per-service gates via `pnpm test:live` (codex, codex-resume, linear-codex, claude; SSH separate). Never in default CI.

Live tests follow the convention: `const runLive = process.env.GATE === "1"` then `test("...", { timeout: N, skip: !runLive }, ...)` — collected but skipped without the gate. Key commands: `cd ts && mise run check` (the CI gate: typecheck + test + lint), `mise run tidy` (format + lint autofix), `pnpm exec vitest run packages/<pkg>` (single package), `pnpm test:live:ssh` (loopback/BYO SSH).

**Recommended pool test plan:** unit + property in always-on layer with a fake `WorkerHostLease`; remote workspace warm/teardown via `installEvalSsh`; real `acquire`/`release` over a real daemon gated behind `setupNativeSshdWorker`; multi-box behind BYO/docker.

---

## 7. Crabbox lessons — adopt vs drop (UNVERIFIED; CRABBOX input was null)

No crabbox artifact exists in the repo, so the following is **derived guidance**, framed as the constraints any embedded (non-CLI, non-broker) pool must satisfy given Symphony's seams. It is not a transcription of a real crabbox design. Re-feed an actual crabbox spec if one exists.

**Adopt (these align with Symphony's existing contracts):**
- **Acquire/lease/release with a typed lease object.** Symphony already names this exactly: `WorkerHostPort.acquire -> WorkerHostLease{ workerHost, release() }` (`ports/src/index.ts:50-57`). Adopt this shape as the pool's public surface.
- **Warm via `afterCreate`, reap via `beforeRemove`.** Reuse the existing hooks surface rather than inventing a provisioning DSL; warming a box = pre-running `afterCreate`.
- **A box id that *is* the `workerHost` string.** This keeps the entire downstream pipeline (workspace, executor, resume, retry, cleanup) unchanged because everything already keys on that nullable string.
- **Sticky re-acquire for retries/ensemble slots.** `RetryEntry.workerHost` already expects the same box on retry; resume continuity depends on `workerHost` identity matching.
- **Report capacity through `workerCapacityAvailable` / `worker_host_capacity`.** Do not add a new dispatch block reason.
- **Diff-and-reconcile on config reload.** Mandatory given poll-driven whole-`Settings` swap.

**Drop / avoid (anti-patterns for an embedded pool):**
- **A separate broker process or CLI front-end.** The requirement is *embedded*; the pool is a singleton object inside the daemon process, injected through the runner/runtime adapters — no IPC, no separate binary, no socket protocol. Anything in a crabbox design that assumes a standalone broker should be dropped.
- **Extending `@symphony/worker-host-pool`.** That package is the reverse-MCP-tunnel pool; folding box allocation into it conflates two concerns. Add a sibling `@symphony/worker-box-pool`.
- **Reconstructing the pool per reload or assuming immutable config.** Fatal given the poll-tick `Settings` swap.
- **A bespoke DI/ports framework just for the pool.** The runtime uses function-injection, not the `ports` scheme; match the active style.
- **Mixing time units.** Keep spend caps in seconds (to match `UsageTotals.secondsRunning`), durations in ms, and never reuse `hooks.timeoutMs` where `worker.sshTimeoutMs` is meant (or vice versa) — the existing code already has this exact split.
- **Cross-box resume assumptions.** Resume state is `workerHost`-keyed; a box swap between attempts intentionally discards the resume id. A crabbox design that assumes portable/global resume state across boxes should be dropped.

---

## 8. Key file:line index (for the designer)

- `workerHost` decision: `packages/orchestrator/src/index.ts:150-161` (`selectWorkerHost`), policy `packages/policies/src/workerHost.ts`; claim store 116-128; capacity gate 163-166.
- Runtime threading: `packages/runtime/src/index.ts:391, 419, 424-438`; reload `519-532` (top-of-tick `329`); `ActiveRunHandle` `191-220`.
- Runner: `packages/agent-runner/src/index.ts:97` (workerHost), `90+` (acquire/release site), `104-106` (beforeRun), `181-193` (afterRun finally), `252-277` (persistResumeState), adapter interface `31-59`.
- Workspace: `packages/workspace/src/index.ts:25-51`, remote `256-301`, marker const `:8`, cleanup `109-138`.
- Executors: Codex `packages/codex/src/executor.ts:54-61`; ACP `packages/acp/src/index.ts:81, 475-493, 517-526`.
- SSH: `packages/ssh/src/index.ts:82-89, 121-130, 160-168`, timeout guard `32-33`.
- Ports (lease contract): `packages/ports/src/index.ts:50-57`.
- Tunnel pool (do not extend): `packages/worker-host-pool/src/index.ts`.
- Domain types: `packages/domain/src/index.ts` — `WorkerSettings:164-178`, `Settings:362-389`, `AgentSettings:183-197`, `DispatchBlockReason:483-486`, `RunningEntry:516-552`, `RetryEntry:462-475`, `HooksSettings:317-340`, `TRACKER_KINDS:15`.
- Config: `packages/config/src/index.ts` — `workerRawSchema:71-77`, root `143-162`, `parseConfig:306-380`, worker parse `334-348`, defaults `283`, aliases `186-190`/`885`, helpers `942-1088`, clone `785-802`.
- Dispatch capacity: `packages/dispatch/src/index.ts:66`.
- Wiring: `apps/cli/src/daemon.ts:41-69`, `apps/cli/src/main.ts:103-123`.
- Tests: `ts/vitest.config.ts`; `ts/test/helpers.ts:9-13`; `installEvalSsh` `ts/test/workspace-prompt-resume.test.ts:668-689`; fake ssh `packages/ssh/test/ssh.test.ts:116-122`; fake adapters `packages/agent-runner/test/agent-runner.test.ts:1-78`; loopback sshd `ts/test/live-ssh.test.ts:195-294`; gate `:24`.

**Top constraints to not forget:** (1) `workerHost` `null`=local / string=remote is invariant — make the pool produce that string; (2) report capacity only through `worker_host_capacity`; (3) the pool is a reload-surviving singleton that diffs-and-reconciles; (4) resume/retry are `workerHost`-keyed so support sticky re-acquire; (5) warm/teardown reuse `afterCreate`/`beforeRemove`; (6) build sibling package, not an extension of the tunnel pool; (7) embedded = no broker/CLI, inject via existing function-injection adapters; (8) the crabbox lessons section is UNVERIFIED because the CRABBOX input was null.
