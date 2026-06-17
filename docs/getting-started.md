# Getting started

This page takes you from a fresh checkout to a first Lorenz run. It is for operators: you install the toolchain, write a small `WORKFLOW.md`, and watch Lorenz poll a tracker and dispatch an agent. The fastest path needs no API key, so start there and add Linear once you have seen a run work.

Lorenz derives from OpenAI's Symphony. It reads issues from a tracker, runs a coding agent against each one in an isolated workspace, and reports progress back to the tracker.

## What you need

- Node 24 and pnpm 9. The repository pins both in `mise.toml`.
- One tracker configured. Two get you running quickly:
  - The local filesystem board (`kind: local`) needs no credentials. Issues are Markdown files on disk.
  - Linear (`kind: linear`) needs `LINEAR_API_KEY`.
- A coding agent on `PATH` for real runs: `codex` for Codex, or a Claude ACP bridge (`claude-agent-acp`) for Claude. You can skip the agent for a `--dry-run`, which evaluates candidates without dispatching.

## Install

[mise](https://mise.jdx.dev/) manages the toolchain. From the repository root:

```sh
mise trust
mise install
pnpm install
```

Then build the CLI:

```sh
pnpm build
```

`pnpm build` produces the `lorenz` binary. If you run `lorenz` before building, it prints `lorenz has not been built yet. Run pnpm build or mise run build first.`

## Fastest path: the local board, no API key

The local tracker stores each issue as a single Markdown file named `<prefix><n>.md` (default prefix `BOARD-`) under a board directory (default `.lorenz/local`). No network, no credentials.

### 1. Seed a demo board

The seeder writes three sample issues (two in `Todo`, one in `In Progress`) through the same `BoardStore` the running tracker uses, so the ids and on-disk format match:

```sh
npx tsx sandbox/seed-local.ts
```

Seed a different directory or fewer issues by passing arguments:

```sh
npx tsx sandbox/seed-local.ts /tmp/demo-board 2
```

### 2. Write a minimal WORKFLOW.md

A `WORKFLOW.md` has two parts: YAML front matter (config, between two `---` lines) and a Markdown body (the agent prompt, rendered as Liquid). Point `tracker.path` at the directory you seeded.

```md
---
tracker:
  kind: local
  path: .lorenz/local
agent:
  kind: codex
---
Fix the issue below.

Title: {{ issue.title }}
Description: {{ issue.description }}
```

Prompt variables are snake_case: `issue.title`, `issue.description`, `issue.identifier`, `issue.state`, `issue.branch_name`, and more. Leave the body blank and Lorenz falls back to a built-in default prompt, so a blank prompt is never truly empty.

### 3. Do a safe first run

Before dispatching a real agent, poll once and inspect what Lorenz would pick up:

```sh
lorenz --once --dry-run --no-tui WORKFLOW.md
```

- `--once` polls a single time and exits instead of looping.
- `--dry-run` evaluates candidate issues without dispatching an agent.
- `--no-tui` disables the terminal dashboard and prints JSON snapshots to stdout, the form you want for a non-interactive shell or a log.

When the output looks right, run for real:

```sh
lorenz WORKFLOW.md
```

Lorenz polls the board, dispatches the agent on each `Todo` / `In Progress` issue, and writes status and comments back into the `BOARD-<n>.md` files. The agent updates issues through five tools: `local_update_status`, `local_comment`, `local_create_issue`, `local_read_issue`, and `local_query`.

The read path (polling) and the agent write path resolve the board directory the same way, so `tracker.path` must point at the directory you seeded. If they diverge, agent writes never reach the polled directory and the run loop re-dispatches forever.

## Linear quickstart

Once you have seen a local run, point Lorenz at Linear.

### 1. Set credentials

```sh
export LINEAR_API_KEY=lin_api_...
```

`tracker.api_key` falls back to `LINEAR_API_KEY`, and `tracker.assignee` falls back to `LINEAR_ASSIGNEE`. The literal assignee `me` resolves to the API key's own user.

### 2. Write the workflow

Linear needs exactly one of `project_slug`, `project_slugs`, or `project_labels`:

```md
---
tracker:
  kind: linear
  project_slugs:
    - my-project
agent:
  kind: codex
---
Fix the issue below.

Title: {{ issue.title }}
Description: {{ issue.description }}
```

The default endpoint is `https://api.linear.app/graphql`. Lorenz polls issues in the active states (default `Todo` and `In Progress`) and treats `Closed`, `Cancelled`, `Canceled`, `Duplicate`, and `Done` as terminal.

### 3. Run

```sh
lorenz --dry-run --no-tui WORKFLOW.md
```

If the credentials and project resolve, drop the flags to run live. `lorenz doctor WORKFLOW.md` validates the workflow, the dispatch config, and that the agent CLI is discoverable before you start.

## What a run looks like

Both dashboards run by default. The web dashboard listens on port `4040` (override with `--port`); the terminal TUI renders when stdout is a TTY. Disable either with `--no-dashboard` or `--no-tui`.

![Lorenz terminal dashboard](images/lorenz-tui.png)

*The TUI shows live issue, agent, and dispatch state in the terminal.*

![Lorenz web dashboard](images/lorenz-dashboard.png)

*The web dashboard serves the same run state over HTTP, with per-run trace history.*

Query completed runs from a separate shell with `lorenz runs` (it reads the same observability API):

```sh
lorenz runs --failed --port 4040
```

## How the CLI resolves the workflow

With no path argument, the CLI reads `LORENZ_WORKFLOW` (absolute path used as-is, relative joined to the current directory), then falls back to `./WORKFLOW.md`. The runtime re-reads the workflow before each poll, so edits to config or prompt take effect on the next tick. If a reload fails, the runtime keeps the last good settings and records a `workflow_reload_failed` event. If startup cannot read or parse the workflow, the CLI exits with an error.

## See also

- [CLI](cli.md) - every command and flag, exit codes, and the `runs` and `doctor` subcommands.
- [Workflows](workflows.md) - the full `WORKFLOW.md` format, front matter, and prompt body.
- [Trackers](trackers/index.md) - the tracker backends and how dispatch reads from them.
- [Local board](trackers/local.md) - the on-disk format, tools, and options behind `kind: local`.
- [Linear](trackers/linear.md) - project selection, credentials, and the `linear_graphql` tool.
- [Troubleshooting](troubleshooting.md) - common first-run failures and how to read them.
