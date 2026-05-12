import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  AgentKind,
  AgentConfig,
  AgentSettings,
  AcpAgentConfig,
  AppServerAgentConfig,
  ClaudeSettings,
  CodexSettings,
  HooksSettings,
  PartialRuntimeSettings,
  Settings,
  TrackerSettings,
} from "./types.js";

const appServerAgentRecordSchema = z.object({ executor: z.literal("appserver") }).passthrough();
const acpAgentRecordSchema = z.object({ executor: z.literal("acp") }).passthrough();
const agentRecordSchema = z.discriminatedUnion("executor", [
  appServerAgentRecordSchema,
  acpAgentRecordSchema,
]);

export const defaultSettings = (): Settings => {
  const codex: CodexSettings = {
    command: "codex app-server",
    approvalPolicy: {
      reject: {
        sandbox_approval: true,
        rules: true,
        mcp_elicitations: true,
      },
    },
    threadSandbox: "workspace-write",
    turnSandboxPolicy: null,
    turnTimeoutMs: 3_600_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000,
  };
  const claude: ClaudeSettings = {
    command: "claude-agent-acp",
    model: "claude-opus-4-6[1m]",
    permissionMode: "dontAsk",
    turnTimeoutMs: 3_600_000,
    stallTimeoutMs: 300_000,
    strictMcpConfig: true,
  };
  return {
    tracker: {
      kind: undefined,
      endpoint: "https://api.linear.app/graphql",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
      dispatch: {
        acceptUnrouted: true,
        onlyRoutes: null,
        routeLabelPrefix: "Symphony:",
      },
    },
    polling: { intervalMs: 30_000 },
    workspace: {
      root: path.join(os.tmpdir(), "symphony_workspaces"),
      rootExpression: path.join(os.tmpdir(), "symphony_workspaces"),
    },
    worker: { sshHosts: [], sshTimeoutMs: 60_000 },
    hooks: { timeoutMs: 60_000 },
    agent: {
      kind: "codex",
      maxConcurrentAgents: 10,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      ensembleSize: 1,
    },
    agents: defaultAgentRecords(codex, claude),
    codex,
    claude,
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    server: { host: "127.0.0.1" },
    logging: { logFile: path.join(process.cwd(), "log", "symphony.log") },
    statusOverrides: new Map(),
  };
};

export function parseConfig(
  raw: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): Settings {
  const settings = defaultSettings();

  const trackerRaw = getRecord(raw, "tracker");
  settings.tracker = parseTracker(settings.tracker, trackerRaw, raw, env);

  const pollingRaw = getRecord(raw, "polling");
  settings.polling.intervalMs = positiveInt(
    getAny(pollingRaw, "interval_ms", "intervalMs"),
    settings.polling.intervalMs,
    "polling.interval_ms",
  );

  const workspaceRaw = getRecord(raw, "workspace");
  const workspaceRootFallback = settings.workspace.rootExpression ?? settings.workspace.root;
  const workspaceRootExpression = resolveWorkspaceRootExpression(
    nonEmptyString(env.SYMPHONY_WORKSPACE_ROOT) ?? getAny(workspaceRaw, "root"),
    workspaceRootFallback,
    env,
  );
  settings.workspace.rootExpression = workspaceRootExpression;
  settings.workspace.root = expandLocalPath(workspaceRootExpression, env);

  const workerRaw = getRecord(raw, "worker");
  settings.worker.sshHosts = stringArray(
    getAny(workerRaw, "ssh_hosts", "sshHosts"),
    settings.worker.sshHosts,
  );
  settings.worker.sshTimeoutMs = positiveInt(
    getAny(workerRaw, "ssh_timeout_ms", "sshTimeoutMs"),
    settings.worker.sshTimeoutMs,
    "worker.ssh_timeout_ms",
  );
  const hostCap = getAny(workerRaw, "max_concurrent_agents_per_host", "maxConcurrentAgentsPerHost");
  if (hostCap !== undefined) {
    settings.worker.maxConcurrentAgentsPerHost = positiveInt(
      hostCap,
      1,
      "worker.max_concurrent_agents_per_host",
    );
  }

  settings.hooks = parseHooks(settings.hooks, getRecord(raw, "hooks"));
  settings.agent = parseAgent(settings.agent, getRecord(raw, "agent"));
  settings.codex = parseCodex(settings.codex, getRecord(raw, "codex"));
  settings.claude = parseClaude(settings.claude, getRecord(raw, "claude"));
  settings.agents = parseAgents(getRecord(raw, "agents"), settings.codex, settings.claude);
  applyKnownAgentRecords(settings);

  const observabilityRaw = getRecord(raw, "observability");
  settings.observability.dashboardEnabled = booleanValue(
    getAny(observabilityRaw, "dashboard_enabled", "dashboardEnabled"),
    settings.observability.dashboardEnabled,
  );
  settings.observability.refreshMs = positiveInt(
    getAny(observabilityRaw, "refresh_ms", "refreshMs"),
    settings.observability.refreshMs,
    "observability.refresh_ms",
  );
  settings.observability.renderIntervalMs = positiveInt(
    getAny(observabilityRaw, "render_interval_ms", "renderIntervalMs"),
    settings.observability.renderIntervalMs,
    "observability.render_interval_ms",
  );

  const serverRaw = getRecord(raw, "server");
  settings.server.host = stringValue(getAny(serverRaw, "host"), settings.server.host);
  const port = getAny(serverRaw, "port");
  if (port !== undefined) settings.server.port = nonNegativeInt(port, "server.port");

  settings.statusOverrides = parseStatusOverrides(
    getRecord(raw, "status_overrides", "statusOverrides"),
  );
  return settings;
}

