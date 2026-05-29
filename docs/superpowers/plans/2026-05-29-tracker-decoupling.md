# Tracker Decoupling (Local + Slack) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Symphony TS tracker backend pluggable and ship two service-free trackers — a local-filesystem "board" (`.symphony/board/`) and a Slack tracker (mention = issue, emoji reaction = status, thread reply = comment).

**Architecture:** No cross-layer registry. `TRACKER_KINDS` (in `@symphony/domain`) is the single source of truth; three sites do per-kind dispatch in the layer that owns them — read-client construction (`apps/cli/src/daemon.ts`), config validation (`packages/config`), and agent write tools (`packages/mcp`). Each dispatch is an exhaustive `switch` over `TrackerKind` with an `assertNever` default, so adding a kind surfaces compile errors everywhere it is unhandled. Read clients implement the existing read-only `RuntimeTrackerClient`; backend write logic (board file store, Slack transport) lives in the tracker packages and is imported by per-backend MCP tool modules.

**Tech Stack:** TypeScript (ESM), pnpm workspaces, vitest, `yaml`, `zod`, `tsc --build` project references. Commands: `pnpm exec vitest run <path>` (targeted), `mise run tidy` (format+lint fix), `mise run check` (typecheck+test+lint). All commands run from `ts/`.

**Reference spec:** `docs/superpowers/specs/2026-05-29-tracker-decoupling-design.md`

---

## File Structure

Phase 1 (refactor — no new kinds):
- Create `ts/packages/mcp/src/tools/linear.ts` — current `tools.ts` Linear logic moved verbatim (`linearToolSpecs`, `executeLinearTool`).
- Modify `ts/packages/mcp/src/tools.ts` — becomes the per-kind dispatcher; keeps `ToolSpec`/`ToolResult` exports.
- Modify `ts/packages/mcp/src/agentEndpoint.ts` — add `trackerMcpServerName(kind)`; use it for the MCP server name; `mcpConfigContents` gains a `serverName` param.
- Modify `ts/packages/mcp/src/index.ts` — export `trackerMcpServerName`, `ToolDeps`.
- Modify call sites: `ts/packages/codex/src/executor.ts:135`, `ts/packages/server/src/index.ts:466`, `ts/packages/mcp/src/server.ts:137` — pass `settings` to `toolSpecs`.
- Create `ts/packages/mcp/test/server-name.test.ts`.

Phase 2 (local tracker):
- Modify `ts/packages/domain/src/index.ts` — add `"local"` to `TRACKER_KINDS`; add `path?` to `TrackerSettings`.
- Modify `ts/packages/issue/src/index.ts` — add+export `defaultStateType(name)`.
- Create `ts/packages/issue/test/state-type.test.ts`.
- Create package `ts/packages/local-tracker/` (`package.json`, `tsconfig.json`, `src/boardStore.ts`, `src/client.ts`, `src/index.ts`, `test/board-store.test.ts`, `test/client.test.ts`).
- Create `ts/packages/mcp/src/tools/local.ts`; add `local` case to `tools.ts` dispatcher.
- Modify `ts/packages/config/src/index.ts` — `path` field in `trackerRawSchema`, `parseTracker`, default, `validateDispatchConfig`.
- Modify `ts/apps/cli/src/daemon.ts` — `local` case in `createTrackerClient`.
- Wiring: `ts/tsconfig.json`, `ts/apps/cli/{package.json,tsconfig.json}`, `ts/packages/mcp/{package.json,tsconfig.json}`.
- Create `ts/test/fixtures/workflow-local.md`; extend `ts/apps/cli/test/tracker-client.test.ts`.

Phase 3 (slack tracker):
- Modify `ts/packages/domain/src/index.ts` — add `"slack"`; add `channels?`, `emojiStates?` to `TrackerSettings`.
- Create package `ts/packages/slack-tracker/` (`package.json`, `tsconfig.json`, `src/transport.ts`, `src/inMemoryTransport.ts`, `src/webTransport.ts`, `src/mapping.ts`, `src/client.ts`, `src/index.ts`, `test/*.test.ts`).
- Create `ts/packages/mcp/src/tools/slack.ts`; add `slack` case to dispatcher; add 5th `deps` arg to `executeTool`.
- Modify `ts/packages/config/src/index.ts` — `channels`/`emojiStates` fields, `SLACK_BOT_TOKEN`, slack endpoint default, `validateDispatchConfig`.
- Modify `ts/apps/cli/src/daemon.ts` — `slack` case.
- Wiring: tsconfigs + package.jsons (cli, mcp).
- Create `ts/test/fixtures/workflow-slack.md`; extend `tracker-client.test.ts`.

---

# Phase 1 — Decouple (refactor only; all existing tests stay green)

### Task 1.1: Move Linear tool logic into `tools/linear.ts`

**Files:**
- Create: `ts/packages/mcp/src/tools/linear.ts`
- Modify: `ts/packages/mcp/src/tools.ts`

- [ ] **Step 1: Create `tools/linear.ts` with the current logic moved verbatim**

Copy the **entire current body** of `ts/packages/mcp/src/tools.ts` into `ts/packages/mcp/src/tools/linear.ts`, renaming the two public functions and keeping everything else (helpers, retry, validation) identical. Update the `Settings` import path (now one level deeper) and re-import the shared types from `../tools.js`:

```ts
import type { Settings } from "@symphony/domain";
import type { ToolResult, ToolSpec } from "../tools.js";

export function linearToolSpecs(): ToolSpec[] {
  return [
    {
      name: "linear_graphql",
      description: "Run a Linear GraphQL operation using Symphony tracker credentials.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, variables: { type: "object" } },
        required: ["query"],
      },
    },
  ];
}

export async function executeLinearTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  if (name !== "linear_graphql") {
    return toolFailure("Unsupported tool.", { supportedTools: ["linear_graphql"] });
  }
  // ... rest of the current executeTool body, unchanged ...
}

// move toolFailure, isRecord, normalizeLinearGraphqlInput, fetchWithRateLimitRetry,
// retryDelayMs, sleep here unchanged
```

- [ ] **Step 2: Replace `tools.ts` with the dispatcher**

```ts
import type { Settings, TrackerKind } from "@symphony/domain";

import { executeLinearTool, linearToolSpecs } from "./tools/linear.js";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Injectables for tests; production builds real clients from settings. */
export interface ToolDeps {
  now?: () => Date;
}

function trackerKind(settings: Settings): TrackerKind {
  return settings.tracker.kind ?? "linear";
}

function assertNever(value: never): never {
  throw new Error(`unhandled tracker kind: ${String(value)}`);
}

export function toolSpecs(settings: Settings): ToolSpec[] {
  const kind = trackerKind(settings);
  switch (kind) {
    case "linear":
      return linearToolSpecs();
    case "memory":
      return [];
    default:
      return assertNever(kind);
  }
}

export async function executeTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
  _deps: ToolDeps = {},
): Promise<ToolResult> {
  const kind = trackerKind(settings);
  switch (kind) {
    case "linear":
      return executeLinearTool(name, input, settings, fetchImpl);
    case "memory":
      return {
        success: false,
        error: "Unsupported tool.",
        result: { error: { message: "Unsupported tool.", supportedTools: [] } },
      };
    default:
      return assertNever(kind);
  }
}
```

- [ ] **Step 3: Run the existing tool-contract suite (must stay green unchanged)**

Run: `cd ts && pnpm exec vitest run packages/mcp/test/tools-contract.test.ts`
Expected: PASS (all `linear_graphql` tests; `executeTool("unknown", …)` still returns `supportedTools: ["linear_graphql"]` because `kind` is undefined → coalesced to `"linear"`).

- [ ] **Step 4: Commit**

```bash
cd ts && mise run tidy
git add packages/mcp/src/tools.ts packages/mcp/src/tools/linear.ts
git commit -m "refactor(mcp): split tracker tools into per-kind dispatcher"
```

### Task 1.2: Thread `settings` into `toolSpecs` call sites

**Files:**
- Modify: `ts/packages/codex/src/executor.ts:135`
- Modify: `ts/packages/server/src/index.ts:466`
- Modify: `ts/packages/mcp/src/server.ts:137`

- [ ] **Step 1: Update each call site**

