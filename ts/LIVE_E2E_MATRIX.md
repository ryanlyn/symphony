# Live E2E Matrix

This matrix describes the live validation surface for the TypeScript port.

## Local Contract Coverage

- `npm test`
  - Verifies the packaged CLI parser for Elixir-compatible workflow path handling and TS runtime flags.
  - Verifies the daemon runtime poll/claim/run/update/history path with injected fake services.
  - Verifies the Ink dashboard renders the Elixir terminal-dashboard operational sections.
  - Verifies the HTTP observability API returns Elixir-shaped state, issue, runs, refresh, 404, and
    405 payloads.
  - Verifies `symphony-ts runs` parses the same filter flags as `mix symphony.runs` and renders the
    run-history table from the observability API.
  - Parses `WORKFLOW.md` with the same optional YAML front matter behavior as the Elixir loader.
  - Honors `SYMPHONY_WORKFLOW` before the default current-directory `WORKFLOW.md`.
  - Renders empty workflow bodies with the Elixir default prompt.
  - Exposes workflow prompt context as `issue.*`, `attempt`, and `ensemble.slot_index`.
  - Compares shared Elixir/TS prompt fixtures for conditionals, loops, nested issue refs, and common filters.
  - Uses the Elixir continuation guidance for follow-up turns.
  - Exercises paged Linear polling, missing cursor handling, ID de-duplication, batching, and order restore.
  - Classifies Linear GraphQL errors, HTTP errors, invalid JSON, missing API keys, and network failures.
  - Verifies Codex dynamic tool calls with string IDs and failed tool-call responses.

## What Live Coverage Proves

- `npm run test:live:codex`
  - Launches the real `codex app-server`.
  - Performs initialize, thread start, turn start, and turn completion.
- `npm run test:live:codex-resume`
  - Launches the real `codex app-server`.
  - Runs one turn, captures the resume ID, starts a second app-server session with `thread/resume`,
    and completes a second turn in the same workspace.
- `npm run test:live:linear-codex`
  - Uses the real Linear GraphQL API with `LINEAR_API_KEY`.
  - Discovers the Symphony project, team, Todo state, and Done state.
  - Creates a temporary Linear issue assigned to the authenticated viewer.
  - Polls active candidates and verifies the new issue appears.
  - Refreshes by ID, including duplicate ID de-duplication and empty-list behavior.
  - Verifies assignee routing accepts the viewer and rejects a mismatched assignee.
  - Executes the TS `linear_graphql` dynamic tool against live Linear.
  - Verifies unsupported tool and live GraphQL error handling.
  - Launches a real Codex app-server turn using the live Linear issue context.
  - Moves the temporary issue to Done and verifies it disappears from active polling.
- `npm run test:live:claude`
  - Launches the real `claude` executable in stream-json mode.
  - Verifies the optional Claude executor profile remains compatible with the current CLI.
  - Verifies a real Claude turn can use the injected Symphony MCP endpoint for a live Linear viewer query.
- `npm run test:live:ssh`
  - Uses configured `SYMPHONY_LIVE_SSH_WORKER_HOSTS`, a temporary localhost `sshd` fallback, or the repo Docker SSH worker harness when Docker is running.
  - Runs a real Codex app-server turn on an SSH worker and verifies the remote workspace artifact.
  - When a Claude OAuth token is available, runs real Claude on an SSH worker, uses the Symphony MCP endpoint, writes remote artifacts, and verifies resume ID reuse across runs.
- `node dist/src/bin/symphony-ts.js --once --dry-run --no-tui`
  - Runs the built package entrypoint.
  - Loads `WORKFLOW.md`, validates settings, polls live Linear, and exits without starting agents.
- `node dist/src/bin/symphony-ts.js --port 0 --once --dry-run --no-tui`
  - Starts the built HTTP observability server around the built orchestrator entrypoint, polls live
    Linear once, and shuts down cleanly.

## Boundaries

No finite live suite can prove every possible production situation. The claim this matrix supports is
that the TypeScript implementation works end to end across the core live Linear and Codex protocol
contracts, plus the highest-risk edge classes that can be safely exercised without damaging real
project data.

The SSH canary is intentionally separate from `npm run test:live` because it starts an SSH worker.
It can use real SSH worker hosts, a temporary local `sshd`, or a running Docker daemon. For remote
Claude, export the existing Claude Code OAuth token as `CLAUDE_CODE_OAUTH_TOKEN` or
`SYMPHONY_LIVE_DOCKER_CLAUDE_CODE_OAUTH_TOKEN`.
