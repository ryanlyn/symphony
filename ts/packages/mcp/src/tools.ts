import type { Settings, TrackerKind } from "@symphony/domain";

import { executeLinearTool, linearToolSpecs } from "./tools/linear.js";
import { executeLocalTool, localToolSpecs } from "./tools/local.js";
import { unsupportedToolFailure } from "./tools/result.js";
import { executeTrackerTool, trackerToolSpecs } from "./tools/tracker.js";

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

function trackerKind(settings: Settings): TrackerKind {
  return settings.tracker.kind ?? "linear";
}

function assertNever(value: never): never {
  throw new Error(`unhandled tracker kind: ${String(value)}`);
}

export function toolSpecs(settings: Settings): ToolSpec[] {
  const kind = trackerKind(settings);
  const trackerSpecs = trackerToolSpecs(kind);
  switch (kind) {
    case "linear":
      return [...trackerSpecs, ...linearToolSpecs()];
    case "local":
      return [...trackerSpecs, ...localToolSpecs()];
    case "memory":
      return [];
    case "jira":
    case "jira-mcp":
      return trackerSpecs;
    default:
      return assertNever(kind);
  }
}

export async function executeTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  const kind = trackerKind(settings);
  const supportedTools = toolSpecs(settings).map((tool) => tool.name);
  if (!supportedTools.includes(name)) return unsupportedToolFailure(name, supportedTools);
  if (name.startsWith("tracker_")) return executeTrackerTool(name, input, settings, fetchImpl);
  switch (kind) {
    case "linear":
      return executeLinearTool(name, input, settings, fetchImpl);
    case "local":
      return executeLocalTool(name, input, settings);
    case "memory":
    case "jira":
    case "jira-mcp":
      return unsupportedToolFailure(name, supportedTools);
    default:
      return assertNever(kind);
  }
}