- `executor.ts`: `dynamicTools: toolSpecs()` → `dynamicTools: toolSpecs(input.settings)`.
- `server/src/index.ts` line ~466: `tools: toolSpecs()` → `tools: toolSpecs(settings)`.
- `mcp/src/server.ts` line ~137: `tools: toolSpecs()` → `tools: toolSpecs(settings)`.

- [ ] **Step 2: Typecheck**

Run: `cd ts && pnpm typecheck`
Expected: PASS (no "Expected 1 argument, but got 0" errors).

- [ ] **Step 3: Commit**

```bash
cd ts && git add packages/codex/src/executor.ts packages/server/src/index.ts packages/mcp/src/server.ts
git commit -m "refactor(mcp): pass settings to toolSpecs at call sites"
```

### Task 1.3: Per-kind MCP server name

**Files:**
- Modify: `ts/packages/mcp/src/agentEndpoint.ts`
- Modify: `ts/packages/mcp/src/index.ts`
- Test: `ts/packages/mcp/test/server-name.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "vitest";

import { trackerMcpServerName } from "@symphony/mcp";

import { assert } from "../../../test/assert.js";

test("tracker MCP server name is derived per kind, default linear", () => {
  assert.equal(trackerMcpServerName("linear"), "symphony_linear");
  assert.equal(trackerMcpServerName("memory"), "symphony_memory");
  assert.equal(trackerMcpServerName(undefined), "symphony_linear");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd ts && pnpm exec vitest run packages/mcp/test/server-name.test.ts`
Expected: FAIL (`trackerMcpServerName` is not exported).

- [ ] **Step 3: Implement the helper and use it**

In `agentEndpoint.ts` add near the top:

```ts
import type { Settings, TrackerKind } from "@symphony/domain";

export function trackerMcpServerName(kind: TrackerKind | undefined): string {
  return `symphony_${kind ?? "linear"}`;
}
```

In `acquireAgentMcpEndpoint`, the `acpServer()` returns `name: "symphony_linear"` → change to `name: trackerMcpServerName(settings.tracker.kind)`.

Change `mcpConfigContents` to accept a server name (default keeps current behavior):

```ts
export function mcpConfigContents(
  serverUrl: string,
  token: string,
  serverName = "symphony_linear",
): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          type: "http",
          url: serverUrl,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )}\n`;
}
```

In `index.ts` add: `export { trackerMcpServerName } from "./agentEndpoint.js";` and `export type { ToolDeps } from "./tools.js";`.

- [ ] **Step 4: Update `mcpConfigContents` callers to pass the per-kind name**

Run: `cd ts && grep -rn "mcpConfigContents(" packages apps --include="*.ts" | grep -v ".test.ts" | grep -v "export "`
For each real call site, pass `trackerMcpServerName(settings.tracker.kind)` as the third argument (settings is in scope at these sites). If no runtime caller exists, skip.

- [ ] **Step 5: Run the test + typecheck**

Run: `cd ts && pnpm exec vitest run packages/mcp/test/server-name.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Full gate + commit**

Run: `cd ts && mise run check`
Expected: PASS.

```bash
cd ts && git add packages/mcp
git commit -m "feat(mcp): derive tracker MCP server name per kind (linear unchanged)"
```

---

# Phase 2 — Local (filesystem) tracker

### Task 2.1: Add `defaultStateType` to `@symphony/issue`

**Files:**
- Modify: `ts/packages/issue/src/index.ts`
- Test: `ts/packages/issue/test/state-type.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "vitest";

import { defaultStateType } from "@symphony/issue";

import { assert } from "../../../test/assert.js";

test("defaultStateType maps common workflow state names to categories", () => {
  assert.equal(defaultStateType("Todo"), "unstarted");
  assert.equal(defaultStateType("In Progress"), "started");
  assert.equal(defaultStateType("Done"), "completed");
  assert.equal(defaultStateType("Cancelled"), "canceled");
  assert.equal(defaultStateType("Canceled"), "canceled");
  assert.equal(defaultStateType("Backlog"), "backlog");
  assert.equal(defaultStateType("Triage"), "triage");
  assert.equal(defaultStateType("Something Else"), null);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd ts && pnpm exec vitest run packages/issue/test/state-type.test.ts`
Expected: FAIL (`defaultStateType` not exported).

- [ ] **Step 3: Implement**

Append to `ts/packages/issue/src/index.ts`:

```ts
const DEFAULT_STATE_TYPES: Record<string, IssueStateType> = {
  todo: "unstarted",
  "in progress": "started",
  done: "completed",
  cancelled: "canceled",
  canceled: "canceled",
  backlog: "backlog",
  triage: "triage",
};

/** Best-effort category for a free-form workflow state name; null when unknown. */
export function defaultStateType(name: string): IssueStateType | null {
  return DEFAULT_STATE_TYPES[name.trim().toLowerCase()] ?? null;
}
```

- [ ] **Step 4: Run the test**

Run: `cd ts && pnpm exec vitest run packages/issue/test/state-type.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ts && mise run tidy
git add packages/issue
git commit -m "feat(issue): add defaultStateType state-name category map"
```

### Task 2.2: Domain — add `local` kind and `path`

**Files:**
- Modify: `ts/packages/domain/src/index.ts:15`, `:144`

- [ ] **Step 1: Edit the union and settings**

```ts
export const TRACKER_KINDS = ["linear", "memory", "local"] as const;
```

In `TrackerSettings` add (after `assignee?`):

```ts
  /** Local tracker board directory (e.g. `.symphony/board`). Used when `kind === "local"`. */
  path?: string | undefined;
```

- [ ] **Step 2: Typecheck to surface the exhaustive-switch errors (expected)**

Run: `cd ts && pnpm typecheck`
Expected: FAIL — `assertNever(kind)` in `mcp/src/tools.ts` and the `if`s in `daemon.ts`/`config` now see an unhandled `"local"`. These are fixed in Tasks 2.3–2.6. (Do not commit yet.)

### Task 2.3: `local-tracker` package scaffold

**Files:**
- Create: `ts/packages/local-tracker/package.json`, `tsconfig.json`
- Modify: `ts/tsconfig.json`

- [ ] **Step 1: package.json**

```json
{
  "name": "@symphony/local-tracker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "yaml": "^2.8.0",
    "@symphony/issue": "workspace:*",
    "@symphony/domain": "workspace:*"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../domain" }, { "path": "../issue" }]
}
```

- [ ] **Step 3: Add to root `ts/tsconfig.json` references**

Add `{ "path": "./packages/local-tracker" }` to the `references` array.

- [ ] **Step 4: Install workspace links**

Run: `cd ts && pnpm install`
Expected: lockfile updates, no errors.

### Task 2.4: `BoardStore` (TDD)