export function settingsForIssueState(settings: Settings, state: string): Settings {
  const override = settings.statusOverrides.get(normalizeStateName(state));
  if (!override) return cloneSettings(settings);

  const merged = cloneSettings(settings);
  if (override.agent) merged.agent = { ...merged.agent, ...override.agent };
  if (override.codex) merged.codex = mergeCodex(merged.codex, override.codex);
  if (override.claude) merged.claude = { ...merged.claude, ...override.claude };
  return merged;
}

export function validateDispatchConfig(settings: Settings): void {
  if (!settings.tracker.kind) throw new Error("tracker.kind is required");
  if (settings.tracker.kind === "linear") {
    if (!settings.tracker.apiKey) throw new Error("tracker.api_key is required");
    if (!settings.tracker.projectSlug) throw new Error("tracker.project_slug is required");
  }

  const requiredBackends = new Set<AgentKind>([settings.agent.kind]);
  for (const override of settings.statusOverrides.values()) {
    if (override.agent?.kind) requiredBackends.add(override.agent.kind);
  }
  for (const kind of requiredBackends) {
    const agent = settings.agents[kind];
    if (!agent) throw new Error(`agents.${kind} is required`);
    if (agent.executor === "appserver" && !agent.command.trim()) {
      throw new Error(`${kind}.command is required`);
    }
    if (agent.executor === "acp" && !agent.bridgeCommand.trim()) {
      throw new Error(
        kind === "claude"
          ? "claude.command is required"
          : `agents.${kind}.bridgeCommand is required`,
      );
    }
  }
}

