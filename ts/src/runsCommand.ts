import { loadWorkflow } from "./workflow.js";

export const runsUsageText = `Usage: symphony-ts runs [--issue ID] [--failed] [--cost] [--retries] [--id RUN_ID] [--limit N] [--url URL | --port PORT] [--json]`;

export interface RunsCommandOptions {
  issue: string | null;
  failed: boolean;
  cost: boolean;
  retries: boolean;
  id: string | null;
  limit: number | null;
  url: string | null;
  port: number | null;
  json: boolean;
}

export type RunsParseResult =
  | { status: "ok"; options: RunsCommandOptions }
  | { status: "help"; message: string }
  | { status: "error"; message: string };

export function parseRunsArgs(args: string[]): RunsParseResult {
  const options: RunsCommandOptions = {
    issue: null,
    failed: false,
    cost: false,
    retries: false,
    id: null,
    limit: null,
    url: null,
    port: null,
    json: false,
  };

  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--help" || arg === "-h") return { status: "help", message: runsUsageText };
      if (arg === "--failed") {
        options.failed = true;
        continue;
      }
      if (arg === "--cost") {
        options.cost = true;
        continue;
      }
      if (arg === "--retries") {
        options.retries = true;
        continue;
      }
      if (arg === "--json") {
        options.json = true;
        continue;
      }
      if (arg === "--issue") {
        options.issue = requiredValue(args, index, "--issue");
        index += 1;
        continue;
      }
      if (arg === "--id") {
        options.id = requiredValue(args, index, "--id");
        index += 1;
        continue;
      }
      if (arg === "--url") {
        options.url = trimTrailingSlash(requiredValue(args, index, "--url"));
        index += 1;
        continue;
      }
      if (arg === "--limit") {
        const value = Number(requiredValue(args, index, "--limit"));
        if (!Number.isInteger(value) || value <= 0)
          return { status: "error", message: "--limit must be a positive integer" };
        options.limit = value;
        index += 1;
        continue;
      }
      if (arg === "--port") {
        const value = Number(requiredValue(args, index, "--port"));
        if (!Number.isInteger(value) || value < 0)
          return { status: "error", message: "--port must be a non-negative integer" };
        options.port = value;
        index += 1;
        continue;
      }
      if (arg?.startsWith("--")) return { status: "error", message: `Unknown option: ${arg}` };
      return { status: "error", message: runsUsageText };
    }
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }

  return { status: "ok", options };
}

export async function runRunsCommand(args: string[]): Promise<string> {
  const parsed = parseRunsArgs(args);
  if (parsed.status === "help") return `${parsed.message}\n`;
  if (parsed.status === "error") throw new Error(parsed.message);

  const url = await runsUrl(parsed.options);
  const response = await fetch(url);
  const body = (await response.json()) as Record<string, unknown>;

  if (response.status === 200) return renderOutput(body, parsed.options.json);
  if (response.status === 404) throw new Error(errorMessage(body, "Run not found"));
  if (response.status === 503) throw new Error(errorMessage(body, "Observability API unavailable"));
  throw new Error(`Unexpected response status ${response.status}`);
}

async function runsUrl(options: RunsCommandOptions): Promise<string> {
  const resolvedBaseUrl = await resolveBaseUrl(options);
  const params = new URLSearchParams();
  if (options.issue) params.set("issue", options.issue);
  if (options.failed) params.set("failed", "true");
  if (options.cost) params.set("cost", "true");
  if (options.retries) params.set("retries", "true");
  if (options.id) params.set("id", options.id);
  if (options.limit !== null) params.set("limit", String(options.limit));
  const query = params.toString();
  return `${resolvedBaseUrl}/api/v1/runs${query ? `?${query}` : ""}`;
}

async function resolveBaseUrl(options: RunsCommandOptions): Promise<string> {
  if (options.url) return trimTrailingSlash(options.url);
  if (options.port !== null) return `http://127.0.0.1:${options.port}`;
  const workflow = await loadWorkflow();
  const port = workflow.settings.server.port;
  if (typeof port === "number" && port > 0)
    return `http://${workflow.settings.server.host}:${port}`;
  throw new Error(
    "No observability server port configured. Pass --port/--url or set server.port in WORKFLOW.md.",
  );
}

function renderOutput(body: Record<string, unknown>, json: boolean): string {
  if (json) return `${JSON.stringify(body, null, 2)}\n`;
  const view = stringField(body, "view");
  if (view === "run") return renderRun(body);
  if (view === "cost") return renderCost(body);
  if (view === "retries") return renderRetries(body);
  if (view === "runs") return renderRuns(body);
  return `${JSON.stringify(body, null, 2)}\n`;
}