**Files:**
- Create: `ts/packages/local-tracker/src/boardStore.ts`
- Test: `ts/packages/local-tracker/test/board-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";

import { BoardStore } from "@symphony/local-tracker";

import { assert } from "../../../test/assert.js";

async function tempBoard(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "board-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

test("create allocates incrementing BOARD ids and round-trips", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);

  const a = await store.create({ title: "First", body: "Body A", status: "Todo" });
  const b = await store.create({ title: "Second" });
  assert.deepEqual([a.identifier, b.identifier], ["BOARD-1", "BOARD-2"]);
  assert.equal(a.id, "BOARD-1");
  assert.equal(a.title, "First");
  assert.equal(a.description, "Body A");
  assert.equal(a.state, "Todo");
  assert.equal(a.stateType, "unstarted");
  assert.equal(b.state, "Todo");

  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /status: Todo/);
  assert.match(file, /# First/);
});

test("updateStatus rewrites only the status and preserves body", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "Fix it", body: "Details here", status: "Todo" });

  const updated = await store.updateStatus("BOARD-1", "In Progress");
  assert.equal(updated.state, "In Progress");
  assert.equal(updated.stateType, "started");
  assert.equal(updated.description, "Details here");
});

test("appendComment adds a Comments section without touching description", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "T", body: "Desc", status: "Todo" });

  await store.appendComment("BOARD-1", "opened PR #42", () => new Date("2026-05-29T10:00:00Z"));
  await store.appendComment("BOARD-1", "checks green", () => new Date("2026-05-29T11:00:00Z"));

  const issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.description, "Desc");
  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /## Comments/);
  assert.match(file, /- 2026-05-29T10:00:00.000Z agent: opened PR #42/);
  assert.match(file, /- 2026-05-29T11:00:00.000Z agent: checks green/);
});

test("byStatus filters case-insensitively; getByIds preserves order and skips missing", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "One", status: "Todo" });
  await store.create({ title: "Two", status: "Done" });
  await store.create({ title: "Three", status: "in progress" });

  const active = await store.byStatus(["todo", "In Progress"]);
  assert.deepEqual(active.map((i) => i.identifier).sort(), ["BOARD-1", "BOARD-3"]);

  const byId = await store.getByIds(["BOARD-2", "BOARD-404", "BOARD-1"]);
  assert.deepEqual(byId.map((i) => i.identifier), ["BOARD-2", "BOARD-1"]);
});

test("labels parse from frontmatter and lower-case; title falls back to id", async () => {
  const dir = await tempBoard();
  await writeFile(
    path.join(dir, "BOARD-7.md"),
    "---\nstatus: Todo\nlabels:\n  - Backend\n  - Symphony:API\n---\n\nNo heading body\n",
    "utf8",
  );
  const store = new BoardStore(dir);
  const issue = (await store.getByIds(["BOARD-7"]))[0]!;
  assert.deepEqual(issue.labels, ["backend", "symphony:api"]);
  assert.equal(issue.title, "BOARD-7");
  assert.equal(issue.description, "No heading body");
});

test("missing status throws a clear error", async () => {
  const dir = await tempBoard();
  await writeFile(path.join(dir, "BOARD-9.md"), "---\nlabels: []\n---\n# T\n", "utf8");
  const store = new BoardStore(dir);
  await assert.rejects(() => store.getByIds(["BOARD-9"]), /BOARD-9.*status/);
});
```

> If `assert.rejects` is not present in `test/assert.ts`, add it: an async helper that awaits the thunk, fails if it resolves, and matches the error message against the pattern (mirror the sync `throws`).

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd ts && pnpm exec vitest run packages/local-tracker/test/board-store.test.ts`
Expected: FAIL (`BoardStore` not found).

- [ ] **Step 3: Implement `boardStore.ts`**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultStateType, normalizeIssue } from "@symphony/issue";
import type { Issue } from "@symphony/domain";

interface ParsedFile {
  status: string;
  labels: string[];
  title: string;
  description: string;
  comments: string;
}

export class BoardStore {
  constructor(private readonly dir: string) {}

  async list(): Promise<Issue[]> {
    const ids = await this.issueIds();
    const out: Issue[] = [];
    for (const id of ids) out.push(await this.read(id));
    return out;
  }

  async getByIds(ids: string[]): Promise<Issue[]> {
    const existing = new Set(await this.issueIds());
    const out: Issue[] = [];
    for (const id of ids) if (existing.has(id)) out.push(await this.read(id));
    return out;
  }

  async byStatus(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map((s) => s.trim().toLowerCase()));
    return (await this.list()).filter((i) => wanted.has(i.state.trim().toLowerCase()));
  }

  async updateStatus(id: string, status: string): Promise<Issue> {
    const parsed = await this.parse(id);
    parsed.status = status;
    await this.write(id, parsed);
    return this.read(id);
  }

  async appendComment(id: string, body: string, now: () => Date = () => new Date()): Promise<void> {
    const parsed = await this.parse(id);
    const line = `- ${now().toISOString()} agent: ${body}`;
    parsed.comments = parsed.comments ? `${parsed.comments}\n${line}` : line;
    await this.write(id, parsed);
  }

  async create(input: { title: string; body?: string; status?: string }): Promise<Issue> {
    const id = await this.nextId();
    await this.write(id, {
      status: input.status ?? "Todo",
      labels: [],
      title: input.title,
      description: input.body ?? "",
      comments: "",
    });
    return this.read(id);
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.md`);
  }

  private async issueIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    return entries
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort((a, b) => boardNumber(a) - boardNumber(b));
  }

  private async nextId(): Promise<string> {
    let max = 0;
    for (const id of await this.issueIds()) max = Math.max(max, boardNumber(id));
    return `BOARD-${max + 1}`;
  }

  private async read(id: string): Promise<Issue> {
    const parsed = await this.parse(id);
    const stat = await fs.stat(this.filePath(id));
    const stateType = defaultStateType(parsed.status);
    return normalizeIssue({
      id,
      identifier: id,
      title: parsed.title.trim() === "" ? id : parsed.title,
      description: parsed.description === "" ? null : parsed.description,
      state: parsed.status,
      ...(stateType ? { state_type: stateType } : {}),
      labels: parsed.labels,
      created_at: stat.birthtime.toISOString(),
      updated_at: stat.mtime.toISOString(),
    });
  }

  private async parse(id: string): Promise<ParsedFile> {
    const raw = await fs.readFile(this.filePath(id), "utf8");
    const { frontmatter, body } = splitFrontmatter(raw);
    const fm = (frontmatter ? parseYaml(frontmatter) : {}) as Record<string, unknown>;
    const status = typeof fm.status === "string" ? fm.status : "";
    if (status.trim() === "") throw new Error(`board issue ${id} is missing required 'status'`);
    const labels = Array.isArray(fm.labels)
      ? fm.labels.filter((l): l is string => typeof l === "string")
      : [];
    return { status, labels, ...splitBody(body) };
  }

  private async write(id: string, p: ParsedFile): Promise<void> {
    const fm: Record<string, unknown> = { status: p.status };
    if (p.labels.length > 0) fm.labels = p.labels;
    const sections = [`---\n${stringifyYaml(fm).trimEnd()}\n---`, `# ${p.title}`];
    if (p.description.trim() !== "") sections.push(p.description.trim());
    if (p.comments.trim() !== "") sections.push(`## Comments\n${p.comments.trim()}`);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath(id), `${sections.join("\n\n")}\n`, "utf8");
  }
}

