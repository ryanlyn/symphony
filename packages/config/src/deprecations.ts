import { isRecord } from "@lorenz/domain";

/**
 * A deprecated workflow-config key, the canonical key/shape that replaces it, and optional
 * guidance. `configPath` is rendered in the snake_case spelling operators write, even when the
 * front matter used the camelCase alias. Detection is a pure scan of the raw front matter so it
 * can run at start, validation, and doctor time without re-parsing.
 */
export interface ConfigDeprecation {
  /** Snake_case config path as it appears in front matter, e.g. `codex.command`. */
  configPath: string;
  /** Recommended replacement key or shape, e.g. `agents.codex.bridge_command`. */
  replacement: string;
  /** Extra guidance appended to the formatted warning. */
  detail?: string | undefined;
}

// The top-level `codex:`/`claude:` sections are legacy sugar folded into `agents.<kind>` at
// parse time. Every key under them is deprecated; these maps name the canonical replacement
// suffix under `agents.<kind>` for the well-known keys (unknown keys map to the same name).
const CODEX_KEY_REPLACEMENTS: Record<string, string> = {
  command: "bridge_command",
  turn_timeout_ms: "turn_timeout_ms",
  stall_timeout_ms: "stall_timeout_ms",
};
const CLAUDE_KEY_REPLACEMENTS: Record<string, string> = {
  command: "bridge_command",
  model: "provider_config.model",
  turn_timeout_ms: "turn_timeout_ms",
  stall_timeout_ms: "stall_timeout_ms",
  strict_mcp_config: "strict_mcp_config",
  provider_config: "provider_config",
};

const LEGACY_AGENT_SECTIONS = {
  codex: CODEX_KEY_REPLACEMENTS,
  claude: CLAUDE_KEY_REPLACEMENTS,
} as const;

// Core selector keys that legitimately live under `tracker`. Any other key there is a
// provider-specific option written in the deprecated flat shape, which the `trackers.<name>`
// bundle replaces.
const TRACKER_CORE_KEYS = new Set([
  "kind",
  "provider",
  "endpoint",
  "api_key",
  "assignee",
  "active_states",
  "terminal_states",
  "dispatch",
]);

/** Scan raw workflow front matter for deprecated keys, in a stable, declaration order. */
export function collectConfigDeprecations(raw: Record<string, unknown>): ConfigDeprecation[] {
  const deprecations: ConfigDeprecation[] = [];
  for (const [kind, replacements] of Object.entries(LEGACY_AGENT_SECTIONS)) {
    collectLegacyAgentSection(raw, kind, replacements, deprecations);
  }
  collectTrackerFlatShape(raw, deprecations);
  return deprecations;
}

/** Render a deprecation as a one-line operator warning with its recommendation. */
export function formatConfigDeprecation(dep: ConfigDeprecation): string {
  const base = `\`${dep.configPath}\` is deprecated; use \`${dep.replacement}\` instead.`;
  return dep.detail ? `${base} ${dep.detail}` : base;
}

/** Collect and emit every deprecation through `warn`, returning the collected list. */
export function warnConfigDeprecations(
  raw: Record<string, unknown>,
  warn: (message: string) => void,
): ConfigDeprecation[] {
  const deprecations = collectConfigDeprecations(raw);
  for (const dep of deprecations) warn(formatConfigDeprecation(dep));
  return deprecations;
}

function collectLegacyAgentSection(
  raw: Record<string, unknown>,
  kind: string,
  replacements: Record<string, string>,
  out: ConfigDeprecation[],
): void {
  const section = raw[kind];
  if (!isRecord(section)) return;
  for (const key of Object.keys(section)) {
    const snake = toSnakeKey(key);
    const suffix = replacements[snake] ?? snake;
    out.push({
      configPath: `${kind}.${snake}`,
      replacement: `agents.${kind}.${suffix}`,
      detail: `The top-level \`${kind}\` section is legacy sugar; configure agent records under \`agents.${kind}\` instead.`,
    });
  }
}

function collectTrackerFlatShape(raw: Record<string, unknown>, out: ConfigDeprecation[]): void {
  const tracker = raw.tracker;
  if (!isRecord(tracker)) return;
  const bundle = suggestedBundleName(tracker.kind);
  for (const key of Object.keys(tracker)) {
    const snake = toSnakeKey(key);
    if (TRACKER_CORE_KEYS.has(snake)) continue;
    // `project_slug` (singular) is doubly deprecated: prefer the plural `project_slugs`.
    const singularSlug = snake === "project_slug";
    out.push({
      configPath: `tracker.${snake}`,
      replacement: `trackers.${bundle}.${singularSlug ? "project_slugs" : snake}`,
      detail: singularSlug
        ? "Provider options under `tracker` (flat shape) are deprecated; move them into a `trackers.<name>` bundle with `provider:` selected by `tracker.kind`. The singular `project_slug` is also deprecated in favor of `project_slugs`."
        : "Provider options under `tracker` (flat shape) are deprecated; move them into a `trackers.<name>` bundle with `provider:` selected by `tracker.kind`.",
    });
  }
}

function suggestedBundleName(kind: unknown): string {
  return typeof kind === "string" && kind.trim() !== "" ? kind.trim() : "<name>";
}

function toSnakeKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}