function renderRun(body: Record<string, unknown>): string {
  const run = recordField(body, "run");
  const lines = [
    `Run ${stringField(run, "id")}`,
    "",
    `issue=${stringField(run, "issue_identifier")} agent=${stringField(run, "agent_kind")} outcome=${stringField(run, "outcome")} attempt=${numberField(run, "retry_attempt")}`,
    `duration=${formatDuration(numberOrNull(run, "duration_ms"))} tokens=${formatInteger(tokenTotal(run))} turns=${numberField(run, "turn_count")}`,
    `session=${stringField(run, "session_id") || "n/a"} resume=${stringField(run, "resume_id") || "n/a"} worker=${stringField(run, "worker_host") || "local"}`,
    `workspace=${stringField(run, "workspace_path") || "n/a"}`,
    `last_event=${stringField(run, "last_event") || "n/a"} at=${stringField(run, "last_event_at") || "n/a"}`,
    `failure_reason=${stringField(run, "failure_reason") || "n/a"}`,
    `log_file=${stringField(recordField(run, "log_hints"), "symphony_log_file") || "n/a"}`,
  ];
  const related = arrayField(body, "related_runs");
  if (related.length === 0) return `${lines.join("\n")}\n`;
  return `${[
    ...lines,
    "",
    "Related runs",
    renderTable(
      ["ID", "OUTCOME", "TOKENS", "STARTED"],
      related.map((item) => {
        const relatedRun = asRecord(item);
        return [
          stringField(relatedRun, "id"),
          stringField(relatedRun, "outcome"),
          formatInteger(tokenTotal(relatedRun)),
          stringField(relatedRun, "started_at") || "n/a",
        ];
      }),
    ),
  ].join("\n")}\n`;
}

function renderCost(body: Record<string, unknown>): string {
  const summary = recordField(body, "summary");
  const byAgent = arrayField(summary, "by_agent");
  const topRuns = arrayField(summary, "top_runs");
  return `${[
    "Cost Summary",
    "",
    renderTable(
      ["AGENT", "RUNS", "DONE", "INPUT", "OUTPUT", "TOTAL", "AVG/RUN", "USD"],
      byAgent.map((item) => {
        const row = asRecord(item);
        return [
          stringField(row, "agent_kind"),
          formatInteger(numberField(row, "run_count")),
          formatInteger(numberField(row, "completed_count")),
          formatInteger(numberField(row, "input_tokens")),
          formatInteger(numberField(row, "output_tokens")),
          formatInteger(numberField(row, "total_tokens")),
          formatFloat(numberField(row, "average_total_tokens_per_run")),
          formatCost(numberOrNull(row, "estimated_cost_usd")),
        ];
      }),
    ),
    "",
    "Top Runs",
    renderTable(
      ["ID", "ISSUE", "AGENT", "OUTCOME", "TOKENS"],
      topRuns.map((item) => {
        const run = asRecord(item);
        return [
          stringField(run, "id"),
          stringField(run, "issue_identifier"),
          stringField(run, "agent_kind"),
          stringField(run, "outcome"),
          formatInteger(tokenTotal(run)),
        ];
      }),
    ),
  ].join("\n")}\n`;
}

function renderRetries(body: Record<string, unknown>): string {
  const issues = arrayField(body, "issues");
  return `${[
    "Retry Summary",
    "",
    renderTable(
      ["ISSUE", "ATTEMPTS", "LATEST", "TOKENS", "RUN ID", "FAILURE"],
      issues.map((item) => {
        const issue = asRecord(item);
        return [
          stringField(issue, "issue_identifier"),
          formatInteger(numberField(issue, "attempts")),
          stringField(issue, "latest_outcome"),
          formatInteger(numberField(issue, "total_tokens")),
          stringField(issue, "latest_run_id"),
          stringField(issue, "latest_failure_reason") || "n/a",
        ];
      }),
    ),
  ].join("\n")}\n`;
}

function renderRuns(body: Record<string, unknown>): string {
  const summary = recordField(body, "summary");
  const runs = arrayField(body, "runs");
  return `${[
    "Run History",
    "",
    `total=${numberField(summary, "total")} running=${numberField(summary, "running")} success=${numberField(summary, "success")} failed=${numberField(summary, "failed")} stalled=${numberField(summary, "stalled")} canceled=${numberField(summary, "canceled")}`,
    "",
    renderTable(
      ["ID", "ISSUE", "AGENT", "OUTCOME", "ATTEMPT", "TURNS", "TOKENS", "DURATION", "SESSION"],
      runs.map((item) => {
        const run = asRecord(item);
        return [
          stringField(run, "id"),
          stringField(run, "issue_identifier"),
          stringField(run, "agent_kind"),
          stringField(run, "outcome"),
          formatInteger(numberField(run, "retry_attempt")),
          formatInteger(numberField(run, "turn_count")),
          formatInteger(tokenTotal(run)),
          formatDuration(numberOrNull(run, "duration_ms")),
          compact(stringField(run, "session_id")),
        ];
      }),
    ),
  ].join("\n")}\n`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [
    formatRow(headers, widths),
    formatRow(
      widths.map((width) => "-".repeat(width)),
      widths,
    ),
    ...rows.map((row) => formatRow(row, widths)),
  ].join("\n");
}

function formatRow(columns: string[], widths: number[]): string {
  return columns.map((column, index) => column.padEnd(widths[index] ?? 0)).join("  ");
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function errorMessage(body: Record<string, unknown>, fallback: string): string {
  return stringField(recordField(body, "error"), "message") || fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(record[key]);
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(record[key]) ? record[key] : [];
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrNull(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenTotal(run: Record<string, unknown>): number {
  return numberField(recordField(run, "tokens"), "total_tokens");
}

function formatInteger(value: number): string {
  return String(Math.round(value));
}

function formatFloat(value: number): string {
  return value.toFixed(1);
}

function formatCost(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(4)}`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "n/a";
  if (durationMs >= 1000) return `${Math.floor(durationMs / 1000)}s`;
  return `${durationMs}ms`;
}

function compact(value: string): string {
  if (!value) return "n/a";
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-5)}` : value;
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