function boardNumber(id: string): number {
  const m = /^BOARD-(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  if (!raw.startsWith("---")) return { frontmatter: null, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: raw };
  const frontmatter = raw.slice(raw.indexOf("\n") + 1, end);
  const afterClose = raw.indexOf("\n", end + 1);
  const body = afterClose === -1 ? "" : raw.slice(afterClose + 1);
  return { frontmatter, body };
}

function splitBody(body: string): { title: string; description: string; comments: string } {
  const commentsIdx = body.indexOf("\n## Comments");
  const main = commentsIdx === -1 ? body : body.slice(0, commentsIdx);
  const comments =
    commentsIdx === -1
      ? ""
      : main.length === body.length
        ? ""
        : body.slice(commentsIdx).replace(/^\n## Comments\n?/, "");
  const lines = main.split("\n");
  const headingIdx = lines.findIndex((l) => l.startsWith("# "));
  const title = headingIdx === -1 ? "" : lines[headingIdx]!.slice(2).trim();
  const descLines = headingIdx === -1 ? lines : lines.slice(headingIdx + 1);
  return { title, description: descLines.join("\n").trim(), comments: comments.trim() };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ts && pnpm exec vitest run packages/local-tracker/test/board-store.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
cd ts && mise run tidy
git add packages/local-tracker test/assert.ts
git commit -m "feat(local-tracker): BoardStore filesystem issue store"
```

### Task 2.5: `LocalTrackerClient` (TDD) + package index

**Files:**
- Create: `ts/packages/local-tracker/src/client.ts`, `ts/packages/local-tracker/src/index.ts`
- Test: `ts/packages/local-tracker/test/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";

import { BoardStore, LocalTrackerClient } from "@symphony/local-tracker";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

test("LocalTrackerClient reads candidates by active states from the board dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "board-client-"));
  await mkdir(dir, { recursive: true });
  const store = new BoardStore(dir);
  await store.create({ title: "Active", status: "Todo" });
  await store.create({ title: "Done", status: "Done" });

  const settings = parseConfig(
    { tracker: { kind: "local", path: dir, active_states: ["Todo"], terminal_states: ["Done"] } },
    {},
  );
  const client = new LocalTrackerClient(settings);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(candidates.map((i) => i.identifier), ["BOARD-1"]);
  assert.deepEqual((await client.fetchIssuesByStates(["Done"])).map((i) => i.identifier), ["BOARD-2"]);
  assert.deepEqual((await client.fetchIssuesByIds(["BOARD-2"])).map((i) => i.title), ["Done"]);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd ts && pnpm exec vitest run packages/local-tracker/test/client.test.ts`
Expected: FAIL (`LocalTrackerClient` not exported).

- [ ] **Step 3: Implement `client.ts` and `index.ts`**

`client.ts`:

```ts
import path from "node:path";

import type { Issue, RuntimeTrackerClient, Settings } from "@symphony/domain";

import { BoardStore } from "./boardStore.js";

const DEFAULT_DIR = ".symphony/board";

export class LocalTrackerClient implements RuntimeTrackerClient {
  private readonly store: BoardStore;

  constructor(
    private readonly settings: Settings,
    cwd: string = process.cwd(),
  ) {
    const configured = settings.tracker.path ?? DEFAULT_DIR;
    const dir = path.isAbsolute(configured) ? configured : path.join(cwd, configured);
    this.store = new BoardStore(dir);
  }

  fetchCandidateIssues(): Promise<Issue[]> {
    return this.store.byStatus(this.settings.tracker.activeStates);
  }

  fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    return this.store.getByIds(ids);
  }

  fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    return this.store.byStatus(states);
  }
}
```

`index.ts`:

```ts
export { BoardStore } from "./boardStore.js";
export { LocalTrackerClient } from "./client.js";
```

- [ ] **Step 4: Run the test**

Run: `cd ts && pnpm exec vitest run packages/local-tracker/test/client.test.ts`
Expected: PASS.

> Note: this test imports `@symphony/config` with `kind: "local"` and `path`, which requires Task 2.6's config changes. If running 2.5 before 2.6, expect a parse/validation error and complete 2.6 first. Recommended: implement 2.6 then re-run 2.5.

- [ ] **Step 5: Commit**

```bash
cd ts && mise run tidy
git add packages/local-tracker
git commit -m "feat(local-tracker): LocalTrackerClient read adapter"
```

### Task 2.6: Config — `path` field, default, validation

**Files:**
- Modify: `ts/packages/config/src/index.ts` (schema `:49`, defaults `:267`, `parseTracker` `:435`, `validateDispatchConfig` `:398`)
- Test: `ts/packages/config/test/config.test.ts` (add cases)

- [ ] **Step 1: Add the schema field**

In `trackerRawSchema` (line ~49) add `path: z.unknown().optional(),`.

- [ ] **Step 2: Add the default**

In `defaultSettings` tracker block (line ~267) add `path: ".symphony/board",` after `endpoint`.

- [ ] **Step 3: Parse it**

In `parseTracker` return object add: `path: stringValue(trackerRaw.path, defaults.path ?? ".symphony/board"),`.

- [ ] **Step 4: Validate it**

In `validateDispatchConfig`, after the linear block add:

```ts
  if (settings.tracker.kind === "local") {
    if (!settings.tracker.path || settings.tracker.path.trim() === "") {
      throw new Error("tracker.path is required");
    }
  }
```

- [ ] **Step 5: Write the failing config test**

Add to `config.test.ts`:

```ts
test("parses local tracker config with path", () => {
  const settings = parseConfig(
    { tracker: { kind: "local", path: ".symphony/board", active_states: ["Todo"] } },
    {},
  );
  assert.equal(settings.tracker.kind, "local");
  assert.equal(settings.tracker.path, ".symphony/board");
});
```

- [ ] **Step 6: Run config tests + typecheck (exhaustive switches still failing in mcp/daemon until 2.7)**

Run: `cd ts && pnpm exec vitest run packages/config/test/config.test.ts`
Expected: PASS for the new test.

- [ ] **Step 7: Commit**

```bash
cd ts && mise run tidy
git add packages/config
git commit -m "feat(config): local tracker path field, default, validation"
```

### Task 2.7: MCP `local` tools + factory wiring + fixture

**Files:**
- Create: `ts/packages/mcp/src/tools/local.ts`, `ts/test/fixtures/workflow-local.md`
- Modify: `ts/packages/mcp/src/tools.ts`, `ts/packages/mcp/package.json`, `ts/packages/mcp/tsconfig.json`, `ts/apps/cli/src/daemon.ts`, `ts/apps/cli/package.json`, `ts/apps/cli/tsconfig.json`
- Test: `ts/packages/mcp/test/local-tools.test.ts`, extend `ts/apps/cli/test/tracker-client.test.ts`

- [ ] **Step 1: Add `@symphony/local-tracker` deps + tsconfig refs**

- `packages/mcp/package.json` dependencies: add `"@symphony/local-tracker": "workspace:*"`.
- `packages/mcp/tsconfig.json` references: add `{ "path": "../local-tracker" }`.
- `apps/cli/package.json` dependencies: add `"@symphony/local-tracker": "workspace:*"`.
- `apps/cli/tsconfig.json` references: add `{ "path": "../../packages/local-tracker" }`.
- Run: `cd ts && pnpm install`.

- [ ] **Step 2: Write the failing local-tools test**

```ts
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";

import { executeTool, toolSpecs } from "@symphony/mcp";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

async function localSettings() {
  const dir = await mkdtemp(path.join(tmpdir(), "board-tools-"));
  await mkdir(dir, { recursive: true });
  return { dir, settings: parseConfig({ tracker: { kind: "local", path: dir } }, {}) };
}

test("local toolSpecs lists the three board tools", async () => {
  const { settings } = await localSettings();
  assert.deepEqual(
    toolSpecs(settings).map((t) => t.name),
    ["local_update_status", "local_comment", "local_create_issue"],
  );
});

test("local tools create, update status, and comment on the board", async () => {
  const { dir, settings } = await localSettings();

  const created = await executeTool("local_create_issue", { title: "Fix it", status: "Todo" }, settings);
  assert.equal(created.success, true);

  const moved = await executeTool(
    "local_update_status",
    { issueId: "BOARD-1", status: "In Progress" },
    settings,
  );
  assert.equal(moved.success, true);

  const commented = await executeTool(
    "local_comment",
    { issueId: "BOARD-1", body: "opened PR" },
    settings,
  );
  assert.equal(commented.success, true);

  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /status: In Progress/);
  assert.match(file, /agent: opened PR/);
});

test("local tools reject unknown names", async () => {
  const { settings } = await localSettings();
  const result = await executeTool("local_bogus", {}, settings);
  assert.equal(result.success, false);
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd ts && pnpm exec vitest run packages/mcp/test/local-tools.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `tools/local.ts`**

```ts
import path from "node:path";

import { BoardStore } from "@symphony/local-tracker";
import type { Settings } from "@symphony/domain";

import type { ToolResult, ToolSpec } from "../tools.js";

const TOOL_NAMES = ["local_update_status", "local_comment", "local_create_issue"] as const;

export function localToolSpecs(): ToolSpec[] {
  return [
    {
      name: "local_update_status",
      description: "Move a local board issue to a new status. Args: issueId, status.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, status: { type: "string" } },
        required: ["issueId", "status"],
      },
    },
    {
      name: "local_comment",
      description: "Append a comment to a local board issue. Args: issueId, body.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
      },
    },
    {
      name: "local_create_issue",
      description: "Create a new local board issue. Args: title, body?, status?.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" }, status: { type: "string" } },
        required: ["title"],
      },
    },
  ];
}

export async function executeLocalTool(
  name: string,
  input: unknown,
  settings: Settings,
): Promise<ToolResult> {
  const store = storeFor(settings);
  const args = isRecord(input) ? input : {};
  try {
    switch (name) {
      case "local_update_status": {
        const issue = await store.updateStatus(requireStr(args, "issueId"), requireStr(args, "status"));
        return { success: true, result: { issue } };
      }
      case "local_comment": {
        await store.appendComment(requireStr(args, "issueId"), requireStr(args, "body"));
        return { success: true, result: { ok: true } };
      }
      case "local_create_issue": {
        const issue = await store.create({
          title: requireStr(args, "title"),
          body: optStr(args.body),
          status: optStr(args.status),
        });
        return { success: true, result: { issue } };
      }
      default:
        return {
          success: false,
          error: "Unsupported tool.",
          result: { error: { message: "Unsupported tool.", supportedTools: [...TOOL_NAMES] } },
        };
    }
  } catch (error) {
    const message = (error as Error).message;
    return { success: false, error: message, result: { error: { message } } };
  }
}

function storeFor(settings: Settings): BoardStore {
  const configured = settings.tracker.path ?? ".symphony/board";
  return new BoardStore(path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
```

- [ ] **Step 5: Add the `local` case to the dispatcher**

In `tools.ts` add `import { executeLocalTool, localToolSpecs } from "./tools/local.js";`, then add to both switches:

```ts
    case "local":
      return localToolSpecs();        // in toolSpecs
    case "local":
      return executeLocalTool(name, input, settings);   // in executeTool
```

- [ ] **Step 6: Add the `local` case to the factory**

In `daemon.ts` add `import { LocalTrackerClient } from "@symphony/local-tracker";` and in `createTrackerClient`:

```ts
  if (settings.tracker.kind === "local") return new LocalTrackerClient(settings);
```

- [ ] **Step 7: Create the test fixture**

`ts/test/fixtures/workflow-local.md`:

```markdown
---
tracker:
  kind: local
  path: .symphony/board
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
---

Local board workflow fixture (test only).
```

- [ ] **Step 8: Extend the factory test to cover local + fixture**

Add to `ts/apps/cli/test/tracker-client.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { LocalTrackerClient } from "@symphony/local-tracker";

function frontmatter(raw: string): Record<string, unknown> {
  const end = raw.indexOf("\n---", 3);
  return parseYaml(raw.slice(raw.indexOf("\n") + 1, end)) as Record<string, unknown>;
}

test("tracker factory selects local adapter from the workflow-local fixture", async () => {
  const raw = await readFile(
    path.join(import.meta.dirname, "../../../test/fixtures/workflow-local.md"),
    "utf8",
  );
  const settings = parseConfig(frontmatter(raw), {});
  assert.equal(settings.tracker.kind, "local");
  assert.ok(createTrackerClient(settings) instanceof LocalTrackerClient);
});
```

> If `@symphony/local-tracker` and `yaml` are not yet importable from the cli test, ensure Step 1 deps + `pnpm install` ran. `import.meta.dirname` requires Node ≥ 20; if unavailable, derive the dir via `path.dirname(new URL(import.meta.url).pathname)`.

- [ ] **Step 9: Run targeted tests + full gate**

Run: `cd ts && pnpm exec vitest run packages/mcp/test/local-tools.test.ts apps/cli/test/tracker-client.test.ts packages/local-tracker`
Expected: PASS.

Run: `cd ts && mise run check`
Expected: PASS (typecheck now clean — every exhaustive switch handles `local`).

- [ ] **Step 10: Commit**

```bash
cd ts && mise run tidy
git add packages/mcp apps/cli test/fixtures/workflow-local.md ts/tsconfig.json pnpm-lock.yaml 2>/dev/null; git add -A
git commit -m "feat(local-tracker): wire factory, MCP tools, and config fixture"
```

---

# Phase 3 — Slack tracker

### Task 3.1: Domain — add `slack` kind and fields

**Files:**
- Modify: `ts/packages/domain/src/index.ts:15`, `:144`

- [ ] **Step 1: Edit**

```ts
export const TRACKER_KINDS = ["linear", "memory", "local", "slack"] as const;
```

In `TrackerSettings` add:

```ts
  /** Slack channel IDs to watch for mentions. Used when `kind === "slack"`. */
  channels?: string[] | undefined;
  /** Slack emoji-name → workflow-state overrides (merged over defaults). */
  emojiStates?: Record<string, string> | undefined;
```

- [ ] **Step 2: Typecheck (expected to fail on exhaustive switches until 3.x)**

Run: `cd ts && pnpm typecheck`
Expected: FAIL — `assertNever` in `tools.ts` and `if`s in `daemon.ts`/`config` now see `"slack"`. Fixed below.

### Task 3.2: `slack-tracker` package scaffold + mapping (TDD)

**Files:**
- Create: `ts/packages/slack-tracker/{package.json,tsconfig.json}`, `src/transport.ts`, `src/mapping.ts`
- Modify: `ts/tsconfig.json`
- Test: `ts/packages/slack-tracker/test/mapping.test.ts`

- [ ] **Step 1: package.json**

```json
{
  "name": "@symphony/slack-tracker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@symphony/issue": "workspace:*",
    "@symphony/domain": "workspace:*"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../domain" }, { "path": "../issue" }]
}
```

Add `{ "path": "./packages/slack-tracker" }` to root `ts/tsconfig.json` references. Run `cd ts && pnpm install`.

- [ ] **Step 3: `transport.ts` (types only)**

```ts
export interface SlackMessage {
  channel: string;
  ts: string;
  text: string;
  reactions: string[];
}

export interface SlackTransport {
  listMentions(channels: string[], opts?: { sinceTs?: string }): Promise<SlackMessage[]>;
  getMessage(channel: string, ts: string): Promise<SlackMessage | null>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
  postReply(channel: string, threadTs: string, body: string): Promise<void>;
}
```

- [ ] **Step 4: Write the failing mapping test**

```ts
import { test } from "vitest";

import {
  DEFAULT_EMOJI_STATES,
  emojiForState,
  stateFromReactions,
  statusEmojiMap,
} from "@symphony/slack-tracker";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

test("default emoji map yields Todo with no status reactions and maps the rest", () => {
  const map = DEFAULT_EMOJI_STATES;
  assert.equal(stateFromReactions([], map), "Todo");
  assert.equal(stateFromReactions(["thumbsup", "eyes"], map), "In Progress");
  assert.equal(stateFromReactions(["white_check_mark"], map), "Done");
  assert.equal(stateFromReactions(["x"], map), "Cancelled");
});

test("emojiForState reverse-looks-up the configured emoji", () => {
  const map = DEFAULT_EMOJI_STATES;
  assert.equal(emojiForState("In Progress", map), "eyes");
  assert.equal(emojiForState("done", map), "white_check_mark");
  assert.equal(emojiForState("Todo", map), null);
});

test("statusEmojiMap merges config overrides over defaults", () => {
  const settings = parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], emoji_states: { rocket: "Shipped" } } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  const map = statusEmojiMap(settings);
  assert.equal(map.rocket, "Shipped");
  assert.equal(map.eyes, "In Progress");
});
```

- [ ] **Step 5: Run to confirm failure**

Run: `cd ts && pnpm exec vitest run packages/slack-tracker/test/mapping.test.ts`
Expected: FAIL (exports missing; also needs config from Task 3.5 — implement mapping first, expect the third test to fail until 3.5).

- [ ] **Step 6: Implement `mapping.ts`**

```ts
import type { Settings } from "@symphony/domain";

export const DEFAULT_EMOJI_STATES: Record<string, string> = {
  eyes: "In Progress",
  white_check_mark: "Done",
  x: "Cancelled",
};

export function statusEmojiMap(settings: Settings): Record<string, string> {
  return { ...DEFAULT_EMOJI_STATES, ...(settings.tracker.emojiStates ?? {}) };
}

/** Derive state from the reactions present; the first matching status emoji wins, else "Todo". */
export function stateFromReactions(reactions: string[], map: Record<string, string>): string {
  for (const reaction of reactions) {
    const state = map[reaction];
    if (state) return state;
  }
  return "Todo";
}

/** Reverse lookup: the emoji name whose mapped state equals `state` (case-insensitive). */
export function emojiForState(state: string, map: Record<string, string>): string | null {
  const target = state.trim().toLowerCase();
  for (const [emoji, mapped] of Object.entries(map)) {
    if (mapped.trim().toLowerCase() === target) return emoji;
  }
  return null;
}
```

- [ ] **Step 7: Run mapping tests (first two pass now; third after Task 3.5)**

Run: `cd ts && pnpm exec vitest run packages/slack-tracker/test/mapping.test.ts -t "default emoji map"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd ts && mise run tidy
git add packages/slack-tracker ts/tsconfig.json pnpm-lock.yaml 2>/dev/null; git add -A
git commit -m "feat(slack-tracker): transport interface and emoji-state mapping"
```

### Task 3.3: `InMemorySlackTransport` + `SlackTrackerClient` (TDD)

**Files:**
- Create: `ts/packages/slack-tracker/src/inMemoryTransport.ts`, `src/client.ts`, `src/index.ts`
- Test: `ts/packages/slack-tracker/test/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "vitest";

import {
  InMemorySlackTransport,
  SlackTrackerClient,
} from "@symphony/slack-tracker";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

function settings() {
  return parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], active_states: ["Todo", "In Progress"] } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
}

test("mentions become issues; reactions drive state", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      { ts: "1700000000.000100", text: "<@U_BOT> fix the flaky test\nmore detail", reactions: [] },
      { ts: "1700000000.000200", text: "<@U_BOT> ship docs", reactions: ["white_check_mark"] },
    ],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(candidates.map((i) => i.title), ["fix the flaky test"]);
  assert.equal(candidates[0]!.id, "C1:1700000000.000100");
  assert.equal(candidates[0]!.state, "Todo");
  assert.equal(candidates[0]!.description, "<@U_BOT> fix the flaky test\nmore detail");

  const byId = await client.fetchIssuesByIds(["C1:1700000000.000200"]);
  assert.deepEqual(byId.map((i) => i.state), ["Done"]);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd ts && pnpm exec vitest run packages/slack-tracker/test/client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `inMemoryTransport.ts`**

```ts
import type { SlackMessage, SlackTransport } from "./transport.js";

interface SeedMessage {
  ts: string;
  text: string;
  reactions?: string[];
}

export class InMemorySlackTransport implements SlackTransport {
  readonly replies: Array<{ channel: string; threadTs: string; body: string }> = [];
  private readonly messages: Map<string, SlackMessage[]> = new Map();

  constructor(seed: Record<string, SeedMessage[]> = {}) {
    for (const [channel, msgs] of Object.entries(seed)) {
      this.messages.set(
        channel,
        msgs.map((m) => ({ channel, ts: m.ts, text: m.text, reactions: [...(m.reactions ?? [])] })),
      );
    }
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for (const channel of channels) {
      for (const m of this.messages.get(channel) ?? []) {
        if (/<@[A-Z0-9]+>/.test(m.text)) out.push({ ...m, reactions: [...m.reactions] });
      }
    }
    return out;
  }

  async getMessage(channel: string, ts: string): Promise<SlackMessage | null> {
    const found = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    return found ? { ...found, reactions: [...found.reactions] } : null;
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    const msg = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    if (msg && !msg.reactions.includes(name)) msg.reactions.push(name);
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    const msg = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    if (msg) msg.reactions = msg.reactions.filter((r) => r !== name);
  }

  async postReply(channel: string, threadTs: string, body: string): Promise<void> {
    this.replies.push({ channel, threadTs, body });
  }
}
```

- [ ] **Step 4: Implement `client.ts`**

```ts
import { defaultStateType, normalizeIssue } from "@symphony/issue";
import type { Issue, RuntimeTrackerClient, Settings } from "@symphony/domain";

import { stateFromReactions, statusEmojiMap } from "./mapping.js";
import type { SlackMessage, SlackTransport } from "./transport.js";

export function splitIssueId(id: string): [string, string] | null {
  const idx = id.indexOf(":");
  if (idx === -1) return null;
  return [id.slice(0, idx), id.slice(idx + 1)];
}

export class SlackTrackerClient implements RuntimeTrackerClient {
  constructor(
    private readonly settings: Settings,
    private readonly transport: SlackTransport,
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    const issues = (await this.transport.listMentions(this.channels())).map((m) => this.toIssue(m));
    const active = new Set(this.settings.tracker.activeStates.map((s) => s.trim().toLowerCase()));
    return issues.filter((i) => active.has(i.state.trim().toLowerCase()));
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const out: Issue[] = [];
    for (const id of ids) {
      const parts = splitIssueId(id);
      if (!parts) continue;
      const msg = await this.transport.getMessage(parts[0], parts[1]);
      if (msg) out.push(this.toIssue(msg));
    }
    return out;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map((s) => s.trim().toLowerCase()));
    const issues = (await this.transport.listMentions(this.channels())).map((m) => this.toIssue(m));
    return issues.filter((i) => wanted.has(i.state.trim().toLowerCase()));
  }

  private channels(): string[] {
    return this.settings.tracker.channels ?? [];
  }

  private toIssue(message: SlackMessage): Issue {
    const state = stateFromReactions(message.reactions, statusEmojiMap(this.settings));
    const title = (message.text.split("\n")[0] ?? "").trim() || message.ts;
    const stateType = defaultStateType(state);
    return normalizeIssue({
      id: `${message.channel}:${message.ts}`,
      identifier: `SLK-${message.ts.replace(/\./g, "-")}`,
      title,
      description: message.text,
      state,
      ...(stateType ? { state_type: stateType } : {}),
      labels: [],
      raw: message,
    });
  }
}
```

- [ ] **Step 5: `index.ts`**

```ts
export type { SlackMessage, SlackTransport } from "./transport.js";
export { InMemorySlackTransport } from "./inMemoryTransport.js";
export { SlackWebTransport } from "./webTransport.js";
export { SlackTrackerClient, splitIssueId } from "./client.js";
export {
  DEFAULT_EMOJI_STATES,
  emojiForState,
  stateFromReactions,
  statusEmojiMap,
} from "./mapping.js";
```

> `SlackWebTransport` is created in Task 3.4; if running tests before 3.4, omit that export line temporarily.

- [ ] **Step 6: Run the client test**

Run: `cd ts && pnpm exec vitest run packages/slack-tracker/test/client.test.ts`
Expected: PASS (requires Task 3.5 config support for `kind: "slack"`; if it errors on parse, do Task 3.5 first then re-run).

- [ ] **Step 7: Commit**

```bash
cd ts && mise run tidy
git add packages/slack-tracker
git commit -m "feat(slack-tracker): in-memory transport and read client"
```

### Task 3.4: `SlackWebTransport` (fetch-based, minimal) (TDD)

**Files:**
- Create: `ts/packages/slack-tracker/src/webTransport.ts`
- Test: `ts/packages/slack-tracker/test/web-transport.test.ts`

- [ ] **Step 1: Write the failing test (fetch mock asserts request shape + auth)**

```ts
import { test } from "vitest";

import { SlackWebTransport } from "@symphony/slack-tracker";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

function settings() {
  return parseConfig({ tracker: { kind: "slack", channels: ["C1"] } }, { SLACK_BOT_TOKEN: "xoxb-abc" });
}

test("listMentions calls conversations.history with auth and parses messages", async () => {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "1.1", text: "<@U1> hi", reactions: [{ name: "eyes", count: 1 }] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl);
  const messages = await transport.listMentions(["C1"]);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]!.reactions, ["eyes"]);
  assert.equal(messages[0]!.channel, "C1");
  assert.match(calls[0]!.url, /\/conversations\.history\?/);
  assert.match(calls[0]!.url, /channel=C1/);
  assert.equal(calls[0]!.auth, "Bearer xoxb-abc");
});

