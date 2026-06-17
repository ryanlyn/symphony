# Roadmap

What Lorenz does not do today, what is reserved but unwired, and what the spec still treats as optional or future work. For evaluators and contributors deciding how far Lorenz reaches. Everything below is direction, not commitment, and none of it is a shipped feature.

Read it against two sources of truth: [architecture.md](../architecture.md) describes what the code does today, and [reference/spec.md](../reference/spec.md) is the language-agnostic contract (`SPEC.md`, "Draft v1"). Where the spec and the code disagree, the code wins and the gap is called out below.

## Explicit non-goals

`SPEC.md` Section 2.2 lists what Lorenz deliberately does not try to be. These are scope decisions, not missing features:

- No rich web UI or multi-tenant control plane. The dashboard and TUI are operator views over a single daemon, not a hosted product.
- No prescribed dashboard or terminal UI implementation. The spec mandates structured logs as the observability floor and leaves the rest open.
- No general-purpose workflow engine or distributed job scheduler. Lorenz polls a tracker and runs one agent per eligible issue; it is not a DAG runner.
- No built-in business logic for editing tickets, PRs, or comments. That logic lives in the workflow prompt (`WORKFLOW.md`) and the agent's tools, not in the orchestrator.
- No mandated sandbox, approval, or operator-confirmation posture. The spec requires each implementation to document its trust and safety stance (see [security.md](../security.md)) but does not impose one.

If you need a multi-tenant control plane or a generic scheduler, Lorenz is the wrong layer. It is a per-issue runner with a tracker reader in front.

## Spec items still marked optional or TODO

`SPEC.md` Section 18.2 separates required conformance from recommended extensions. Some items there are explicit `TODO`s the spec author left open:

| Spec TODO (18.2) | State in code today |
| --- | --- |
| Persist retry queue and session metadata across process restarts | Not done. Recovery is in-memory by design (Section 14.3): no retry timers or running sessions survive a restart. Recovery is startup terminal-workspace cleanup, a fresh poll, and re-dispatch. There is no durable orchestrator database. |
| First-class tracker write APIs (comments, state transitions) in the orchestrator | Not done. Ticket writes happen through the agent's `tracker_*` tool pack, not the orchestrator. See [reference/tracker-tools.md](../reference/tracker-tools.md). |
| Pluggable issue tracker adapters beyond Linear | Already shipped, ahead of the spec. The code ships a `TrackerProvider` / `TrackerRegistry` extension system with `linear`, `jira`, `local`, `slack`, and `memory` trackers. The spec TODO is stale. |

The durable-restart TODO is the one real gap. A daemon restart drops queued retries and any in-flight session; the orchestrator rebuilds its picture from the tracker on the next poll. If your evaluation depends on surviving a crash mid-run without re-deriving state, that is not present.

Section 18.2 also lists optional extensions that exist as code today but the spec does not require: context ensembles (`agent.ensemble_size`, `ensemble:<n>` labels, per-slot workspaces), per-state `status_overrides`, an SSH worker profile honoring `worker.ssh_hosts` and `worker.ssh_timeout_ms`, and the HTTP server gated on `server.port`. These ship, but a conformant implementation may omit them.

## Reserved vocabulary that is unwired

Some identifiers exist in the type system but are never produced by the running code. They hold space for designs that are not built. Treat them as not present:

- `WorkerState` includes `WARMING` and `DRAINING` (`packages/worker-pool/src/types.ts`). Neither is ever assigned by the current pool. They reserve space for an async warm-up phase and a per-worker drain that do not exist. The states the pool actually uses are `PROVISIONING`, `WARM_IDLE`, `LEASED`, `DEGRADED`, `DESTROYING`, and `DESTROYED`.
- `worker.worker_pool.max_in_flight` (internal `maxInFlight`) is deprecated. It parses as a read-only alias of `slotsPerMachine` and cannot drift from it. Co-residence (more than one run per machine) additionally requires an explicit `worker.worker_pool.co_residence: true` opt-in plus a runtime per-run-endpoint capability. See [workers/worker-pool.md](../workers/worker-pool.md).

## Additional worker drivers

The worker subsystem is built so a new backend is one package plus one registration. The `WorkerDriver` / `WorkerDriverFactory` contract lives in `@lorenz/worker-sdk`, drivers resolve through a `WorkerDriverRegistry` keyed on `worker.worker_pool.driver`, and out-of-tree modules load by specifier behind a `WORKER_DRIVER_SDK_VERSION` (currently `1`) handshake. See [extensions/worker-driver.md](../extensions/worker-driver.md) and [extensions/out-of-tree.md](../extensions/out-of-tree.md).

