# Symphony

This is a fork of [openai/symphony](https://github.com/openai/symphony) — a long-running
orchestration service that polls Linear for work, creates isolated workspaces per issue, and runs
coding agents to complete the work autonomously.

This fork extends the upstream reference implementation with SSH-based distributed worker execution,
production hardening, and operational improvements.

> [!WARNING]
> Symphony is a low-key engineering preview for testing in trusted environments.

## Fork Changes

### SSH Worker Support

Distribute coding agent runs across multiple remote machines via SSH:

- Configure `worker.ssh_hosts` in your `WORKFLOW.md` front matter to target remote machines
- Per-host concurrency limits via `worker.max_concurrent_agents_per_host`
- Full Docker-based E2E testing with disposable SSH workers for deterministic CI

### Smaller Differences

- **Environment inheritance** — local Codex launches inherit the parent process environment, so auth
  tokens and config pass through correctly in containerized setups
- **Shell hook compatibility** — workspace hooks prefer `bash` when available, falling back to `sh`,
  fixing execution of bash-specific constructs in `WORKFLOW.md` hooks
- **Guardrails flag removed** — the `--long-guardrails-acknowledgement` CLI flag has been removed to
  simplify startup
- **Skill naming convention** — all `.codex/skills/` directories use `symphony-*` prefixes
  (`symphony-commit`, `symphony-push`, `symphony-pull`, `symphony-land`, `symphony-linear`,
  `symphony-debug`)

## Running Symphony

### Requirements

Symphony works best in codebases that have adopted
[harness engineering](https://openai.com/index/harness-engineering/).

### Quick Start

```bash
git clone https://github.com/ryanlyn/symphony
cd symphony/elixir
mise trust
mise install
mise exec -- mix setup
mise exec -- mix build
mise exec -- ./bin/symphony ./WORKFLOW.md
```

See [elixir/README.md](elixir/README.md) for detailed setup, configuration, and usage instructions.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
