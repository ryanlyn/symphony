import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { match } from "ts-pattern";
import { z } from "zod";
import { httpUrlHost, isRecord, normalizeHttpBindHost, type Settings } from "@lorenz/domain";
import { defaultToolRegistry, type ToolRegistry } from "@lorenz/tool-sdk";

import {
  checkRunClaim,
  createMcpAuthScope,
  mcpAuthScopeForSettings,
  resolveRunClaim,
  validMcpToken,
} from "./auth.js";
import { executeTool, toolSpecs } from "./tools.js";

/**
 * Read-only liveness oracle injected from the composition root (daemon.ts in
 * C4). Given a per-run claim's `(runKey, workerHost, generation)`, returns false
 * once the run is settled/recycled/superseded, pairing liveness with the
 * generation fence. Until C4 wires the coordinator-backed oracle, the mount
 * defaults to {@link defaultIsRunLive} so the Token B re-check plumbing is in
 * place without yet enforcing liveness/generation. No Token B is minted before
 * C3, so this default never authorizes a real per-run request.
 */
export type IsRunLive = (runKey: string, workerHost: string, generation: number) => boolean;

const defaultIsRunLive: IsRunLive = () => true;

export interface ObservabilityServerOptions {
  host: string;
  port: number;
  authScope?: string | undefined;
  /** Tool packs available to this endpoint; defaults to the process-wide registry. */
  tools?: ToolRegistry | undefined;
  /**
   * Read-only liveness oracle for per-run (Token B) claims. Injected at the
   * composition root; defaults to a permissive placeholder until C4.
   */
  isRunLive?: IsRunLive | undefined;
}

export interface ObservabilityServerHandle {
  host: string;
  port: number;
  authScope: string;
  url(path?: string): string;
  stop(): Promise<void>;
}

export interface McpMountOptions {
  authScope?: string | undefined;
  /** Tool packs available to this endpoint; defaults to the process-wide registry. */
  tools?: ToolRegistry | undefined;
  /**
   * Read-only liveness oracle for per-run (Token B) claims. Injected at the
   * composition root; defaults to a permissive placeholder until C4.
   */
  isRunLive?: IsRunLive | undefined;
}

const mcpPath = "/mcp";

export async function startMcpServer(
  settings: Settings,
  options: ObservabilityServerOptions,
): Promise<ObservabilityServerHandle> {
  const app = new Hono();
  const bindHost = normalizeHttpBindHost(options.host);
  const authScope =
    options.authScope ??
    (options.port > 0
      ? mcpAuthScopeForSettings(settings, bindHost, options.port)
      : createMcpAuthScope());
  mountMcp(app, settings, { authScope, tools: options.tools, isRunLive: options.isRunLive });
  app.notFound((c) =>
    c.req.method === "GET"
      ? errorResponse(404, "not_found", "Route not found")
      : errorResponse(405, "method_not_allowed", "Method not allowed"),
  );
  return startHonoServer(app, options, authScope);
}

/**
 * Mount the MCP endpoint. `settings` may be a thunk so a long-lived mount (the
 * observability server) serves the runtime's CURRENT workflow settings after a hot reload,
 * instead of the snapshot taken when the server was built.
 */
export function mountMcp(
  app: Hono,
  settings: Settings | (() => Settings),
  options: McpMountOptions = {},
): void {
  const currentSettings = typeof settings === "function" ? settings : () => settings;
  const authScope = options.authScope ?? createMcpAuthScope();
  const isRunLive = options.isRunLive ?? defaultIsRunLive;
  app.use(mcpPath, async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }
    const bearer = bearerToken(c.req.header("authorization"));
    // Token B (per-run scoped claim) is the only source of a request's runKey:
    // resolve it server-side from the opaque token and re-check the owner on
    // EVERY request. A self-reported runKey header is never trusted.
    const claim = resolveRunClaim(bearer);
    if (claim) {
      // Hono caches the parsed body, so reading the text here does not consume
      // it for the downstream `handleMcp` request handler.
      const toolName = requestToolName(await c.req.text());
      const decision = checkRunClaim(claim, { toolName, isRunLive });
      if (!decision.ok) return unauthorizedMcpResponse();
      await next();
      return;
    }
    // Legacy settings-wide token (Token A side). Kept until C6 closes the
    // bypass paths so non-co-resident endpoints keep working unchanged.
    if (!validMcpToken(bearer, authScope)) {
      return unauthorizedMcpResponse();
    }
    await next();
  });
  app.post(mcpPath, async (c) => handleMcp(currentSettings(), c, options.tools));
  app.all(mcpPath, () => errorResponse(405, "method_not_allowed", "Method not allowed"));
}