Three drivers ship today:

- `fake` - in-memory, in the SDK (`packages/worker-sdk/src/fake.ts`).
- `static-ssh` - fixed host list, `@lorenz/static-worker`.
- `docker` - disposable containers, `extensions/docker-worker`.

Cloud drivers for providers like Fly, e2b, or Modal fit this contract but do not exist as code. There is no `fly-worker`, `e2b-worker`, or `modal-worker` package. If you need one, it is an extension you write against `@lorenz/worker-sdk`, not a flag you turn on. The conformance suite (`@lorenz/worker-sdk/conformance`) gives a new driver its acceptance tests, and an out-of-tree cloud driver keys against the SDK version handshake.

## Open design areas in the warm worker pool

The warm worker pool (`@lorenz/worker-pool`) is the most active design surface. Several decisions are parked at their current shape rather than finalized:

- **Heartbeat-based reclaim.** `isRunActive` is wired to the constant `true` in the live pool, so the reaper never force-returns a leased worker. A long single-turn run with no heartbeat is never killed mid-run. The `false` branch and the `staleHeartbeatMs` config (`worker.worker_pool.stale_heartbeat_ms`, default `600000`) exist for the eventual reclaim path and for unit tests, but the live pool does not act on them. Cross-restart orphans are recovered only by `hydrate`.
- **Async warm-up.** The `WARMING` state above is the placeholder for provisioning a warm worker without blocking, which the current synchronous warm top-up does not do.
- **Per-worker drain.** `DRAINING` reserves the per-worker counterpart to the pool-wide `drain()` barrier, which today force-destroys every worker at once after a deadline.
- **Daily spend durability.** Daily worker-seconds are recorded fire-and-forget on the hot path and only flushed absolutely on a clean drain (to a `spend.json` sidecar). A crash can lose the last few unpersisted deltas. The lifetime and concurrency caps (`worker.worker_pool.spend.max_worker_seconds`, `.max_concurrent_workers`) are exact; the daily cap can undercount across a crash.

These are direction notes, not promises. The pool's shipped behavior - leasing, the FIFO waiter queue, the serial reaper, the write-ahead ledger, and crash recovery via `hydrate` - is documented in [workers/worker-pool.md](../workers/worker-pool.md).

## Where the spec describes something the code replaced

`SPEC.md` is "Draft v1" and predates parts of the implementation. These sections describe a design the code has moved past. Read them as historical context, not the runtime contract:

| `SPEC.md` describes | Code today |
| --- | --- |
| A Codex app-server JSON-RPC protocol (`thread/start`, `turn/start`, `codex app-server`) in Section 10 | An ACP executor (`@lorenz/acp`, `acpExecutorProvider`, executor selector `acp`) driven through `agents.<kind>.executor`. |
| `agent.kind` (`codex` or `claude`) with top-level `codex:` / `claude:` blocks (5.3.6 to 5.3.8) | `Settings.agents` is an open record. `codex:` / `claude:` are parse-time sugar merged into `agents.<name>`; executors are selected by `agents.<kind>.executor`. |
| An optional `linear_graphql` client-side tool | A provider-neutral `tracker` pack with seven tools: `tracker_read_issue`, `tracker_query`, `tracker_update_status`, `tracker_list_comments`, `tracker_comment`, `tracker_update_comment`, `tracker_create_issue`. |
| Codex-flavored event names (`session_started`, `turn_completed`) in 10.4 | Orchestrator-level `RUNTIME_EVENT_TYPES` such as `run_started`, `run_completed`, `run_reconciled`, `run_stalled`, `dispatch_skipped`, `workflow_reloaded`. See [reference/events.md](../reference/events.md). |

`reference/spec.md` carries the full drift map. For an evaluator: the spec is where you learn the contract's intent, but it overstates the Codex coupling and understates the tracker plurality the code already has.

## See also

- [architecture.md](../architecture.md) - what the code does today, the layer the roadmap is measured against.
- [reference/spec.md](../reference/spec.md) - the `SPEC.md` contract and its full drift map versus the code.
- [workers/worker-pool.md](../workers/worker-pool.md) - the shipped warm-pool behavior the open design areas extend.
- [extensions/worker-driver.md](../extensions/worker-driver.md) - the contract a cloud worker driver would implement.
- [security.md](../security.md) - the trust and safety posture the spec leaves to each deployment.
