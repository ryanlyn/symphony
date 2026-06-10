import type { RuntimeTrackerClient, Settings } from "@symphony/domain";

/**
 * JSON-Schema-shaped declaration of one agent-facing tracker tool, served to agent
 * sessions over the Symphony MCP endpoint.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Outcome of one tracker tool invocation. `result` is returned to the agent verbatim;
 * `error` is a human-readable summary set when `success` is false.
 */
export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Ambient dependencies handed to provider hooks that must not touch process globals directly. */
export interface TrackerContext {
  env: NodeJS.ProcessEnv;
}

/** Dependencies for executing one agent-facing tracker tool. */
export interface TrackerToolContext {
  settings: Settings;
  fetchImpl: typeof fetch;
}

/**
 * Everything Symphony needs to know about one issue-tracker backend, bundled as a single
 * extension point. A provider owns its slice of the `tracker:` config section, the runtime
 * client that feeds issues into dispatch, and the agent-facing tools exposed over MCP.
 *
 * The core (config parsing, runtime, MCP server, CLI) is provider-agnostic and talks to
 * providers exclusively through this contract via a {@link TrackerRegistry}. Adding a new
 * tracker backend means implementing this interface in a new package and registering it at
 * the composition root - no core package changes.
 */
export interface TrackerProvider {
  /** Config selector matched against `tracker.kind` (e.g. `"linear"`, `"jira"`). */
  readonly kind: string;
  /**
   * snake_case → camelCase alias map for this provider's keys in the `tracker:` config
   * section (e.g. `{ project_slug: "projectSlug" }`). Applied before {@link parseOptions}.
   */
  readonly configAliases?: Readonly<Record<string, string>> | undefined;
  /**
   * Environment variables consulted as fallbacks for the shared credential fields when the
   * workflow config leaves them unset (e.g. `{ apiKey: "LINEAR_API_KEY" }`).
   */
  readonly envFallbacks?: { apiKey?: string | undefined; assignee?: string | undefined };
  /** Endpoint used when `tracker.endpoint` is not configured. */
  readonly defaultEndpoint?: string | undefined;
  /**
   * Validate and normalize the provider-specific keys of the `tracker:` section (aliases
   * already applied). Called at config-parse time; throw with a `tracker.<key> ...` message
   * on invalid input. The returned record becomes {@link Settings.tracker.options}.
   */
  parseOptions?(options: Record<string, unknown>, context: TrackerContext): Record<string, unknown>;
  /**
   * Throw when the parsed settings cannot drive dispatch (missing credentials or required
   * options). Called once at startup by `validateDispatchConfig`.
   */
  validateDispatch?(settings: Settings): void;
  /** Build the runtime client that feeds candidate issues into the dispatch loop. */
  createClient(settings: Settings, context: TrackerContext): RuntimeTrackerClient;
  /** Agent-facing tools advertised over the Symphony MCP endpoint. */
  toolSpecs?(settings: Settings): ToolSpec[];
  /** Execute one of the tools declared by {@link toolSpecs}. */
  executeTool?(name: string, input: unknown, context: TrackerToolContext): Promise<ToolResult>;
  /** Operator-facing URL of the tracked project, shown in dashboards. */
  projectUrl?(settings: Settings): string | undefined;
}
