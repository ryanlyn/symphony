# Changelog

## 2026-04-09

- `4478463`, `c5d271d`, `fa64362`, `39003ea`: Reworked runtime and dispatch behavior by resolving executor/runtime settings through `status_overrides`, composing global and per-status concurrency caps with clearer blocked-work reporting, caching parsed workflow templates, and bounding workspace setup plus hook execution with runner-side timeouts.
- `5e170e6`, `9826f10`, `cf43dd1`, `f2b0543`, `0322a19`, `6ece611`, `5cb3142`: Hardened startup and execution edge cases with symlink-safe local workspace creation, malformed Codex issue and nil-port session guards, graceful log-directory and dead-port handling, clearer dynamic tool nil errors, and tighter Dialyzer suppression scope.
- `f765e8a`, `16fad85`, `22a3103`, `db6aa9b`: Improved dashboard resilience and readability by separating agent and stage columns, preserving retry errors that contain commas, fixing UTF-8 row truncation, and keeping LiveView polling alive when PubSub subscribe fails.
- `5f8a2cd`, `3522550`: Improved Claude executor diagnostics by draining buffered post-exit output before returning `:port_exit` and logging unknown Claude stream event types while preserving the notification fallback.
- `e2605ed`, `a074bc1`, `503ca0d`, `0e8f87b`, `7e3307d`, `63d71ca`: Updated workflow and review guidance by adding proof-of-work expectations, moving full-access tickets through `Agent Review` before `Merging`, restoring the fast service tier in the full-access workflow, clarifying Linear text attachment handling, tightening agent-review workpad guidance, and refreshing local Claude permissions for Linear comment tooling.
- `ab94dca`: Standardized the Elixir changelog entries to a consistent hash-first format for the April 7-8 history.

## 2026-04-08

- `b056923`, `e355aa7`, `7e4306d`, `b020359`: Tightened startup, workspace, and workflow handling across local and remote roots, including safer cleanup, test workspace isolation, presenter fallback sanitization, and more robust prompt parsing.
- `3949fdc`, `5f49d23`, `1a483f1`, `c921f33`, `492a7b2`, `9905d72`, `9dd8dfa`: Improved orchestration, dashboard, and ensemble behavior by typing running entries, normalizing issue state handling, refining slot display, and rendering only the active dashboard connection badge with a proper ANSI orange accent.
- `be49b54`, `9cbecdf`, `42aa825`: Hardened configuration and transport behavior by preserving endpoint secrets across restarts, adding configurable SSH command timeouts, removing a dead config helper, excluding `_for_test` helpers from production builds, and reducing duplicated executor and workspace port/path helpers.

## 2026-04-07

- `42f5007`, `7fcdc92`, `740113a`: Expanded the ensemble workflow with independent workpads, updated workflow documentation, refreshed the status dashboard and test fixtures, and documented fork extensions in the README.
- `2df3d0e`: Served Claude MCP over `/claude-mcp`, adding the MCP tunnel, auth, controller, and related executor and tool routing updates.

## 2026-04-06

- `e7ebd87`, `36615b4`, `2250abb`, `76107f1`, `3f8291b`: Hardened unattended runtime behavior by defaulting the bundled workflow to Codex `workspace-write` sandboxing, honoring Linear `Retry-After` backoff on `429` responses, tightening remote workspace path validation, and improving orchestrator poll scheduling and restart handling.
- `74c4970`, `161c820`, `1c7539b`, `b8fdabc`, `fb2e154`: Improved Claude executor parity and safety by passing rendered issue context into Claude turns, aligning timeout behavior with Codex inactivity semantics, keeping injected Linear MCP credentials out of generated config, and tightening workspace validation and partial-startup cleanup.
- `a2d446f`, `584cf51`: Strengthened session resumption by requiring explicit executor kind in resume state.
- `819cae5`, `ae21ad1`: Improved observability with status dashboard fixes for embedded asset fingerprinting and configured-orchestrator snapshot handling.
- `97ecc0c`, `233d5db`, `186e984`: Tightened workflow/config behavior by preserving the last known good orchestrator state on invalid reloads, fixing workflow init and agent-kind handling, and respecting Linear unstarted state types during blocker checks.

## 2026-04-03

- `e6480dc`, `c4631b1`, `183b9d7`, `cbd9de5`, `121b287`: Added the Claude Code executor as an alternative agent backend, including agent-level executor abstraction, Claude-specific resume handling, MCP sidecar generation, dashboard integration, and live Claude resume coverage.

## 2026-03-31

- `b59e118`: Added Codex session resumption for Git-backed workspaces via `.git/symphony/resume.json`.
- `8c9ecd9`: Added local `.claude` and `.codex` repo settings for agent tooling.
- `e032ce7`: Split the example workflow into full-access and sandboxed variants.

## 2026-03-28

- `37537c7`, `de2c5bc`, `902f9e3`, `62c3781`: Improved local developer ergonomics by removing the CLI guardrails acknowledgement flag requirement, running local hooks with `bash` when available, inheriting app-server environment on local launch, and routing nested `mix` invocations through `mise`.

## 2026-03-27

- `4a62b59`: Renamed built-in skills to the `symphony-*` namespace and updated workflow references to match.
