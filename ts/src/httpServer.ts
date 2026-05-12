import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { validMcpToken } from "./mcpAuth.js";
import { issuePayload, runsPayload, statePayload, type PresenterParams } from "./presenter.js";
import { executeTool, toolSpecs } from "./tools.js";
import type { RuntimeSnapshot, SymphonyRuntime } from "./runtime.js";
import type { Settings } from "./types.js";

export interface ObservabilityServerOptions {
  host: string;
  port: number;
}

export interface ObservabilityServerHandle {
  host: string;
  port: number;
  url(path?: string): string;
  stop(): Promise<void>;
}

export async function startObservabilityServer(
  runtime: SymphonyRuntime,
  options: ObservabilityServerOptions,
): Promise<ObservabilityServerHandle> {
  const server = http.createServer((request, response) => {
    handleRequest(runtime, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    host: options.host,
    port,
    url(path = "/"): string {
      return `http://${urlHost(options.host)}:${port}${path}`;
    },
    stop: () => stopServer(server),
  };
}

export async function startClaudeMcpServer(
  settings: Settings,
  options: ObservabilityServerOptions,
): Promise<ObservabilityServerHandle> {
  const server = http.createServer((request, response) => {
    const method = request.method ?? "GET";
    const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (parsedUrl.pathname === "/claude-mcp") {
      void handleClaudeMcp(settings, request, response);
      return;
    }
    respondError(
      response,
      method === "GET" ? 404 : 405,
      method === "GET" ? "not_found" : "method_not_allowed",
      method === "GET" ? "Route not found" : "Method not allowed",
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    host: options.host,
    port,
    url(path = "/"): string {
      return `http://${urlHost(options.host)}:${port}${path}`;
    },
    stop: () => stopServer(server),
  };
}

function handleRequest(
  runtime: SymphonyRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const method = request.method ?? "GET";
  const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = parsedUrl.pathname;

  if (path === "/" && method === "GET") {
    respondHtml(response, dashboardHtml(runtime));
    return;
  }

  if (path === "/" && method !== "GET") {
    respondError(response, 405, "method_not_allowed", "Method not allowed");
    return;
  }

  if (path === "/claude-mcp") {
    void handleClaudeMcp(runtime.workflow.settings, request, response);
    return;
  }

  if (path === "/api/v1/state") {
    if (method !== "GET") {
      respondError(response, 405, "method_not_allowed", "Method not allowed");
      return;
    }
    const snapshot = snapshotResult(runtime);
    if (snapshot.status !== "ok") {
      respondJson(response, 200, {
        generated_at: new Date().toISOString(),
        error: observabilityErrorBody(snapshot.status),
      });
      return;
    }
    respondJson(response, 200, statePayload(snapshot.snapshot));
    return;
  }

  if (path === "/api/v1/events") {
    if (method !== "GET") {
      respondError(response, 405, "method_not_allowed", "Method not allowed");
      return;
    }
    handleStateEvents(runtime, request, response);
    return;
  }

  if (path === "/api/v1/runs") {
    if (method !== "GET") {
      respondError(response, 405, "method_not_allowed", "Method not allowed");
      return;
    }
    const snapshot = snapshotResult(runtime);
    if (snapshot.status !== "ok") {
      respondError(response, 503, snapshot.status, observabilityErrorBody(snapshot.status).message);
      return;
    }
    const result = runsPayload(snapshot.snapshot, paramsFromSearch(parsedUrl.searchParams));
    if (result.status === "run_not_found") {
      respondError(response, 404, "run_not_found", "Run not found");
      return;
    }
    respondJson(response, 200, result.payload);
    return;
  }

  if (path === "/api/v1/refresh") {
    if (method !== "POST") {
      respondError(response, 405, "method_not_allowed", "Method not allowed");
      return;
    }
    try {
      respondJson(response, 202, runtime.requestRefresh());
    } catch {
      respondError(response, 503, "orchestrator_unavailable", "Orchestrator is unavailable");
    }
    return;
  }

  const issueMatch = path.match(/^\/api\/v1\/([^/]+)$/);
  if (issueMatch) {
    if (method !== "GET") {
      respondError(response, 405, "method_not_allowed", "Method not allowed");
      return;
    }
    const issueIdentifier = decodeURIComponent(issueMatch[1] ?? "");
    const snapshot = snapshotResult(runtime);
    if (snapshot.status !== "ok") {
      respondError(response, 404, "issue_not_found", "Issue not found");
      return;
    }
    const result = issuePayload(snapshot.snapshot, issueIdentifier);
    if (result.status === "issue_not_found") {
      respondError(response, 404, "issue_not_found", "Issue not found");
      return;
    }
    respondJson(response, 200, result.payload);
    return;
  }

  respondError(response, 404, "not_found", "Route not found");
}

function dashboardHtml(runtime: SymphonyRuntime): string {
  const snapshot = snapshotResult(runtime);
  if (snapshot.status !== "ok") {
    const error = observabilityErrorBody(snapshot.status);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Symphony Operations Dashboard</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem; background: #0f172a; color: #e2e8f0; }
    h1 { font-size: 1.4rem; }
  </style>
</head>
<body>
  <h1>Operations Dashboard</h1>
  <p>${escapeHtml(error.code)}: ${escapeHtml(error.message)}</p>
</body>
</html>`;
  }
  const state = statePayload(snapshot.snapshot);
  const running = Array.isArray(state.running) ? state.running : [];
  const retrying = Array.isArray(state.retrying) ? state.retrying : [];
  const blocked = Array.isArray(state.blocked) ? state.blocked : [];
  const usage = isRecord(state.usage_totals) ? state.usage_totals : {};
  const counts = isRecord(state.counts) ? state.counts : {};
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Symphony Operations Dashboard</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background: #101418; color: #e8edf2; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    h1 { font-size: 1.3rem; margin: 0 0 4px; }
    .subtle { color: #91a1b2; }
    .badge { color: #0f1720; background: #6ee7b7; padding: 2px 8px; border-radius: 4px; font-weight: 700; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 22px 0; }
    .metric { border: 1px solid #2d3742; padding: 12px; background: #161d24; border-radius: 6px; }
    .metric span { display: block; color: #91a1b2; font-size: .78rem; }
    .metric strong { display: block; font-size: 1.25rem; margin-top: 6px; }
    section { margin-top: 22px; }
    h2 { font-size: .92rem; text-transform: uppercase; letter-spacing: 0; color: #cbd5df; }
    table { width: 100%; border-collapse: collapse; background: #141a21; border: 1px solid #2d3742; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #24303a; text-align: left; vertical-align: top; }
    th { color: #91a1b2; font-size: .78rem; }
    td { font-size: .84rem; }
    .empty { color: #91a1b2; border: 1px dashed #34414f; padding: 12px; background: #141a21; }
    code { color: #bae6fd; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Symphony Operations Dashboard</h1>
        <div class="subtle">workflow=${escapeHtml(snapshot.snapshot.workflowPath)} status=${snapshot.snapshot.appStatus}</div>
      </div>
      <span class="badge" id="connection">live</span>
    </header>

    <div class="metrics">
      ${metricCard("Running", counts.running)}
      ${metricCard("Retrying", counts.retrying)}
      ${metricCard("Blocked", counts.blocked)}
      ${metricCard("Tokens", usage.total_tokens)}
    </div>

    <section>
      <h2>Running Sessions</h2>
      ${running.length === 0 ? emptyState("No running sessions") : runningTable(running)}
    </section>

    <section>
      <h2>Retry Queue</h2>
      ${retrying.length === 0 ? emptyState("No queued retries") : retryTable(retrying)}
    </section>

    <section>
      <h2>Dispatch Blocks</h2>
      ${blocked.length === 0 ? emptyState("No capacity-blocked issues") : blockedTable(blocked)}
    </section>
  </main>
  <script>
    async function refreshState() {
      try {
        const response = await fetch('/api/v1/state', { cache: 'no-store' });
        document.getElementById('connection').textContent = response.ok ? 'live' : 'offline';
      } catch (_error) {
        document.getElementById('connection').textContent = 'offline';
      }
    }
    if ('EventSource' in window) {
      const events = new EventSource('/api/v1/events');
      events.addEventListener('state', () => {
        document.getElementById('connection').textContent = 'live';
      });
      events.onerror = () => {
        document.getElementById('connection').textContent = 'offline';
      };
    } else {
      setInterval(refreshState, ${Math.max(250, snapshot.snapshot.poll.nextPollAt ? 1000 : 1000)});
    }
  </script>
</body>
</html>`;
}

function handleStateEvents(
  runtime: SymphonyRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  response.write(": connected\n\n");

  let unsubscribe: (() => void) | null = null;
  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (!response.writableEnded) response.end();
  };
  try {
    unsubscribe = runtime.subscribe((snapshot) => {
      try {
        response.write(`event: state\ndata: ${JSON.stringify(statePayload(snapshot))}\n\n`);
      } catch {
        cleanup();
      }
    });
  } catch (error) {
    response.write(
      `event: error\ndata: ${JSON.stringify(observabilityErrorBody(observabilityErrorCode(error)))}\n\n`,
    );
  }

  request.on("close", cleanup);
  request.on("error", cleanup);
  response.on("error", cleanup);
}

function metricCard(label: string, value: unknown): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatValue(value))}</strong></div>`;
}

function runningTable(rows: unknown[]): string {
  return table(
    ["Issue", "Agent", "Worker", "Turns", "Tokens", "Session", "Event"],
    rows.map((row) => {
      const item = isRecord(row) ? row : {};
      const tokens = isRecord(item.tokens)
        ? item.tokens.total_tokens
        : isRecord(item.usage_totals)
          ? item.usage_totals.total_tokens
          : "";
      return [
        item.issue_identifier,
        item.agent_kind,
        item.worker_host ?? "local",
        item.turn_count,
        tokens,
        item.session_id ?? "n/a",
        item.last_event ?? "n/a",
      ];
    }),
  );
}

function retryTable(rows: unknown[]): string {
  return table(
    ["Issue", "Attempt", "Due", "Worker", "Workspace", "Error"],
    rows.map((row) => {
      const item = isRecord(row) ? row : {};
      return [
        item.issue_identifier,
        item.attempt,
        item.due_at,
        item.worker_host ?? "local",
        item.workspace_path ?? "n/a",
        item.error ?? "n/a",
      ];
    }),
  );
}

function blockedTable(rows: unknown[]): string {
  return table(
    ["Issue", "Reason", "Worker"],
    rows.map((row) => {
      const item = isRecord(row) ? row : {};
      return [item.issue_identifier, item.reason ?? "unknown", item.worker_host ?? "n/a"];
    }),
  );
}

function table(headers: string[], rows: unknown[][]): string {
  return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((value) => `<td>${escapeHtml(formatValue(value))}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

function emptyState(message: string): string {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "0";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return String(value);
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function respondHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function respondError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  respondJson(response, status, { error: { code, message } });
}

async function handleClaudeMcp(
  settings: Settings,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if ((request.method ?? "GET") !== "POST") {
    respondError(response, 405, "method_not_allowed", "Method not allowed");
    return;
  }
  if (!authorizedMcpRequest(request)) {
    respondJson(response, 401, {
      error: {
        code: "unauthorized",
        message: "Missing or invalid MCP bearer token",
      },
    });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await requestJson(request);
  } catch {
    respondJson(response, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  const mcpResponse = await claudeMcpResponse(settings, body);
  if (mcpResponse === null) {
    response.writeHead(204);
    response.end("");
    return;
  }
  respondJson(response, 200, mcpResponse);
}

async function claudeMcpResponse(
  settings: Settings,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const method = typeof body.method === "string" ? body.method : "";
  const id = body.id ?? null;
  if (method === "notifications/initialized") return null;
  if (method === "initialize") {
    const params = isRecord(body.params) ? body.params : {};
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "symphony-claude-mcp", version: "0.1.0" },
      },
    };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: toolSpecs() } };
  }
  if (method === "tools/call") {
    const params = isRecord(body.params) ? body.params : {};
    const toolName = typeof params.name === "string" ? params.name : "";
    const args = isRecord(params.arguments) ? params.arguments : {};
    const result = await executeTool(toolName, args, settings);
    const payload = result.success
      ? (result.result ?? {})
      : (result.result ?? { error: { message: result.error ?? "dynamic tool failed" } });
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: !result.success,
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

function authorizedMcpRequest(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  if (!authorization || Array.isArray(authorization)) return false;
  const match = /^Bearer\s+(.+)$/.exec(authorization);
  return validMcpToken(match?.[1]);
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("request body must be an object");
  return parsed;
}

function snapshotResult(
  runtime: SymphonyRuntime,
):
  | { status: "ok"; snapshot: RuntimeSnapshot }
  | { status: "snapshot_timeout" | "snapshot_unavailable" } {
  try {
    return { status: "ok", snapshot: runtime.snapshot() };
  } catch (error) {
    return { status: observabilityErrorCode(error) };
  }
}

function observabilityErrorCode(error: unknown): "snapshot_timeout" | "snapshot_unavailable" {
  if (isRecord(error)) {
    const code = error.code;
    if (code === "snapshot_timeout" || code === "timeout") return "snapshot_timeout";
    if (code === "snapshot_unavailable" || code === "unavailable") return "snapshot_unavailable";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === "snapshot_timeout" || message === "timeout") return "snapshot_timeout";
  return "snapshot_unavailable";
}

function observabilityErrorBody(code: "snapshot_timeout" | "snapshot_unavailable"): {
  code: string;
  message: string;
} {
  return {
    code,
    message: code === "snapshot_timeout" ? "Snapshot timed out" : "Snapshot unavailable",
  };
}

function paramsFromSearch(searchParams: URLSearchParams): PresenterParams {
  const params: PresenterParams = {};
  for (const [key, value] of searchParams.entries()) params[key] = value;
  return params;
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