export function normalizeStateName(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeRouteName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function parseTracker(
  defaults: TrackerSettings,
  trackerRaw: Record<string, unknown>,
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): TrackerSettings {
  const kindRaw = getAny(trackerRaw, "kind");
  const kind = kindRaw === undefined || kindRaw === null ? defaults.kind : stringValue(kindRaw, "");
  if (kind !== undefined && kind !== "linear" && kind !== "memory")
    throw new Error(`unsupported tracker.kind: ${kind}`);

  const apiKey = resolveConfiguredSecret(
    getAny(trackerRaw, "api_key", "apiKey"),
    env,
    "LINEAR_API_KEY",
  );
  const projectSlug =
    resolveEnv(stringValue(getAny(trackerRaw, "project_slug", "projectSlug"), ""), env) ||
    undefined;
  const assignee = resolveConfiguredSecret(getAny(trackerRaw, "assignee"), env, "LINEAR_ASSIGNEE");

  return {
    ...defaults,
    kind,
    endpoint: stringValue(getAny(trackerRaw, "endpoint"), defaults.endpoint),
    apiKey,
    projectSlug,
    assignee,
    activeStates: stringArray(
      getAny(trackerRaw, "active_states", "activeStates"),
      defaults.activeStates,
    ),
    terminalStates: stringArray(
      getAny(trackerRaw, "terminal_states", "terminalStates"),
      defaults.terminalStates,
    ),
    dispatch: parseDispatch(defaults.dispatch, getRecord(trackerRaw, "dispatch")),
  };
}

function expandLocalPath(value: string, env: NodeJS.ProcessEnv): string {
  const expanded = expandPathVariables(value, env);
  if (expanded === "~") return os.homedir();
  if (expanded.startsWith("~/")) return path.join(os.homedir(), expanded.slice(2));
  return expanded;
}

function resolveWorkspaceRootExpression(
  value: unknown,
  fallback: string,
  env: NodeJS.ProcessEnv,
): string {
  const expression = stringValue(value, fallback);
  return nonEmptyString(expandLocalPath(expression, env)) === undefined ? fallback : expression;
}

function parseDispatch(defaults: TrackerSettings["dispatch"], raw: Record<string, unknown>) {
  const onlyRoutesRaw = getAny(raw, "only_routes", "onlyRoutes");
  const onlyRoutes =
    onlyRoutesRaw === null
      ? null
      : onlyRoutesRaw === undefined
        ? defaults.onlyRoutes
        : normalizeOnlyRoutes(stringArray(onlyRoutesRaw, []));
  return {
    acceptUnrouted: booleanValue(
      getAny(raw, "accept_unrouted", "acceptUnrouted"),
      defaults.acceptUnrouted,
    ),
    onlyRoutes,
    routeLabelPrefix: stringValue(
      getAny(raw, "route_label_prefix", "routeLabelPrefix"),
      defaults.routeLabelPrefix,
    ).trim(),
  };
}

function parseHooks(defaults: HooksSettings, hooksRaw: Record<string, unknown>): HooksSettings {
  return {
    afterCreate: optionalString(getAny(hooksRaw, "after_create", "afterCreate")),
    beforeRun: optionalString(getAny(hooksRaw, "before_run", "beforeRun")),
    afterRun: optionalString(getAny(hooksRaw, "after_run", "afterRun")),
    beforeRemove: optionalString(getAny(hooksRaw, "before_remove", "beforeRemove")),
    timeoutMs: positiveInt(
      getAny(hooksRaw, "timeout_ms", "timeoutMs"),
      defaults.timeoutMs,
      "hooks.timeout_ms",
    ),
  };
}

function parseAgent(defaults: AgentSettings, agentRaw: Record<string, unknown>): AgentSettings {
  const kind = stringValue(getAny(agentRaw, "kind"), defaults.kind);

  return {
    kind,
    maxConcurrentAgents: positiveInt(
      getAny(agentRaw, "max_concurrent_agents", "maxConcurrentAgents") ?? undefined,
      defaults.maxConcurrentAgents,
      "agent.max_concurrent_agents",
    ),
    maxTurns: positiveInt(
      getAny(agentRaw, "max_turns", "maxTurns"),
      defaults.maxTurns,
      "agent.max_turns",
    ),
    maxRetryBackoffMs: positiveInt(
      getAny(agentRaw, "max_retry_backoff_ms", "maxRetryBackoffMs") ?? undefined,
      defaults.maxRetryBackoffMs,
      "agent.max_retry_backoff_ms",
    ),
    ensembleSize: positiveInt(
      getAny(agentRaw, "ensemble_size", "ensembleSize"),
      defaults.ensembleSize,
      "agent.ensemble_size",
    ),
  };
}

function parseAgents(
  raw: Record<string, unknown>,
  codex: CodexSettings,
  claude: ClaudeSettings,
): Record<string, AgentConfig> {
  const baseAgents = defaultAgentRecords(codex, claude);
  const agents = cloneAgentRecords(baseAgents);
  for (const [name, value] of Object.entries(raw)) {
    const normalized = name.trim();
    if (!normalized) throw new Error("agents names must not be blank");
    const recordRaw = asRecord(value, `agents.${normalized}`);
    const executor = stringValue(
      getAny(recordRaw, "executor"),
      normalized === "codex" ? "appserver" : "acp",
    );
    const parsed = parseAgentRecordSchema({ ...recordRaw, executor }, `agents.${normalized}`);
    agents[normalized] = parseAgentRecord(normalized, parsed, {
      codex: baseAgents.codex as AppServerAgentConfig,
      claude: baseAgents.claude as AcpAgentConfig,
    });
  }
  return agents;
}

function parseAgentRecordSchema(
  raw: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const result = agentRecordSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(
    `${label} is invalid: ${result.error.issues.map((issue) => issue.message).join(", ")}`,
  );
}

function parseAgentRecord(
  name: string,
  raw: Record<string, unknown>,
  defaults: { codex: AppServerAgentConfig; claude: AcpAgentConfig },
): AgentConfig {
  const executor = stringValue(getAny(raw, "executor"), name === "codex" ? "appserver" : "acp");
  if (executor === "appserver") return parseAppServerAgent(raw, defaults.codex);
  if (executor === "acp") return parseAcpAgent(raw, defaults.claude, `agents.${name}`);
  throw new Error(`unsupported agents.${name}.executor: ${executor}`);
}

function parseAppServerAgent(
  raw: Record<string, unknown>,
  defaults: AppServerAgentConfig,
): AppServerAgentConfig {
  const codex = parseCodex(defaults, raw);
  return { executor: "appserver", ...codex };
}

function parseAcpAgent(
  raw: Record<string, unknown>,
  defaults: AcpAgentConfig,
  label: string,
): AcpAgentConfig {
  return {
    executor: "acp",
    bridgeCommand: stringValue(
      getAny(raw, "bridge_command", "bridgeCommand", "command"),
      defaults.bridgeCommand,
    ),
    bridgeArgs: stringArray(getAny(raw, "bridge_args", "bridgeArgs"), defaults.bridgeArgs),
    model: optionalString(getAny(raw, "model")) ?? defaults.model,
    permissionMode:
      optionalString(getAny(raw, "permission_mode", "permissionMode")) ?? defaults.permissionMode,
    turnTimeoutMs: positiveInt(
      getAny(raw, "turn_timeout_ms", "turnTimeoutMs"),
      defaults.turnTimeoutMs,
      `${label}.turn_timeout_ms`,
    ),
    stallTimeoutMs: nonNegativeIntWithFallback(
      getAny(raw, "stall_timeout_ms", "stallTimeoutMs"),
      defaults.stallTimeoutMs,
      `${label}.stall_timeout_ms`,
    ),
    strictMcpConfig: booleanValue(
      getAny(raw, "strict_mcp_config", "strictMcpConfig"),
      defaults.strictMcpConfig ?? true,
    ),
  };
}

function defaultAgentRecords(
  codex: CodexSettings,
  claude: ClaudeSettings,
): Record<string, AgentConfig> {
  return {
    codex: { executor: "appserver", ...codex },
    claude: {
      executor: "acp",
      bridgeCommand: claude.command,
      bridgeArgs: ["--permission-mode", claude.permissionMode, "--model", claude.model],
      model: claude.model,
      permissionMode: claude.permissionMode,
      turnTimeoutMs: claude.turnTimeoutMs,
      stallTimeoutMs: claude.stallTimeoutMs,
      strictMcpConfig: claude.strictMcpConfig,
    },
  };
}

function applyKnownAgentRecords(settings: Settings): void {
  const codex = settings.agents.codex;
  if (codex?.executor === "appserver") {
    settings.codex = {
      command: codex.command,
      approvalPolicy: codex.approvalPolicy,
      threadSandbox: codex.threadSandbox,
      turnSandboxPolicy: codex.turnSandboxPolicy,
      turnTimeoutMs: codex.turnTimeoutMs,
      readTimeoutMs: codex.readTimeoutMs,
      stallTimeoutMs: codex.stallTimeoutMs,
    };
  }
  const claude = settings.agents.claude;
  if (claude?.executor === "acp") {
    settings.claude = {
      command: claude.bridgeCommand,
      model: claude.model ?? settings.claude.model,
      permissionMode: claude.permissionMode ?? settings.claude.permissionMode,
      turnTimeoutMs: claude.turnTimeoutMs,
      stallTimeoutMs: claude.stallTimeoutMs,
      strictMcpConfig: claude.strictMcpConfig ?? settings.claude.strictMcpConfig,
    };
  }
}

function parseCodex(defaults: CodexSettings, codexRaw: Record<string, unknown>): CodexSettings {
  return {
    command: stringValue(getAny(codexRaw, "command"), defaults.command),
    approvalPolicy:
      (getAny(codexRaw, "approval_policy", "approvalPolicy") as
        | string
        | Record<string, unknown>
        | undefined) ?? defaults.approvalPolicy,
    threadSandbox: stringOnly(
      getAny(codexRaw, "thread_sandbox", "threadSandbox"),
      defaults.threadSandbox,
      "codex.thread_sandbox",
    ),
    turnSandboxPolicy: optionalMap(
      getAny(codexRaw, "turn_sandbox_policy", "turnSandboxPolicy"),
      defaults.turnSandboxPolicy,
      "codex.turn_sandbox_policy",
    ),
    turnTimeoutMs: positiveInt(
      getAny(codexRaw, "turn_timeout_ms", "turnTimeoutMs"),
      defaults.turnTimeoutMs,
      "codex.turn_timeout_ms",
    ),
    readTimeoutMs: positiveInt(
      getAny(codexRaw, "read_timeout_ms", "readTimeoutMs"),
      defaults.readTimeoutMs,
      "codex.read_timeout_ms",
    ),
    stallTimeoutMs: nonNegativeIntWithFallback(
      getAny(codexRaw, "stall_timeout_ms", "stallTimeoutMs") ?? undefined,
      defaults.stallTimeoutMs,
      "codex.stall_timeout_ms",
    ),
  };
}

function parseClaude(defaults: ClaudeSettings, claudeRaw: Record<string, unknown>): ClaudeSettings {
  return {
    command: stringValue(getAny(claudeRaw, "command"), defaults.command),
    model: stringValue(getAny(claudeRaw, "model"), defaults.model),
    permissionMode: stringValue(
      getAny(claudeRaw, "permission_mode", "permissionMode") ?? undefined,
      defaults.permissionMode,
    ),
    turnTimeoutMs: positiveInt(
      getAny(claudeRaw, "turn_timeout_ms", "turnTimeoutMs") ?? undefined,
      defaults.turnTimeoutMs,
      "claude.turn_timeout_ms",
    ),
    stallTimeoutMs: nonNegativeIntWithFallback(
      getAny(claudeRaw, "stall_timeout_ms", "stallTimeoutMs") ?? undefined,
      defaults.stallTimeoutMs,
      "claude.stall_timeout_ms",
    ),
    strictMcpConfig: booleanValue(
      getAny(claudeRaw, "strict_mcp_config", "strictMcpConfig") ?? undefined,
      defaults.strictMcpConfig,
    ),
  };
}

function parseStatusOverrides(raw: Record<string, unknown>): Map<string, PartialRuntimeSettings> {
  const overrides = new Map<string, PartialRuntimeSettings>();

  for (const [stateName, value] of Object.entries(raw)) {
    const normalizedState = normalizeStateName(stateName);
    if (!normalizedState) throw new Error("status_overrides state names must not be blank");
    const stateRaw = asRecord(value, `status_overrides.${normalizedState}`);

    const unsupported = Object.keys(stateRaw).filter(
      (key) => !["agent", "codex", "claude"].includes(key),
    );
    if (unsupported.length > 0) {
      throw new Error(
        `status_overrides.${normalizedState} contains unsupported keys: ${unsupported.join(", ")}`,
      );
    }

    const next: PartialRuntimeSettings = {};
    if (stateRaw.agent !== undefined)
      next.agent = parsePartialAgent(asRecord(stateRaw.agent, "agent"));
    if (stateRaw.codex !== undefined)
      next.codex = parsePartialCodex(asRecord(stateRaw.codex, "codex"));
    if (stateRaw.claude !== undefined)
      next.claude = parsePartialClaude(asRecord(stateRaw.claude, "claude"));
    overrides.set(normalizedState, next);
  }

  return overrides;
}

function parsePartialAgent(raw: Record<string, unknown>): Partial<AgentSettings> {
  const allowed = [
    "kind",
    "max_concurrent_agents",
    "maxConcurrentAgents",
    "max_turns",
    "maxTurns",
    "max_retry_backoff_ms",
    "maxRetryBackoffMs",
    "ensemble_size",
    "ensembleSize",
  ];
  rejectUnknown(raw, allowed, "status_overrides.*.agent");
  const next: Partial<AgentSettings> = {};
  const kind = getAny(raw, "kind");
  if (kind !== undefined) {
    next.kind = stringValue(kind, "");
  }
  putPositive(raw, next, "max_concurrent_agents", "maxConcurrentAgents", "maxConcurrentAgents");
  putPositive(raw, next, "max_turns", "maxTurns", "maxTurns");
  putPositive(raw, next, "max_retry_backoff_ms", "maxRetryBackoffMs", "maxRetryBackoffMs");
  putPositive(raw, next, "ensemble_size", "ensembleSize", "ensembleSize");
  return next;
}

function parsePartialCodex(raw: Record<string, unknown>): Partial<CodexSettings> {
  const allowed = [
    "command",
    "approval_policy",
    "approvalPolicy",
    "thread_sandbox",
    "threadSandbox",
    "turn_sandbox_policy",
    "turnSandboxPolicy",
    "turn_timeout_ms",
    "turnTimeoutMs",
    "read_timeout_ms",
    "readTimeoutMs",
    "stall_timeout_ms",
    "stallTimeoutMs",
  ];
  rejectUnknown(raw, allowed, "status_overrides.*.codex");
  const next: Partial<CodexSettings> = {};
  if (getAny(raw, "command") !== undefined) next.command = stringValue(getAny(raw, "command"), "");
  if (getAny(raw, "approval_policy", "approvalPolicy") !== undefined) {
    next.approvalPolicy = getAny(raw, "approval_policy", "approvalPolicy") as
      | string
      | Record<string, unknown>;
  }
  if (getAny(raw, "thread_sandbox", "threadSandbox") !== undefined) {
    next.threadSandbox = stringOnly(
      getAny(raw, "thread_sandbox", "threadSandbox"),
      "",
      "status_overrides.*.codex.thread_sandbox",
    );
  }
  if (getAny(raw, "turn_sandbox_policy", "turnSandboxPolicy") !== undefined) {
    next.turnSandboxPolicy = optionalMap(
      getAny(raw, "turn_sandbox_policy", "turnSandboxPolicy"),
      null,
      "status_overrides.*.codex.turn_sandbox_policy",
    );
  }
  putPositive(raw, next, "turn_timeout_ms", "turnTimeoutMs", "turnTimeoutMs");
  putPositive(raw, next, "read_timeout_ms", "readTimeoutMs", "readTimeoutMs");
  putNonNegative(raw, next, "stall_timeout_ms", "stallTimeoutMs", "stallTimeoutMs");
  return next;
}

function parsePartialClaude(raw: Record<string, unknown>): Partial<ClaudeSettings> {
  const allowed = [
    "command",
    "model",
    "permission_mode",
    "permissionMode",
    "turn_timeout_ms",
    "turnTimeoutMs",
    "stall_timeout_ms",
    "stallTimeoutMs",
    "strict_mcp_config",
    "strictMcpConfig",
  ];
  rejectUnknown(raw, allowed, "status_overrides.*.claude");
  const next: Partial<ClaudeSettings> = {};
  if (getAny(raw, "command") !== undefined) next.command = stringValue(getAny(raw, "command"), "");
  if (getAny(raw, "model") !== undefined) next.model = stringValue(getAny(raw, "model"), "");
  if (getAny(raw, "permission_mode", "permissionMode") !== undefined) {
    next.permissionMode = stringValue(getAny(raw, "permission_mode", "permissionMode"), "");
  }
  if (getAny(raw, "strict_mcp_config", "strictMcpConfig") !== undefined) {
    next.strictMcpConfig = booleanValue(getAny(raw, "strict_mcp_config", "strictMcpConfig"), true);
  }
  putPositive(raw, next, "turn_timeout_ms", "turnTimeoutMs", "turnTimeoutMs");
  putNonNegative(raw, next, "stall_timeout_ms", "stallTimeoutMs", "stallTimeoutMs");
  return next;
}

function mergeCodex(base: CodexSettings, override: Partial<CodexSettings>): CodexSettings {
  const merged = { ...base, ...override };
  if (isPlainRecord(base.approvalPolicy) && isPlainRecord(override.approvalPolicy)) {
    merged.approvalPolicy = deepMerge(base.approvalPolicy, override.approvalPolicy);
  }
  if (isPlainRecord(base.turnSandboxPolicy) && isPlainRecord(override.turnSandboxPolicy)) {
    merged.turnSandboxPolicy = deepMerge(base.turnSandboxPolicy, override.turnSandboxPolicy);
  }
  return merged;
}

function cloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    tracker: { ...settings.tracker, dispatch: { ...settings.tracker.dispatch } },
    polling: { ...settings.polling },
    workspace: { ...settings.workspace },
    worker: { ...settings.worker, sshHosts: [...settings.worker.sshHosts] },
    hooks: { ...settings.hooks },
    agent: { ...settings.agent },
    agents: cloneAgentRecords(settings.agents),
    codex: { ...settings.codex },
    claude: { ...settings.claude },
    observability: { ...settings.observability },
    server: { ...settings.server },
    logging: { ...settings.logging },
    statusOverrides: new Map(settings.statusOverrides),
  };
}