async function startHonoServer(
  app: Hono,
  options: ObservabilityServerOptions,
  authScope: string,
): Promise<ObservabilityServerHandle> {
  let server!: ServerType;
  const bindHost = normalizeHttpBindHost(options.host);
  await new Promise<void>((resolve, reject) => {
    server = serve({ fetch: app.fetch, hostname: bindHost, port: options.port }, () => {
      server.off("error", reject);
      resolve();
    });
    server.once("error", reject);
  });
  const activeServer = server;
  const address = activeServer.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    host: bindHost,
    port,
    authScope,
    url(path = "/"): string {
      return `http://${httpUrlHost(bindHost)}:${port}${path}`;
    },
    stop: async () => stopServer(activeServer),
  };
}

async function handleMcp(settings: Settings, c: Context, tools?: ToolRegistry): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await requestJson(c);
  } catch {
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      400,
    );
  }

  const response = await mcpResponse(settings, body, tools);
  if (response === null) return new Response("", { status: 204 });
  return jsonResponse(response);
}

async function requestJson(c: Context): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await c.req.text()) as unknown;
  if (!isRecord(parsed)) throw new Error("request body must be an object");
  return parsed;
}

function bearerToken(authorization: string | undefined): string | undefined {
  return /^Bearer\s+(.+)$/.exec(authorization ?? "")?.[1];
}

function unauthorizedMcpResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "unauthorized",
        message: "Missing or invalid MCP bearer token",
      },
    },
    401,
  );
}

/**
 * Best-effort `tools/call` name for the per-run allowlist re-check, parsed from
 * the raw request body. Returns null for non-tool requests or unparseable
 * bodies; the allowlist only narrows tool calls, so a null name simply skips the
 * allowlist (the rest of the claim still gates the request).
 */
function requestToolName(rawBody: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(body) || body.method !== "tools/call") return null;
  const params = body.params;
  if (!isRecord(params)) return null;
  const name = params.name;
  return typeof name === "string" ? name.trim() || null : null;
}

export async function mcpResponse(
  settings: Settings,
  body: Record<string, unknown>,
  tools: ToolRegistry = defaultToolRegistry,
): Promise<Record<string, unknown> | null> {
  const method = typeof body.method === "string" ? body.method : "";
  const id = body.id ?? null;
  return match(method)
    .with("notifications/initialized", () => null)
    .with("initialize", () => {
      const parsed = mcpInitializeParamsSchema.safeParse(body.params);
      if (!parsed.success) return jsonRpcError(id, -32602, "Invalid params");
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: parsed.data.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp", version: "0.1.0" },
        },
      };
    })
    .with("tools/list", () => ({
      jsonrpc: "2.0",
      id,
      result: { tools: toolSpecs(settings, tools) },
    }))
    .with("tools/call", async () => {
      const parsed = mcpToolsCallParamsSchema.safeParse(body.params);
      if (!parsed.success) return jsonRpcError(id, -32602, "Invalid params");
      const result = await executeTool(
        parsed.data.name,
        parsed.data.arguments,
        settings,
        fetch,
        tools,
      );
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
    })
    .otherwise(() => jsonRpcError(id, -32601, `Method not found: ${method}`));
}

const mcpParamsSchema = z.record(z.string(), z.unknown());

const mcpInitializeParamsSchema = z.preprocess(
  (value) => (Array.isArray(value) ? value : isRecord(value) ? value : {}),
  z
    .object({
      protocolVersion: z.string().optional(),
    })
    .passthrough(),
);

const mcpToolsCallParamsSchema = z.preprocess(
  (value) => (isRecord(value) ? value : {}),
  z
    .object({
      name: z.string().trim().min(1),
      arguments: z.preprocess((value) => (isRecord(value) ? value : {}), mcpParamsSchema),
    })
    .passthrough()
    .transform((params) => ({
      ...params,
      name: params.name.trim(),
      arguments: params.arguments ?? {},
    })),
);

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

async function stopServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
