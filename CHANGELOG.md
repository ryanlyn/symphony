# Changelog

## 2026-04-06

- Hardened unattended runtime behavior by defaulting the bundled workflow to
  Codex `workspace-write` sandboxing, honoring Linear `Retry-After` backoff on
  `429` responses, tightening remote workspace path validation, and improving
  orchestrator poll scheduling and restart handling.
- Improved Claude executor parity and safety by passing rendered issue context
  into Claude turns, aligning timeout behavior with Codex inactivity semantics,
  keeping injected Linear MCP credentials out of generated config, and
  tightening workspace validation and partial-startup cleanup.
- Strengthened session resumption by requiring explicit executor kind in resume
  state.
- Improved observability with status dashboard fixes for embedded asset
  fingerprinting and configured-orchestrator snapshot handling.
- Tightened workflow/config behavior by preserving the last known good
  orchestrator state on invalid reloads, fixing workflow init and agent-kind
  handling, and respecting Linear unstarted state types during blocker checks.

## 2026-04-03

- Added the Claude Code executor as an alternative agent backend, including
  agent-level executor abstraction, Claude-specific resume handling, MCP
  sidecar generation, dashboard integration, and live Claude resume coverage.

## 2026-03-31

- Added Codex session resumption for Git-backed workspaces via
  `.git/symphony/resume.json`.
- Added local `.claude` and `.codex` repo settings for agent tooling.
- Split the example workflow into full-access and sandboxed variants.

## 2026-03-28

- Improved local developer ergonomics by removing the CLI guardrails
  acknowledgement flag requirement, running local hooks with `bash` when
  available, inheriting app-server environment on local launch, and routing
  nested `mix` invocations through `mise`.

## 2026-03-27

- Renamed built-in skills to the `symphony-*` namespace and updated workflow
  references to match.
