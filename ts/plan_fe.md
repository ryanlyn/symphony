# Plan: Unify Hono + Fastify into a Single Ops-First Dashboard Server

## Context

The project has two independent web servers and a React frontend:

1. **`@symphony/server`** (Hono) — serves ops API (runtime state, SSE, MCP) + a server-rendered HTML dashboard at `GET /`. Used by the CLI in production.
2. **`@symphony/traceviz-server`** (Fastify) — serves trace API (tickets, events, stats) + WebSocket for live updates. Standalone dev tool.
3. **`@symphony/traceviz`** (React/Vite) — SPA showing per-ticket trace timelines.

The goal is to **unify into one Hono server on one port**, with the **Operations Overview as the landing page** and trace timelines as drill-downs from clickable issue links.

---

## Architecture

**Unified route table:**

| Method | Path | Source |
|--------|------|--------|
| GET | `/` | Static React SPA (if `staticDir` provided), else inline HTML dashboard |
| GET | `/ops-dashboard` | Server-rendered HTML (curl/headless fallback) |
| GET | `/api/v1/state` | Ops: runtime snapshot JSON |
| GET | `/api/v1/events` | Ops: SSE stream |
| GET | `/api/v1/runs` | Ops: runs list |
| GET | `/api/v1/:identifier` | Ops: single issue detail |
| POST | `/api/v1/refresh` | Ops: trigger refresh |
| POST | `/claude-mcp` | MCP JSON-RPC |
| GET | `/api/v1/tickets` | Trace: ticket list |
| GET | `/api/v1/tickets/:id/events` | Trace: parsed events |
| GET | `/api/v1/tickets/:id/stats` | Trace: computed stats |
| GET | `/health` | Health check |
| WS | `/ws` | Live trace updates |

Trace routes live under `/api/v1/` alongside ops routes, following the same convention. The `tickets` prefix distinguishes them from the existing ops endpoints (`state`, `events`, `runs`, `:identifier`).

---

## Implementation Phases

### Phase 1: Strip Fastify from `@symphony/traceviz-server`, keep core logic

**Files to modify:**
- `packages/traceviz-server/package.json` — remove fastify, @fastify/cors, @fastify/static, @fastify/websocket
- `packages/traceviz-server/src/server.ts` — delete (Fastify app factory)
- `packages/traceviz-server/src/main.ts` — delete (standalone CLI)
- `packages/traceviz-server/src/index.ts` — create, re-exporting TraceWatcher, computeStats, parser, and model types

**Files to keep unchanged:**
- `packages/traceviz-server/src/watcher.ts` — framework-agnostic, just fs polling
- `packages/traceviz-server/src/parser.ts` — pure data transform
- `packages/traceviz-server/src/stats.ts` — pure computation
- `packages/traceviz-server/src/models/` — type definitions

### Phase 2: Add trace routes + WebSocket to `@symphony/server`

**New dependencies for `@symphony/server`:**
- `@hono/node-ws` — WebSocket adapter for @hono/node-server
- `@symphony/traceviz-server: workspace:*` — for TraceWatcher, parser, stats

**New files in `packages/server/src/`:**
- `trace-routes.ts` — Hono routes wrapping TraceWatcher (GET tickets, events, stats)
- `ws.ts` — WebSocket handler using `@hono/node-ws` (init, subscribe, events_update broadcast)

**Modified files:**
- `packages/server/src/index.ts` — extend `ObservabilityServerOptions` with optional `traceDir` and `staticDir`; compose trace routes + WS into the app when traceDir is set; add static file serving; move HTML dashboard to `/ops-dashboard` when staticDir is present
- `packages/server/package.json` — add new deps
- `packages/server/tsconfig.json` — add project reference to traceviz-server

**Key design decisions:**
- When `traceDir` is **not** provided: behavior is identical to today (backward-compatible, all existing tests pass)
- When `staticDir` is **not** provided: `GET /` still serves inline HTML dashboard
- When both are provided: `GET /` serves the React SPA, `/ops-dashboard` serves the HTML fallback
- `@hono/node-ws` requires calling `injectWebSocket(server)` after the HTTP server starts — add an `afterListen` hook to `startHonoServer`

