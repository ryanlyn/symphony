import {
  appendBoardComment,
  moveBoardIssue,
  readBoardIssue,
  updateBoardIssue,
} from "@symphony/fs-tracker";
import type { Settings } from "@symphony/domain";

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

/**
 * Returns the tools agents are allowed to call, scoped by the active tracker backend. Linear gets
 * `linear_graphql`; the filesystem board gets `board_get`/`board_move`/`board_comment`/
 * `board_update`. Memory and unconfigured trackers expose no tools.
 */
export function toolSpecs(settings?: Settings): ToolSpec[] {
  const kind = settings?.tracker.kind;
  if (kind === "fs") return FS_TOOL_SPECS;
  if (kind === undefined || kind === "linear") return LINEAR_TOOL_SPECS;
  return [];
}

export async function executeTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  const kind = settings.tracker.kind;
  if (kind === "fs") return executeFsTool(name, input, settings);
  if (kind === "linear" || kind === undefined) return executeLinearTool(name, input, settings, fetchImpl);
  return toolFailure("Unsupported tool.", { supportedTools: [] });
}

// ---------------------------------------------------------------------------
// Linear backend (unchanged behavior)
// ---------------------------------------------------------------------------

const LINEAR_TOOL_SPECS: ToolSpec[] = [
  {
    name: "linear_graphql",
    description: "Run a Linear GraphQL operation using Symphony tracker credentials.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        variables: { type: "object" },
      },
      required: ["query"],
    },
  },
];

async function executeLinearTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch,
): Promise<ToolResult> {
  if (name !== "linear_graphql") {
    return toolFailure("Unsupported tool.", { supportedTools: ["linear_graphql"] });
  }
  const normalizedInput = normalizeLinearGraphqlInput(input);
  if (!normalizedInput.ok) {
    return toolFailure(normalizedInput.error);
  }
  if (!settings.tracker.apiKey)
    return toolFailure(
      "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
    );
  if (
    normalizedInput.variables !== undefined &&
    normalizedInput.variables !== null &&
    !isRecord(normalizedInput.variables)
  ) {
    return toolFailure("`linear_graphql.variables` must be a JSON object when provided.");
  }

  try {
    const response = await fetchWithRateLimitRetry(
      fetchImpl,
      settings,
      normalizedInput.query,
      normalizedInput.variables ?? {},
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (!response.ok)
        return toolFailure(`Linear GraphQL request failed with HTTP ${response.status}.`, {
          status: response.status,
        });
      return toolFailure(`linear_invalid_json: ${(error as Error).message}`);
    }
    if (isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0) {
      return { success: false, result: body };
    }
    if (!response.ok)
      return toolFailure(`Linear GraphQL request failed with HTTP ${response.status}.`, {
        status: response.status,
      });
    return { success: true, result: body };
  } catch (error) {
    return toolFailure("Linear GraphQL request failed before receiving a successful response.", {
      reason: (error as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// Filesystem-board backend
// ---------------------------------------------------------------------------

const FS_TOOL_SPECS: ToolSpec[] = [
  {
    name: "board_get",
    description: "Read a board issue by identifier and return its normalized fields.",
    inputSchema: {
      type: "object",
      properties: { identifier: { type: "string" } },
      required: ["identifier"],
    },
  },
  {
    name: "board_move",
    description: "Move a board issue to a different state directory (e.g. Todo, In Progress, Done).",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string" },
        state: { type: "string" },
      },
      required: ["identifier", "state"],
    },
  },
  {
    name: "board_comment",
    description: "Append a progress comment to a board issue's body.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string" },
        comment: { type: "string" },
        author: { type: "string" },
      },
      required: ["identifier", "comment"],
    },
  },
  {
    name: "board_update",
    description: "Patch a board issue's title, labels, priority, or description.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string" },
        title: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        priority: { type: ["number", "null"] },
        description: { type: "string" },
      },
      required: ["identifier"],
    },
  },
];

