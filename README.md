# Symphony

This repository is a fork of [OpenAI Symphony](https://github.com/openai/symphony)'s Elixir reference implementation in
[elixir/README.md](elixir/README.md).


## Changes

### Claude Code Executor
In addition to the original Codex backend, this fork adds a Claude Code executor as an alternative
agent backend. Set `agent.kind` to `"claude"` in your workflow config to use it.

- Runs Claude Code CLI (`claude`) as the agent process instead of Codex app-server
- Streams JSONL output and parses tool-use, results, and completion events
- Automatically generates a per-workspace MCP config from workflow-defined MCP servers
- Supports session resumption via `--resume` with the same Git-backed resume metadata as Codex
- Supports remote execution on SSH worker hosts, same as Codex
- Configurable model, permission mode, turn/stall timeouts, and MCP server settings under the
  `claude` config key

### Session Resumption
Agent sessions (both Codex and Claude) can be resumed across runs:

- Local Git-backed workspaces persist resume metadata under `.git/symphony/resume.json`
- Later runs continue the same session when the saved issue, workspace, and worker context still
  match
- Failed or force-restarted runs invalidate resume state before retry, so the next run starts fresh

### Miscellaneous

- Local Codex app-server environment variables are inherited from the orchestrator


## Running

If you want to use the implementation in this repo, start with:

```bash
cd elixir
mise trust
mise install
mise exec -- mix setup
mise exec -- mix build
mise exec -- ./bin/symphony ./WORKFLOW.md
```

For more complete instructions, including live test commands and configuration details, see
[elixir/README.md](elixir/README.md).

## License

This project is licensed under the [Apache License 2.0](LICENSE).