test("addReaction posts to reactions.add", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await new SlackWebTransport(settings(), fetchImpl).addReaction("C1", "1.1", "eyes");
  assert.match(calls[0]!, /\/reactions\.add/);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd ts && pnpm exec vitest run packages/slack-tracker/test/web-transport.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `webTransport.ts`**

```ts
import type { Settings } from "@symphony/domain";

import type { SlackMessage, SlackTransport } from "./transport.js";

interface RawSlackMessage {
  ts?: string;
  text?: string;
  reactions?: Array<{ name?: string }>;
}

export class SlackWebTransport implements SlackTransport {
  private readonly endpoint: string;
  private readonly token: string;

  constructor(
    settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.endpoint = (settings.tracker.endpoint || "https://slack.com/api").replace(/\/+$/, "");
    this.token = settings.tracker.apiKey ?? "";
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for (const channel of channels) {
      const body = await this.get("conversations.history", { channel, limit: "200" });
      const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
      for (const m of messages) {
        if (typeof m.ts !== "string") continue;
        if (!/<@[A-Z0-9]+>/.test(m.text ?? "")) continue;
        out.push(toMessage(channel, m));
      }
    }
    return out;
  }

  async getMessage(channel: string, ts: string): Promise<SlackMessage | null> {
    const body = await this.get("conversations.history", {
      channel,
      latest: ts,
      inclusive: "true",
      limit: "1",
    });
    const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
    const found = messages.find((m) => m.ts === ts);
    return found ? toMessage(channel, found) : null;
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    await this.post("reactions.add", { channel, timestamp: ts, name });
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    await this.post("reactions.remove", { channel, timestamp: ts, name });
  }

  async postReply(channel: string, threadTs: string, body: string): Promise<void> {
    await this.post("chat.postMessage", { channel, thread_ts: threadTs, text: body });
  }

  private async get(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = `${this.endpoint}/${method}?${new URLSearchParams(params).toString()}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    return this.parse(method, response);
  }

  private async post(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.endpoint}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });
    return this.parse(method, response);
  }

  private async parse(method: string, response: Response): Promise<Record<string, unknown>> {
    const body = (await response.json()) as Record<string, unknown>;
    if (body.ok !== true) throw new Error(`slack ${method} failed: ${String(body.error ?? response.status)}`);
    return body;
  }
}

