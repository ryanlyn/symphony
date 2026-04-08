# Symphony Elixir

Elixir/OTP implementation of [Symphony](../README.md), forked from
[openai/symphony](https://github.com/openai/symphony).

## Prerequisites

[mise](https://mise.jdx.dev/) is recommended for managing Elixir/Erlang versions:

```bash
mise trust
mise install
mise exec -- elixir --version
```

## Run

```bash
mise exec -- mix setup
mise exec -- mix build
mise exec -- ./bin/symphony ./WORKFLOW.md
```

Optional flags:

- `--logs-root <path>` - write logs under a different directory (default: `./log`)
- `--port <port>` - start the Phoenix observability dashboard and JSON API (default: disabled)

### Development mode (hot-reload)

Run Symphony interactively with `iex` for automatic code recompilation on changes:

```bash
SYMPHONY_WORKFLOW=/path/to/WORKFLOW.md mise exec -- iex -S mix
```

The `SYMPHONY_WORKFLOW` env var specifies the workflow file path when not passing it as a CLI
argument. The `WorkflowStore` also polls `WORKFLOW.md` every second and hot-reloads configuration
and prompt changes without restarting.

## Configuration

All configuration lives in the YAML front matter of `WORKFLOW.md`. The Markdown body below the
front matter is the agent session prompt, rendered as a Liquid template with issue context variables
(`{{ issue.identifier }}`, `{{ issue.title }}`, `{{ issue.description }}`, etc.).

### Quickstart

```yaml
---
tracker:
  kind: linear
  project_slug: "your-project-slug"
workspace:
  root: ~/code/workspaces
hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
agent:
  kind: codex        # or "claude"
---

You are working on {{ issue.identifier }}: {{ issue.title }}

{{ issue.description }}
```

Set `LINEAR_API_KEY` in your environment and you're ready to go.

### Full reference

```yaml
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY           # reads from env; defaults to $LINEAR_API_KEY when unset
  endpoint: "https://api.linear.app/graphql"  # Linear GraphQL endpoint; rarely needs changing
  project_slug: "my-project"         # right-click project in Linear, slug is in the URL
  assignee: $LINEAR_ASSIGNEE         # optional; filter issues by assignee
  active_states:                     # issue states that trigger agent work
    - Todo                           #   default: ["Todo", "In Progress"]
    - In Progress
    - Merging                        # custom states are supported; add them in
    - Rework                         #   Linear under Team Settings -> Workflow

  terminal_states:                   # issue states that stop agents and clean up workspaces
    - Closed                         #   default: ["Closed", "Cancelled", "Canceled",
    - Cancelled                      #             "Duplicate", "Done"]
    - Canceled
    - Duplicate
    - Done

polling:
  interval_ms: 30000                 # how often to poll Linear; default: 30000

workspace:
  root: ~/code/workspaces            # where issue workspaces are created
                                     #   default: $TMPDIR/symphony_workspaces
                                     #   supports ~ and $ENV_VAR expansion

worker:
  ssh_hosts:                         # optional; run agents on remote SSH hosts
    - worker1.example.com            #   workspaces are synced via rsync over SSH
    - worker2.example.com            #   set SYMPHONY_SSH_CONFIG to use a custom SSH config file
  ssh_timeout_ms: 60000              # optional; default timeout for SSH.run/3 calls; default: 60000
  max_concurrent_agents_per_host: 2  # optional; cap agents per SSH host

agent:
  kind: codex                        # "codex" (default) or "claude"
  max_concurrent_agents: 10          # total concurrent agents across all hosts; default: 10
  max_turns: 20                      # max re-runs per issue while still active; default: 20
  max_retry_backoff_ms: 300000       # backoff cap for retries; default: 300000
  max_concurrent_agents_by_state:    # optional; per-state concurrency limits
    in progress: 5                   #   state names are case-insensitive
    merging: 2

codex:                               # Codex-specific settings (used when agent.kind is "codex")
  command: codex app-server          # shell command to start Codex; default: "codex app-server"
                                     #   $ENV_VAR expansion happens in the launched shell
  approval_policy: never             # string or object; default: reject sandbox_approval,
                                     #   rules, and mcp_elicitations
                                     #   string values: untrusted, on-failure, on-request, never
  thread_sandbox: workspace-write    # read-only, workspace-write, danger-full-access
                                     #   default: workspace-write
  turn_sandbox_policy:               # optional; overrides auto-generated sandbox policy
    type: workspaceWrite             #   passed through to Codex unchanged when set
    writableRoots:
      - /path/to/workspace
    networkAccess: true
  turn_timeout_ms: 3600000           # max time per turn; default: 3600000 (1h)
  read_timeout_ms: 5000              # read timeout for app-server responses; default: 5000
  stall_timeout_ms: 300000           # kill turn after this long without output; default: 300000

claude:                              # Claude-specific settings (used when agent.kind is "claude")
  command: claude                    # CLI command; default: "claude"
  model: claude-opus-4-6[1m]        # model to use; default: claude-opus-4-6[1m]
  permission_mode: dontAsk           # default: dontAsk
  turn_timeout_ms: 3600000           # max time per turn; default: 3600000 (1h)
  stall_timeout_ms: 300000           # kill turn after this long without output; default: 300000
  strict_mcp_config: true            # only use MCP servers from the injected config,
                                     #   ignoring user/project MCP settings; default: true

hooks:
  after_create: |                    # runs after workspace directory is created
    git clone --depth 1 git@github.com:org/repo.git .
  before_run: |                      # runs before each agent turn
    git pull origin main
  after_run: |                       # runs after each agent turn
    echo "turn complete"
  before_remove: |                   # runs before workspace cleanup
    echo "cleaning up"
  timeout_ms: 60000                  # hook execution timeout; default: 60000

observability:
  dashboard_enabled: true            # enable terminal dashboard; default: true
  refresh_ms: 1000                   # dashboard data refresh; default: 1000
  render_interval_ms: 16             # terminal render interval; default: 16

server:
  port: 4000                         # enable Phoenix web dashboard; default: disabled
  host: 127.0.0.1                    # bind address; default: 127.0.0.1
---
```

Notes:

- If `WORKFLOW.md` is missing or has invalid YAML at startup, Symphony does not boot. If a later
  reload fails, it keeps running with the last known good configuration and logs the error.
- `~` is expanded to the home directory in path values. For env-backed paths, use `$VAR`.
- `SYMPHONY_WORKSPACE_ROOT` overrides `workspace.root` at runtime. This is useful for isolated
  test and CI runs that should not touch shared local workspaces.
- The `codex.command` value is a shell command string - `$VAR` expansion happens in the shell, not
  in Symphony.
- When `codex.turn_sandbox_policy` is omitted, Symphony auto-generates a `workspaceWrite` policy
  rooted at the issue workspace.
- If the Markdown body is blank, Symphony uses a default prompt template with the issue identifier,
  title, and body.

### Linear

Prerequisites:

1. Get a personal API token: Linear Settings -> Security & access -> Personal API keys
2. Set it as the `LINEAR_API_KEY` environment variable (or `tracker.api_key: $LINEAR_API_KEY`)
3. Find your project slug by right-clicking the project in Linear and copying its URL - the slug
   is in the path
4. The example workflow files in this repo use non-standard Linear issue states (`Rework`, `Human
   Review`, `Merging`). Add these under Team Settings -> Workflow in Linear, or customize
   `active_states` / `terminal_states` to match your existing workflow.

### Workflow prompt

The Markdown body of `WORKFLOW.md` is rendered as a [Liquid](https://shopify.github.io/liquid/)
template before being sent to the agent. Available variables:

- `{{ issue.identifier }}` - e.g. `PROJ-42`
- `{{ issue.title }}`
- `{{ issue.description }}`
- `{{ issue.state }}` - current Linear status
- `{{ issue.labels }}` - list of label names
- `{{ issue.url }}` - Linear issue URL
- `{{ issue.id }}` - Linear internal ID
- `{{ issue.priority }}` - priority level
- `{{ issue.branch_name }}` - associated branch name
- `{{ issue.assignee_id }}`
- `{{ issue.created_at }}`
- `{{ issue.updated_at }}`
- `{{ attempt }}` - retry attempt number (nil on first run)

### Skills

The `.codex/skills/` directory in this repo contains orchestration skills referenced by the example
workflow files:

- `symphony-linear` - interact with Linear (comments, state transitions, queries)
- `symphony-commit` - produce clean, logical commits
- `symphony-push` - push branches and create/update PRs
- `symphony-pull` - merge latest `origin/main` into the working branch
- `symphony-land` - monitor and merge approved PRs
- `symphony-debug` - investigate stuck runs and execution failures

Copy these to your target repo's `.codex/skills/` directory if your workflow references them. The
`symphony-linear` skill uses the `linear_graphql` tool injected by Symphony (via Codex app-server
tool or Symphony's `/claude-mcp` endpoint for Claude).

## Web dashboard

Start with `--port` to enable the Phoenix web interface:

```bash
mise exec -- ./bin/symphony ./WORKFLOW.md --port 4000
```

- LiveView dashboard at `/`
- JSON API at `/api/v1/state`, `/api/v1/<issue_identifier>`, and `/api/v1/refresh`

## Testing

### Unit and integration tests

```bash
make all
```

This runs formatting, linting, coverage, and Dialyzer checks. Individual targets are also
available:

```bash
make setup       # install dependencies
make build       # build escript binary
make test        # unit tests only
make coverage    # tests with coverage
make fmt-check   # check formatting
make lint        # credo + spec checks
make dialyzer    # type checking
```

### Live end-to-end tests

These create real Linear resources and launch agent sessions. Requires `LINEAR_API_KEY`:

```bash
make e2e
```

`make e2e` runs two scenarios: one with a local worker and one with SSH workers.

- **SSH workers**: if `SYMPHONY_LIVE_SSH_WORKER_HOSTS` is unset, the test uses `docker compose` to
  start two disposable SSH containers on localhost. It generates a temporary SSH keypair and mounts
  the host auth config into each container.
- Set `SYMPHONY_LIVE_SSH_WORKER_HOSTS` (comma-separated) to target real SSH hosts instead.
- `SYMPHONY_LIVE_LINEAR_TEAM_KEY` defaults to `SYME2E`.

### Resume tests

Test session resumption without live Linear resources:

```bash
# Codex resume
SYMPHONY_RUN_REAL_CODEX_RESUME_E2E=1 mise exec -- mix test test/symphony_elixir/live_resume_e2e_test.exs

# Claude resume + MCP
SYMPHONY_RUN_REAL_CLAUDE_RESUME_E2E=1 LINEAR_API_KEY=... mise exec -- mix test test/symphony_elixir/live_claude_resume_e2e_test.exs
```

For the remote Claude resume scenario, set `SYMPHONY_LIVE_SSH_WORKER_HOSTS` to real SSH workers, or
let the test boot disposable docker SSH workers automatically by providing
`SYMPHONY_LIVE_DOCKER_CLAUDE_CODE_OAUTH_TOKEN` (or `CLAUDE_CODE_OAUTH_TOKEN`) so Claude inside the
worker container can authenticate.

## License

This project is licensed under the [Apache License 2.0](../LICENSE).
