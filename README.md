# Symphony

This repository is a fork of [OpenAI Symphony](https://github.com/openai/symphony)'s Elixir reference implementation.

Symphony is an orchestrator that connects a project tracker (Linear) to coding agents (Codex or
Claude Code). It polls for issues, creates isolated workspaces, and runs agents against each issue
until the work is done.

## How it works

1. Polls Linear for issues in active states (e.g. `Todo`, `In Progress`)
2. Creates a workspace per issue and bootstraps it via `hooks.after_create`
3. Launches the configured agent executor (Codex or Claude Code) inside the workspace
4. Renders a Liquid-templated prompt from `WORKFLOW.md` with issue context and sends it to the agent
5. Re-runs the agent on subsequent polling cycles if the issue remains active, up to `max_turns`
6. When an issue moves to a terminal state (`Done`, `Closed`, `Cancelled`, `Duplicate`), stops the
   agent and cleans up the workspace

The workflow file (`WORKFLOW.md`) defines both the orchestrator configuration (YAML front matter) and
the agent session prompt (Markdown body). Editing the workflow while Symphony is running reloads the
configuration automatically - no restart needed.

## Changes

### Claude Code executor

In addition to the original Codex backend, this fork adds a Claude Code executor as an alternative
agent backend. Set `agent.kind` to `"claude"` in the workflow config to use it.

- Runs the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as the agent process
- Streams JSONL output and parses tool-use, results, and completion events
- Automatically generates a per-workspace MCP config from workflow-defined MCP servers
- Supports remote execution on SSH worker hosts, same as Codex
- Configurable model, permission mode, turn/stall timeouts, and MCP server settings under the
  `claude` config key

### Session resumption

Agent sessions (both Codex and Claude) can be resumed across runs:

- Local Git-backed workspaces persist resume metadata under `.git/symphony/resume.json`
- Later runs continue the same session when the saved issue, workspace, and worker context still
  match
- Failed or force-restarted runs invalidate resume state before retry, so the next run starts fresh

## Running

See [elixir/README.md](elixir/README.md) for full setup, configuration, and testing instructions.

```bash
cd elixir
mise trust
mise install
mise exec -- mix setup
mise exec -- mix build
mise exec -- ./bin/symphony ./WORKFLOW.md
```

## License

This project is licensed under the [Apache License 2.0](LICENSE).
