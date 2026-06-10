import { createHash, randomBytes } from "node:crypto";

import type { Settings } from "@symphony/domain";

const defaultMcpAuthScope = "mcp:default";
const activeTokens = new Map<string, string>();

export function createMcpAuthScope(): string {
  return `mcp:${randomBytes(16).toString("base64url")}`;
}

export function mcpAuthScopeForSettings(
  settings: Settings,
  host: string,
  port: number | undefined,
): string {
  const identity = stableJson({ host, port: port ?? null, tracker: settings.tracker });
  return `mcp:${createHash("sha256").update(identity).digest("base64url")}`;
}

/**
 * Deterministic JSON for hashing: object keys are sorted recursively and `undefined`
 * values are normalized to `null` so the scope is independent of property insertion order
 * and of which optional tracker fields happen to be set explicitly.
 */
function stableJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function issueMcpToken(scope = defaultMcpAuthScope): string {
  const token = randomBytes(32).toString("base64url");
  activeTokens.set(token, scope);
  return token;
}

export function revokeMcpToken(token: string | null | undefined): void {
  if (token) activeTokens.delete(token);
}

export function validMcpToken(
  token: string | null | undefined,
  scope = defaultMcpAuthScope,
): boolean {
  return typeof token === "string" && activeTokens.get(token) === scope;
}