function cloneAgentRecords(records: Record<string, AgentConfig>): Record<string, AgentConfig> {
  const cloned: Record<string, AgentConfig> = {};
  for (const [name, record] of Object.entries(records)) {
    cloned[name] =
      record.executor === "appserver"
        ? {
            ...record,
            approvalPolicy: cloneUnknownRecord(record.approvalPolicy),
            turnSandboxPolicy: cloneNullableRecord(record.turnSandboxPolicy),
          }
        : { ...record, bridgeArgs: [...record.bridgeArgs] };
  }
  return cloned;
}

function cloneUnknownRecord(
  value: string | Record<string, unknown>,
): string | Record<string, unknown> {
  return isPlainRecord(value) ? deepMerge({}, value) : value;
}

function cloneNullableRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return value === null ? null : deepMerge({}, value);
}

function deepMerge(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = out[key];
    out[key] = isPlainRecord(existing) && isPlainRecord(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

function getRecord(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const value = getAny(raw, ...keys);
  if (value === undefined || value === null) return {};
  return asRecord(value, keys[0] ?? "value");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a map`);
  return value;
}

function getAny(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) return raw[key];
  }
  return undefined;
}

function stringValue(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function stringOnly(value: unknown, fallback: string, label: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function optionalMap(
  value: unknown,
  fallback: Record<string, unknown> | null,
  label: string,
): Record<string, unknown> | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!isPlainRecord(value)) throw new Error(`${label} must be a map`);
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text === "" ? null : text;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) throw new Error("expected a list of strings");
  return value.map((item) => String(item));
}

function normalizeOnlyRoutes(routes: string[]): string[] {
  const normalized = routes.map(normalizeRouteName);
  if (normalized.some((route) => route === "")) {
    throw new Error("tracker.dispatch.only_routes must not contain blank routes");
  }
  return [...new Set(normalized)];
}

function positiveInt(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  const number = numberValue(value);
  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`${label} must be a positive integer`);
  return number;
}

function nonNegativeInt(value: unknown, label: string): number {
  const number = numberValue(value);
  if (!Number.isInteger(number) || number < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return number;
}

function nonNegativeIntWithFallback(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  return nonNegativeInt(value, label);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("expected a boolean");
}

function resolveEnv(value: string, env: NodeJS.ProcessEnv): string {
  const name = wholeEnvName(value);
  if (name === null) return value;
  return env[name] ?? "";
}

function resolveConfiguredSecret(
  value: unknown,
  env: NodeJS.ProcessEnv,
  fallbackEnvName: string,
): string | undefined {
  if (value === undefined || value === null) return nonEmptyString(env[fallbackEnvName]);
  const resolved = resolveEnv(stringValue(value, ""), env);
  return nonEmptyString(resolved) ?? nonEmptyString(env[fallbackEnvName]);
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function expandPathVariables(value: string, env: NodeJS.ProcessEnv): string {
  const name = wholeEnvName(value);
  return name === null ? value : (env[name] ?? "");
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim() === "" ? Number.NaN : Number(value);
  return Number.NaN;
}

function wholeEnvName(value: string): string | null {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return match?.[1] ?? null;
}

function putPositive<T extends object>(
  raw: Record<string, unknown>,
  target: T,
  snake: string,
  camel: string,
  property: keyof T,
): void {
  const value = getAny(raw, snake, camel);
  if (value !== undefined) target[property] = positiveInt(value, 1, String(property)) as T[keyof T];
}

function putNonNegative<T extends object>(
  raw: Record<string, unknown>,
  target: T,
  snake: string,
  camel: string,
  property: keyof T,
): void {
  const value = getAny(raw, snake, camel);
  if (value !== undefined) target[property] = nonNegativeInt(value, String(property)) as T[keyof T];
}

function rejectUnknown(raw: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(`${label} contains unsupported keys: ${unknown.join(", ")}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