async function executeFsTool(
  name: string,
  input: unknown,
  settings: Settings,
): Promise<ToolResult> {
  const boardDir = settings.tracker.boardDir;
  if (!boardDir) {
    return toolFailure(
      "Symphony is missing fs board_dir. Set `tracker.board_dir` in `WORKFLOW.md` or export `SYMPHONY_BOARD_DIR`.",
    );
  }
  if (!isRecord(input)) return toolFailure(`\`${name}\` requires a JSON object input.`);

  try {
    if (name === "board_get") {
      const identifier = requireString(input, "identifier");
      const issue = await readBoardIssue(boardDir, identifier, settings.tracker.assignee);
      if (!issue) return toolFailure(`board issue not found: ${identifier}`);
      return { success: true, result: { issue } };
    }
    if (name === "board_move") {
      const identifier = requireString(input, "identifier");
      const state = requireString(input, "state");
      const moved = await moveBoardIssue(boardDir, identifier, state);
      return { success: true, result: moved };
    }
    if (name === "board_comment") {
      const identifier = requireString(input, "identifier");
      const comment = requireString(input, "comment");
      const author = optionalString(input.author);
      const opts = author === undefined ? {} : { author };
      const result = await appendBoardComment(boardDir, identifier, comment, opts);
      return { success: true, result: { identifier, ...result } };
    }
    if (name === "board_update") {
      const identifier = requireString(input, "identifier");
      const patch = normalizeBoardUpdatePatch(input);
      const result = await updateBoardIssue(boardDir, identifier, patch);
      return { success: true, result: { identifier, ...result } };
    }
    return toolFailure("Unsupported tool.", {
      supportedTools: FS_TOOL_SPECS.map((spec) => spec.name),
    });
  } catch (error) {
    return toolFailure((error as Error).message);
  }
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`\`${key}\` is required and must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function normalizeBoardUpdatePatch(input: Record<string, unknown>): {
  title?: string;
  labels?: string[];
  priority?: number | null;
  description?: string;
} {
  const patch: {
    title?: string;
    labels?: string[];
    priority?: number | null;
    description?: string;
  } = {};
  if (typeof input.title === "string") patch.title = input.title;
  if (Array.isArray(input.labels)) {
    patch.labels = input.labels.filter((label): label is string => typeof label === "string");
  }
  if (input.priority === null) patch.priority = null;
  else if (typeof input.priority === "number" && Number.isInteger(input.priority)) {
    patch.priority = input.priority;
  }
  if (typeof input.description === "string") patch.description = input.description;
  return patch;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toolFailure(message: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    success: false,
    error: message,
    result: { error: { message, ...details } },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLinearGraphqlInput(
  input: unknown,
):
  | { ok: true; query: string; variables?: Record<string, unknown> | null | undefined }
  | { ok: false; error: string } {
  if (typeof input === "string") {
    if (input.trim() === "")
      return { ok: false, error: "`linear_graphql` requires a non-empty `query` string." };
    return { ok: true, query: input };
  }
  if (!isRecord(input) || typeof input.query !== "string") {
    return { ok: false, error: "`linear_graphql` requires a non-empty `query` string." };
  }
  if (input.query.trim() === "")
    return { ok: false, error: "`linear_graphql` requires a non-empty `query` string." };
  if (input.variables !== undefined && input.variables !== null && !isRecord(input.variables)) {
    return { ok: false, error: "`linear_graphql.variables` must be a JSON object when provided." };
  }
  return {
    ok: true,
    query: input.query,
    variables: input.variables as Record<string, unknown> | null,
  };
}

async function fetchWithRateLimitRetry(
  fetchImpl: typeof fetch,
  settings: Settings,
  query: string,
  variables: Record<string, unknown>,
): Promise<Response> {
  for (let retryCount = 0; ; retryCount += 1) {
    const response = await fetchImpl(settings.tracker.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        authorization: settings.tracker.apiKey ?? "",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status !== 429 || retryCount >= 4) return response;
    await sleep(retryDelayMs(response.headers, retryCount));
  }
}

function retryDelayMs(headers: Headers, retryCount: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter.trim());
    if (Number.isInteger(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(retryAfter.trim());
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return Math.min(1_000 * 2 ** retryCount, 30_000);
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