### Phase 3: Frontend — ops-first navigation

**New files in `apps/traceviz/src/`:**
- `hooks/useHashRouter.ts` — minimal hash-based router (2 views, no external dep needed)
- `hooks/useOpsStream.ts` — EventSource hook consuming `/api/v1/events` SSE for live ops state
- `components/OpsOverview.tsx` — landing page: metrics grid + session tables with clickable issue links (`#/trace/:issueId`)
- `components/TraceView.tsx` — extracted from current App.tsx: timeline + stats for a single issue, with "Back" navigation

**Modified files:**
- `apps/traceviz/src/App.tsx` — replace current content with router: `#/` → OpsOverview, `#/trace/:issueId` → TraceView
- `apps/traceviz/src/api/client.ts` — add ops state fetcher; update trace API base path from `/api/tickets` to `/api/v1/tickets`
- `apps/traceviz/src/api/types.ts` — add ops state types (running/retrying/blocked session, counts, usage)
- `apps/traceviz/vite.config.ts` — proxy already forwards `/api` and `/ws` to the backend; no change needed since both ops (`/api/v1/*`) and trace (`/api/v1/tickets/*`) are under `/api`

**Navigation model:**
- OpsOverview shows running/retrying/blocked sessions. Each row's issue identifier is an `<a href="#/trace/{issueId}">` link.
- TraceView shows the timeline (existing components). A back link returns to `#/`.
- The TicketSelector dropdown becomes secondary navigation within TraceView (switching between issues without going back to overview).

### Phase 4: Wire into CLI

**Modified files:**
- `packages/domain/src/index.ts` — extend `ServerSettings` with `traceDir?: string` and `staticDir?: string`
- `apps/cli/src/main.ts` — pass `traceDir` and `staticDir` to `startObservabilityServer`

**Where traceDir comes from:** derived from workspace settings or a default like `${workspaceRoot}/traces`. The TraceEmitter already writes to a configurable dir — use the same one.

**Where staticDir comes from:** resolved to the built `apps/traceviz/dist/` at packaging time (or undefined in dev mode, where Vite serves directly).

### Phase 5: Cleanup

- Remove `packages/traceviz-server/src/server.ts` and `src/main.ts`
- Remove Fastify deps from root lockfile (pnpm will handle on next install)
- Update root `package.json` scripts: `pnpm traceviz` should now start the unified server (or just `pnpm dev`)
- Update `pnpm-workspace.yaml` if any package name changes (unlikely)

---

## Verification

1. **Existing test suite passes**: `mise run check` — the ops server tests in `packages/server/test/http-server.test.ts` exercise the no-traceDir path, so they pass unchanged
2. **New trace route tests**: add `packages/server/test/trace-routes.test.ts` — create temp dir with sample .jsonl, start server with traceDir, verify GET endpoints
3. **WebSocket test**: verify connect → init message → subscribe → events response
4. **Static serving test**: build frontend, start server with staticDir, verify `GET /` returns HTML with React mount point
5. **Frontend dev**: run `pnpm traceviz:ui` (Vite dev) + unified server — verify proxy works, ops overview loads live data, clicking issue navigates to trace view
6. **End-to-end**: `mise run check` to run typecheck + all tests + lint

---

## Risk Notes

- **`GET /` breaking change**: mitigated by only changing behavior when `staticDir` is provided. Without it (existing CLI usage), `GET /` still returns the HTML dashboard.
- **WebSocket adapter maturity**: `@hono/node-ws` is less battle-tested than Fastify's plugin. The protocol is trivial (JSON messages), so risk is low. Add reconnect tests.
- **Route ordering**: `GET /api/v1/:identifier` is a single-segment wildcard that would match `/api/v1/tickets` if registered first. Fix: mount trace routes (which include `GET /api/v1/tickets`) **before** the `:identifier` catch-all. Hono gives precedence to literal matches over params when registered first. The existing `state`, `events`, `runs`, `refresh` routes already rely on this ordering.
