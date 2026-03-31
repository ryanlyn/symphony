# Symphony

This repository is a fork of [OpenAI Symphony](https://github.com/openai/symphony)'s Elixir reference implementation in
[elixir/README.md](elixir/README.md).


## Changes

### Session Resumption
Compared with the original repository, the main capability difference in this fork today is local
Codex thread resumption:

- Local Git-backed workspaces can persist resume metadata under `.git/symphony/resume.json`
- Later runs can continue the same Codex session when the saved issue, workspace, and worker context
  still match
- Failed or force-restarted runs invalidate that resume state before retry, so the next run starts a
  fresh thread instead of reusing a bad session


### Miscellaneous

- Local Codex app-server environment varianbles are inherited from the orchestrator


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