function toMessage(channel: string, m: RawSlackMessage): SlackMessage {
  return {
    channel,
    ts: m.ts ?? "",
    text: m.text ?? "",
    reactions: (m.reactions ?? [])
      .map((r) => r.name)
      .filter((n): n is string => typeof n === "string"),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `cd ts && pnpm exec vitest run packages/slack-tracker/test/web-transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ts && mise run tidy
git add packages/slack-tracker
git commit -m "feat(slack-tracker): minimal fetch-based Slack Web transport"
```

### Task 3.5: Config — slack fields, token env, endpoint default, validation

**Files:**
- Modify: `ts/packages/config/src/index.ts` (schema, `parseTracker`, `validateDispatchConfig`)
- Test: `ts/packages/config/test/config.test.ts`

- [ ] **Step 1: Schema fields**

In `trackerRawSchema` add `channels: z.unknown().optional(),` and `emojiStates: z.unknown().optional(),`.

> Note: WORKFLOW.md uses snake_case (`emoji_states`); confirm `normalizeWorkflowConfig` deep-camelCases keys so `emoji_states` → `emojiStates`. If it does not handle nested record keys, accept both by reading `trackerRaw.emojiStates ?? (trackerRaw as Record<string, unknown>).emoji_states` in `parseTracker`.

- [ ] **Step 2: `parseTracker` — kind-aware secret env, endpoint default, fields**

Replace the apiKey/endpoint lines and extend the return:

```ts
  const secretEnvVar = kind === "slack" ? "SLACK_BOT_TOKEN" : "LINEAR_API_KEY";
  const apiKey = resolveConfiguredSecret(trackerRaw.apiKey, env, secretEnvVar);
  const endpointDefault = kind === "slack" ? "https://slack.com/api" : defaults.endpoint;
  // ...
  return {
    ...defaults,
    kind,
    endpoint: stringValue(trackerRaw.endpoint, endpointDefault),
    apiKey,
    projectSlug,
    assignee,
    path: stringValue(trackerRaw.path, defaults.path ?? ".symphony/board"),
    channels: stringArray(trackerRaw.channels, []),
    emojiStates: parseEmojiStates(trackerRaw.emojiStates),
    activeStates: stringArray(trackerRaw.activeStates, defaults.activeStates),
    terminalStates: stringArray(trackerRaw.terminalStates, defaults.terminalStates),
    dispatch: parseDispatch(defaults.dispatch, trackerRaw.dispatch ?? {}),
  };
```

Add a helper near the other tracker helpers:

```ts
function parseEmojiStates(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tracker.emoji_states must be a mapping of emoji name to state name");
  }
  const out: Record<string, string> = {};
  for (const [emoji, state] of Object.entries(value as Record<string, unknown>)) {
    if (typeof state !== "string") throw new Error(`tracker.emoji_states.${emoji} must be a string`);
    out[emoji] = state;
  }
  return out;
}
```

- [ ] **Step 3: Validation**

In `validateDispatchConfig` add after the local block:

```ts
  if (settings.tracker.kind === "slack") {
    if (!settings.tracker.apiKey) {
      throw new Error("tracker.api_key (or SLACK_BOT_TOKEN) is required for the slack tracker");
    }
    if (!settings.tracker.channels || settings.tracker.channels.length === 0) {
      throw new Error("tracker.channels is required for the slack tracker");
    }
  }
```

- [ ] **Step 4: Add failing config tests**

```ts
test("parses slack tracker config with channels, emoji overrides, and token env", () => {
  const settings = parseConfig(
    { tracker: { kind: "slack", channels: ["C1", "C2"], emoji_states: { rocket: "Shipped" } } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  assert.equal(settings.tracker.kind, "slack");
  assert.equal(settings.tracker.endpoint, "https://slack.com/api");
  assert.equal(settings.tracker.apiKey, "xoxb-test");
  assert.deepEqual(settings.tracker.channels, ["C1", "C2"]);
  assert.deepEqual(settings.tracker.emojiStates, { rocket: "Shipped" });
});

test("slack tracker requires a token and at least one channel", () => {
  assert.throws(
    () => validateDispatchConfig(parseConfig({ tracker: { kind: "slack", channels: ["C1"] } }, {})),
    /SLACK_BOT_TOKEN/,
  );
  assert.throws(
    () =>
      validateDispatchConfig(
        parseConfig({ tracker: { kind: "slack" } }, { SLACK_BOT_TOKEN: "xoxb-test" }),
      ),
    /channels is required/,
  );
});
```

> Ensure `validateDispatchConfig` is imported in the test file.

- [ ] **Step 5: Run config tests**

Run: `cd ts && pnpm exec vitest run packages/config/test/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ts && mise run tidy
git add packages/config
git commit -m "feat(config): slack tracker fields, token env, validation"
```

### Task 3.6: MCP `slack` tools + `deps` arg + factory wiring + fixture

**Files:**
- Create: `ts/packages/mcp/src/tools/slack.ts`, `ts/test/fixtures/workflow-slack.md`
- Modify: `ts/packages/mcp/src/tools.ts` (add `deps` arg + `slack` case), `ts/packages/mcp/{package.json,tsconfig.json}`, `ts/apps/cli/src/daemon.ts`, `ts/apps/cli/{package.json,tsconfig.json}`
- Test: `ts/packages/mcp/test/slack-tools.test.ts`, extend `tracker-client.test.ts`

- [ ] **Step 1: Deps + tsconfig refs**

- `packages/mcp/package.json`: add `"@symphony/slack-tracker": "workspace:*"`.
- `packages/mcp/tsconfig.json` references: add `{ "path": "../slack-tracker" }`.
- `apps/cli/package.json`: add `"@symphony/slack-tracker": "workspace:*"`.
- `apps/cli/tsconfig.json` references: add `{ "path": "../../packages/slack-tracker" }`.
- Run `cd ts && pnpm install`.

- [ ] **Step 2: Extend `ToolDeps` and `executeTool` to carry the transport**

In `tools.ts`:

```ts
import type { SlackTransport } from "@symphony/slack-tracker";

export interface ToolDeps {
  now?: () => Date;
  slackTransport?: SlackTransport;
}
```

Add the 5th param (already present as `_deps`); rename it to `deps` and pass into the slack case (Step 4).

- [ ] **Step 3: Write the failing slack-tools test**

```ts
import { test } from "vitest";

import { executeTool, toolSpecs } from "@symphony/mcp";
import { InMemorySlackTransport } from "@symphony/slack-tracker";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

function settings() {
  return parseConfig({ tracker: { kind: "slack", channels: ["C1"] } }, { SLACK_BOT_TOKEN: "xoxb" });
}

test("slack toolSpecs lists update_status and comment", () => {
  assert.deepEqual(
    toolSpecs(settings()).map((t) => t.name),
    ["slack_update_status", "slack_comment"],
  );
});

test("slack_update_status swaps the status reaction; slack_comment replies in thread", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const moved = await executeTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    fetch,
    { slackTransport: transport },
  );
  assert.equal(moved.success, true);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);

  const replied = await executeTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "done!" },
    settings(),
    fetch,
    { slackTransport: transport },
  );
  assert.equal(replied.success, true);
  assert.deepEqual(transport.replies, [{ channel: "C1", threadTs: "1.1", body: "done!" }]);
});
```

- [ ] **Step 4: Implement `tools/slack.ts`**

```ts
import {
  emojiForState,
  SlackWebTransport,
  splitIssueId,
  statusEmojiMap,
  type SlackTransport,
} from "@symphony/slack-tracker";
import type { Settings } from "@symphony/domain";

import type { ToolResult, ToolSpec } from "../tools.js";

const TOOL_NAMES = ["slack_update_status", "slack_comment"] as const;

export function slackToolSpecs(): ToolSpec[] {
  return [
    {
      name: "slack_update_status",
      description:
        "Set a Slack issue's status by swapping its status emoji reaction. Args: issueId, status.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, status: { type: "string" } },
        required: ["issueId", "status"],
      },
    },
    {
      name: "slack_comment",
      description: "Reply in the Slack issue's thread. Args: issueId, body.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
      },
    },
  ];
}

export async function executeSlackTool(
  name: string,
  input: unknown,
  settings: Settings,
  transport: SlackTransport,
): Promise<ToolResult> {
  const args = isRecord(input) ? input : {};
  try {
    const parts = splitIssueId(requireStr(args, "issueId"));
    if (!parts) throw new Error("issueId must be in '<channel>:<ts>' form");
    const [channel, ts] = parts;
    switch (name) {
      case "slack_update_status": {
        const status = requireStr(args, "status");
        const map = statusEmojiMap(settings);
        const target = emojiForState(status, map);
        if (!target) {
          return failure(`No emoji configured for status '${status}'.`);
        }
        const message = await transport.getMessage(channel, ts);
        const present = (message?.reactions ?? []).filter((r) => map[r]);
        for (const reaction of present) {
          if (reaction !== target) await transport.removeReaction(channel, ts, reaction);
        }
        if (!present.includes(target)) await transport.addReaction(channel, ts, target);
        return { success: true, result: { ok: true, status } };
      }
      case "slack_comment": {
        await transport.postReply(channel, ts, requireStr(args, "body"));
        return { success: true, result: { ok: true } };
      }
      default:
        return {
          success: false,
          error: "Unsupported tool.",
          result: { error: { message: "Unsupported tool.", supportedTools: [...TOOL_NAMES] } },
        };
    }
  } catch (error) {
    return failure((error as Error).message);
  }
}

export function slackTransportFor(
  settings: Settings,
  fetchImpl: typeof fetch,
  injected?: SlackTransport,
): SlackTransport {
  return injected ?? new SlackWebTransport(settings, fetchImpl);
}

function failure(message: string): ToolResult {
  return { success: false, error: message, result: { error: { message } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}
```

- [ ] **Step 5: Add the `slack` case to the dispatcher**

In `tools.ts` add `import { executeSlackTool, slackToolSpecs, slackTransportFor } from "./tools/slack.js";` then:

```ts
    case "slack":
      return slackToolSpecs();              // in toolSpecs

    case "slack":
      return executeSlackTool(name, input, settings, slackTransportFor(settings, fetchImpl, deps.slackTransport)); // in executeTool
```

(Use `deps` — rename the `_deps` param to `deps`.)

- [ ] **Step 6: Add the `slack` case to the factory**

In `daemon.ts` add `import { SlackTrackerClient, SlackWebTransport } from "@symphony/slack-tracker";` and:

```ts
  if (settings.tracker.kind === "slack")
    return new SlackTrackerClient(settings, new SlackWebTransport(settings));
```

- [ ] **Step 7: Create the slack fixture**

`ts/test/fixtures/workflow-slack.md`:

```markdown
---
tracker:
  kind: slack
  channels:
    - C0123456789
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  emoji_states:
    rocket: Shipped
---

Slack workflow fixture (test only). Requires SLACK_BOT_TOKEN in the environment.
```

- [ ] **Step 8: Extend the factory test for slack + fixture**

```ts
import { SlackTrackerClient } from "@symphony/slack-tracker";

test("tracker factory selects slack adapter from the workflow-slack fixture", async () => {
  const raw = await readFile(
    path.join(import.meta.dirname, "../../../test/fixtures/workflow-slack.md"),
    "utf8",
  );
  const settings = parseConfig(frontmatter(raw), { SLACK_BOT_TOKEN: "xoxb-test" });
  assert.equal(settings.tracker.kind, "slack");
  assert.deepEqual(settings.tracker.channels, ["C0123456789"]);
  assert.ok(createTrackerClient(settings) instanceof SlackTrackerClient);
});
```

- [ ] **Step 9: Run targeted tests + full gate**

Run: `cd ts && pnpm exec vitest run packages/mcp/test/slack-tools.test.ts packages/slack-tracker apps/cli/test/tracker-client.test.ts`
Expected: PASS.

Run: `cd ts && mise run check`
Expected: PASS (all exhaustive switches handle `linear`, `memory`, `local`, `slack`).

- [ ] **Step 10: Commit**

```bash
cd ts && mise run tidy
git add -A
git commit -m "feat(slack-tracker): wire factory, MCP tools, and config fixture"
```

---

## Final verification

- [ ] Run the full gate from a clean state:

Run: `cd ts && mise run check`
Expected: PASS (typecheck, all tests, lint).

- [ ] Confirm the `linear_graphql` contract suite is unchanged:

Run: `cd ts && pnpm exec vitest run packages/mcp/test/tools-contract.test.ts`
Expected: PASS, identical assertions.

---

## Self-Review

**Spec coverage:**
- Registry/decouple via per-kind dispatch in three layers → Tasks 1.1–1.3, 2.6–2.7, 3.5–3.6. ✓
- Read interface unchanged → all clients implement `RuntimeTrackerClient`. ✓
- Per-adapter write tools, `linear_graphql` untouched → Task 1.1 (moved verbatim), 2.7 (`local_*`), 3.6 (`slack_*`). ✓
- MCP server name per kind, `symphony_linear` unchanged → Task 1.3. ✓
- Local file format (status + optional labels; title/description/id/timestamps derived; `## Comments`) → Task 2.4. ✓
- `BoardStore` API (list/getByIds/byStatus/updateStatus/appendComment/create with `BOARD-<n>`) → Task 2.4. ✓
- `defaultStateType` shared in `@symphony/issue` → Task 2.1, used by local (2.4) + slack (3.3). ✓
- Slack transport interface + `SlackWebTransport` + `InMemorySlackTransport` → Tasks 3.2–3.4. ✓
- Slack mapping (mention→issue, reactions→state, defaults + override, thread→comment) → Tasks 3.2–3.3. ✓
- Slack tools (`slack_update_status` swap reaction, `slack_comment` reply) → Task 3.6. ✓
- Config: `path`, `channels`, `emojiStates`, `SLACK_BOT_TOKEN`, per-kind validation → Tasks 2.6, 3.5. ✓
- Fixtures only for WORKFLOW.md → `workflow-local.md` (2.7), `workflow-slack.md` (3.6); main doc untouched. ✓
- Phased, each ends `mise run check` → gate steps in 1.3, 2.7, 3.6, Final. ✓

**Type consistency:** `RuntimeTrackerClient`, `TrackerKind`, `Settings`, `Issue` from `@symphony/domain`; `normalizeIssue`/`defaultStateType` from `@symphony/issue`; `ToolSpec`/`ToolResult`/`ToolDeps` from `@symphony/mcp` (`./tools.js`); `SlackTransport`/`SlackMessage`/`splitIssueId`/`statusEmojiMap`/`emojiForState`/`stateFromReactions` from `@symphony/slack-tracker`; `BoardStore`/`LocalTrackerClient` from `@symphony/local-tracker`. `executeTool(name, input, settings, fetchImpl?, deps?)` consistent across dispatcher and tests.

**Placeholder scan:** No TBD/TODO. Inline notes flag intra-phase ordering (e.g. run Task 2.6 before 2.5 re-run) and environment caveats (`import.meta.dirname`, `assert.rejects`, snake_case normalization) — each with a concrete fallback.

**Known follow-ups (non-goals, documented in spec):** `SlackWebTransport.listMentions` uses a `<@…>` mention heuristic rather than resolving the bot user id; live Slack hardening, adapter prompt guidance, and main-WORKFLOW.md genericization are out of scope.
