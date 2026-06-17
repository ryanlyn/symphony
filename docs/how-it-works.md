# How Lorenz works

This page is a concept-first walkthrough for anyone deciding whether to run or evaluate Lorenz. It
covers the end-to-end loop, what a `WORKFLOW.md` is, how agents run inside per-issue workspaces, and
why there is no database. For the mechanics behind each step, follow the links to
[agent-orchestrator.md](agent-orchestrator.md) and [dispatch.md](dispatch.md).

Lorenz derives from [OpenAI's Symphony orchestrator](https://github.com/openai/symphony),
reimplemented in TypeScript. That is the one lineage note worth carrying; everything below describes
what Lorenz is today.

## The core loop

Lorenz turns tracker issues into agent runs. It watches a tracker (Linear, Jira, a local board,
Slack) for issues in active states, and for each eligible issue it prepares a workspace, renders a
prompt, and runs a coding agent inside that workspace. It keeps doing this on a fixed cadence until
the issue reaches a terminal state.

There is one control-plane process. It holds a single authoritative in-memory view of everything in
flight (which issues are running, reserved, retrying, or blocked) and feeds that same view to every
dashboard. Each issue gets its own filesystem workspace. Each agent run is one ACP session driving
either Codex or Claude.

<p align="center"><img src="assets/diagrams/system-overview.svg" alt="system overview diagram" width="960" style="width:100%;max-width:960px;height:auto" /></p>
*The control plane polls the tracker, dispatches eligible issues into per-issue workspaces, and runs Codex or Claude over ACP while streaming one snapshot to the dashboards.*

The loop runs at `polling.interval_ms` (default 30000). On each tick the runtime reloads the
workflow, reconciles what is already in flight against the tracker, fetches candidate issues,
computes which are eligible, and dispatches them. Each dispatched issue runs as its own detached
promise, so a slow agent run never stalls the poll loop. The next section walks one tick in order.

## One poll tick, step by step

A tick is driven by `LorenzRuntime.pollOnce`. It runs the following in this order:

1. **Reload the workflow.** If `WORKFLOW.md` changed on disk, reload its config transactionally. A
   bad edit keeps the last-known-good config and emits `workflow_reload_failed`; a good edit emits
   `workflow_reloaded`.
2. **Validate dispatch config.** If validation throws, the whole tick aborts (recorded as
   `poll_error`) and no reconciliation or dispatch happens that tick.
3. **Clean up terminal workspaces once.** On the first tick only, list workspaces on disk, fetch
   just those issue ids, and remove the ones whose issues are already terminal.
4. **Reconcile stalled runs.** For each running entry, if time since its last agent event exceeds
   the effective `agents.<kind>.stall_timeout_ms`, finish it as a failure and record a `stalled`
   outcome.
5. **Reconcile tracked issues.** Re-fetch every reserving, running, and retrying issue. If it is
   still active, routed here, and unblocked, refresh its in-memory state; otherwise stop the run and
   clean up. Terminal issues get their workspace removed.
6. **Fetch candidates.** Ask the tracker for issues in active states.
7. **Compute eligibility.** The orchestrator sorts candidates deterministically and filters them.
8. **Sync retry timers** for issues with pending retries (skipped on a dry run).
9. **Dispatch** each eligible issue, or emit a `dry_run` event in dry-run mode.

<p align="center"><img src="assets/diagrams/poll-tick.svg" alt="poll tick diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*One poll tick: reload, validate, reconcile what is in flight, fetch candidates, filter to the eligible set, then dispatch.*

Eligibility is a pure decision. An issue dispatches when its state is active and not terminal, it is
routed to this worker, it has no open blockers (checked only for `unstarted` issues), and a
concurrency cap does not block it. Caps apply in order: the global `agent.max_concurrent_agents`
(default 10), then a per-state cap from `status_overrides`, then worker-host capacity. The dispatch
order is total and deterministic: priority ascending, then `createdAt` ascending, then identifier by
locale compare. The full decision tree lives in [dispatch.md](dispatch.md).

## WORKFLOW.md is config plus prompt

One file defines both how Lorenz is configured and what it tells the agent. `WORKFLOW.md` has YAML
front matter (the orchestrator config: tracker, agents, workspace, polling, workers) and a Markdown
body (the agent session prompt). The body is a Liquid template rendered with the issue's fields, so
the prompt the agent receives is specific to the issue it is working on.

Editing `WORKFLOW.md` while Lorenz runs reloads the config on the next tick. No restart. The reload
is transactional: side effects that can fail run first, and the live config swaps in only if they all
succeed, so a typo never takes down a running deployment. See
[workflows.md](workflows.md) and the
[workflow + prompt reference](reference/workflow-prompt.md) for the full schema.

## Per-issue workspaces

Every issue runs in its own directory under `workspace.root` (default
`<tmpdir>/lorenz_workspaces`), named after a sanitized form of the issue identifier. The workspace is
created on first dispatch and removed when the issue goes terminal.

Four lifecycle hooks run around the work, each via `bash -lc`:

- `after_create` runs once when the directory is first made (for example, to clone a repo). Failure
  aborts workspace creation.
- `before_run` runs before each agent attempt. Failure aborts the attempt.
- `after_run` runs after each attempt. Failure is logged and ignored.
- `before_remove` runs before deletion. Failure is logged and ignored.

The hook timeout is `hooks.timeout_ms` (default 60000). Workspaces are containment-checked against
the realpath of `workspace.root`, so a symlink cannot point an agent's working directory outside the
root. Skills are overlaid into `.lorenz/skills/` with a `.gitignore` of `*` so they are never
committed. Workspaces can live locally or over SSH on a worker host. Details are in
[workspace.md](workspace.md).

## Agents run over ACP

A run is one agent session. Lorenz drives an external bridge subprocess (`codex-acp` or
`claude-agent-acp`) over the Agent Client Protocol. The only built-in executor is `acp`, selected per
agent kind via `agents.<kind>.executor`.

The agent runner builds the workspace, runs `before_run`, opens a session, then loops `runTurn` up to
`agent.max_turns` (default 20). Turn 0 sends the rendered prompt; later turns send a continuation
prompt. Two timers guard each turn: a hard turn timeout (`turn_timeout_ms`, default 3600000) and a
stall timeout (`stall_timeout_ms`, default 300000) reset on every agent event. Either firing cancels
the turn.

Codex and Claude differ only in how Lorenz feeds them provider config and reads token usage; both
ride the same ACP path. Lorenz always reports session-cumulative token totals to the orchestrator
regardless of how the bridge counts. The bridge contract and per-agent specifics are in
[agents/acp-bridges.md](agents/acp-bridges.md), [agents/codex.md](agents/codex.md), and
[agents/claude.md](agents/claude.md).

## Reconciliation keeps the world honest

Lorenz never trusts its in-memory state as the source of truth about issues. Every tick it re-fetches
the issues it thinks are in flight and reconciles them against the tracker:

- Issue still active, routed here, and unblocked: refresh its in-memory state and keep the run.
- Issue now terminal: stop the run, remove the workspace, emit `workspace_cleanup`.
- Issue no longer routed, blocked, or inactive: stop the run and clean up, classified as one of
  `terminal`, `unrouted`, `blocked`, or `inactive`.
- Issue missing from the re-fetch: reconciled as missing.
- The re-fetch itself failing: emit `reconcile_refresh_failed` and keep everything running, so a
  transient tracker outage does not kill live runs.

A separate stall pass finishes runs that have gone quiet past their stall timeout, records a
`stalled` outcome, and forces the worker to be treated as poisoned.

## No database

Lorenz has no database. The in-memory `OrchestratorState` (running, reserved, claimed, retrying,
completed, usage totals, rate limits, blocked dispatches) is the only scheduling state, and it is
rebuilt from scratch on every boot.

Recovery after a restart is therefore two-sided:

- **Tracker-driven.** The runtime re-fetches candidate and tracked issues. Any issue that is still
  eligible re-dispatches. Interrupted work resumes because the tracker, not a local database,
  says what still needs doing.
- **Filesystem-driven.** On the first tick, Lorenz lists the workspaces on disk, checks those issue
  ids against the tracker, and removes the workspaces whose issues are already terminal.

The only run history is in memory: a ring buffer of the last 50 run-history entries and the last 20
events, surfaced for display. There is no persisted scheduling state beyond the JSON event log,
which is on by default at `logging.log_file` and writes only when that key is set. This is by design;
the tracker plus the filesystem are enough to recover a clean view of the world.

## Where it all surfaces

Every dashboard reads the same object. The runtime assembles a `RuntimeSnapshot` (poll status,
running, reserving, retrying, blocked, run history, usage totals, recent events) and broadcasts it to
all subscribers: the Ink terminal dashboard (TUI), the web dashboard, and the HTTP API. One snapshot,
many views. See [observability.md](observability.md) for the dashboards and
[reference/events.md](reference/events.md) for the event vocabulary.

## See also
- [getting-started.md](getting-started.md) - install Lorenz and run your first workflow
- [agent-orchestrator.md](agent-orchestrator.md) - the poll loop, state machine, and reconciliation in depth
- [dispatch.md](dispatch.md) - eligibility, routing, caps, retries, and the two-phase pool path
- [workspace.md](workspace.md) - workspace layout, hooks, skills, and containment
- [architecture.md](architecture.md) - the package layout and extension points
