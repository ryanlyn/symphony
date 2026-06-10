import { execaSync } from "execa";
import { z } from "zod";
import type {
  AgentKind,
  AgentConfig,
  AgentSettings,
  AcpAgentConfig,
  AppServerAgentConfig,
  BoxPoolProvider,
  BoxPoolSettings,
  BoxPoolSettingsInput,
  ClaudeSettings,
  CodexSettings,
  HooksSettings,
  PartialRuntimeSettings,
  Settings,
  TrackerKind,
  TrackerSettings,
  WorkerSettings,
} from "@symphony/domain";
import {
  CODEX_APPROVAL_POLICY_NAMES,
  CODEX_SANDBOX_MODES,
  PROVIDER_KINDS,
  TRACKER_KINDS,
  withDerivedMaxInFlight,
} from "@symphony/domain";

const appServerAgentRecordSchema = z
  .object({
    executor: z.literal("appserver"),
    command: z.unknown().optional(),
    approvalPolicy: z.unknown().optional(),
    threadSandbox: z.unknown().optional(),
    turnSandboxPolicy: z.unknown().optional(),
    turnTimeoutMs: z.unknown().optional(),
    readTimeoutMs: z.unknown().optional(),
    stallTimeoutMs: z.unknown().optional(),
  })
  .strict();
const acpAgentRecordSchema = z
  .object({
    executor: z.literal("acp"),
    bridgeCommand: z.unknown().optional(),
    bridgeArgs: z.unknown().optional(),
    command: z.unknown().optional(),
    model: z.unknown().optional(),
    permissionMode: z.unknown().optional(),
    turnTimeoutMs: z.unknown().optional(),
    stallTimeoutMs: z.unknown().optional(),
    strictMcpConfig: z.unknown().optional(),
  })
  .strict();
const agentRecordSchema = z.discriminatedUnion("executor", [
  appServerAgentRecordSchema,
  acpAgentRecordSchema,
]);

const trackerRawSchema = z
  .object({
    kind: z.unknown().optional(),
    endpoint: z.unknown().optional(),
    apiKey: z.unknown().optional(),
    projectSlug: z.unknown().optional(),
    assignee: z.unknown().optional(),
    activeStates: z.unknown().optional(),
    terminalStates: z.unknown().optional(),
    dispatch: z
      .object({
        acceptUnrouted: z.unknown().optional(),
        onlyRoutes: z.unknown().optional(),
        routeLabelPrefix: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const pollingRawSchema = z.object({ intervalMs: z.unknown().optional() }).strict();
const workspaceRawSchema = z.object({ root: z.unknown().optional() }).strict();
const rawRecordSchema = z.record(z.string(), z.unknown());
const workerRawSchema = z
  .object({
    sshHosts: z.unknown().optional(),
    sshTimeoutMs: z.unknown().optional(),
    maxConcurrentAgentsPerHost: z.unknown().optional(),
    boxPool: z.unknown().optional(),
  })
  .strict();
const boxPoolSpendRawSchema = z
  .object({
    maxConcurrentBoxes: z.unknown().optional(),
    maxBoxSeconds: z.unknown().optional(),
    dailyBoxSeconds: z.unknown().optional(),
  })
  .strict();
const boxPoolRawSchema = z
  .object({
    enabled: z.unknown().optional(),
    provider: z.unknown().optional(),
    min: z.unknown().optional(),
    max: z.unknown().optional(),
    warm: z.unknown().optional(),
    maxInFlight: z.unknown().optional(),
    ttlMs: z.unknown().optional(),
    idleReapMs: z.unknown().optional(),
    acquireTimeoutMs: z.unknown().optional(),
    reapIntervalMs: z.unknown().optional(),
    staleHeartbeatMs: z.unknown().optional(),
    drainDeadlineMs: z.unknown().optional(),
    maxBoxesPerIssue: z.unknown().optional(),
    coResidence: z.unknown().optional(),
    maxConcurrentTunnels: z.unknown().optional(),
    spend: boxPoolSpendRawSchema.optional(),
    providerOptions: rawRecordSchema.optional(),
  })
  .strict();
const hooksRawSchema = z
  .object({
    afterCreate: z.unknown().optional(),
    beforeRun: z.unknown().optional(),
    afterRun: z.unknown().optional(),
    beforeRemove: z.unknown().optional(),
    timeoutMs: z.unknown().optional(),
  })
  .strict();
const agentRawSchema = z
  .object({
    kind: z.unknown().optional(),
    maxConcurrentAgents: z.unknown().optional(),
    maxTurns: z.unknown().optional(),
    maxRetryBackoffMs: z.unknown().optional(),
    ensembleSize: z.unknown().optional(),
  })
  .strict();
const codexRawSchema = z
  .object({
    command: z.unknown().optional(),
    approvalPolicy: z.unknown().optional(),
    threadSandbox: z.unknown().optional(),
    turnSandboxPolicy: z.unknown().optional(),
    turnTimeoutMs: z.unknown().optional(),
    readTimeoutMs: z.unknown().optional(),
    stallTimeoutMs: z.unknown().optional(),
  })
  .strict();
const claudeRawSchema = z
  .object({
    command: z.unknown().optional(),
    model: z.unknown().optional(),
    permissionMode: z.unknown().optional(),
    turnTimeoutMs: z.unknown().optional(),
    stallTimeoutMs: z.unknown().optional(),
    strictMcpConfig: z.unknown().optional(),
  })
  .strict();
const observabilityRawSchema = z
  .object({
    dashboardEnabled: z.unknown().optional(),
    refreshMs: z.unknown().optional(),
    renderIntervalMs: z.unknown().optional(),
  })
  .strict();
const serverRawSchema = z
  .object({
    host: z.unknown().optional(),
    port: z.unknown().optional(),
  })
  .strict();
const loggingRawSchema = z.object({ logFile: z.unknown().optional() }).strict();
const partialAgentRawSchema = agentRawSchema.partial().strict();
const partialCodexRawSchema = codexRawSchema.partial().strict();
const partialClaudeRawSchema = claudeRawSchema.partial().strict();
const statusOverrideRawSchema = z
  .object({
    agent: partialAgentRawSchema.optional(),
    codex: partialCodexRawSchema.optional(),
    claude: partialClaudeRawSchema.optional(),
  })
  .strict();

const workflowConfigSchema = z.preprocess(
  normalizeWorkflowConfig,
  z
    .object({
      tracker: trackerRawSchema.optional(),
      polling: pollingRawSchema.optional(),
      workspace: workspaceRawSchema.optional(),
      worker: workerRawSchema.optional(),
      hooks: hooksRawSchema.optional(),
      agent: agentRawSchema.optional(),
      agents: z.record(z.string(), rawRecordSchema).optional(),
      codex: codexRawSchema.optional(),
      claude: claudeRawSchema.optional(),
      observability: observabilityRawSchema.optional(),
      server: serverRawSchema.optional(),
      logging: loggingRawSchema.optional(),
      statusOverrides: z.record(z.string(), statusOverrideRawSchema).optional(),
    })
    .passthrough(),
);

type WorkflowConfigRaw = z.infer<typeof workflowConfigSchema>;
type TrackerRaw = z.infer<typeof trackerRawSchema>;
type DispatchRaw = NonNullable<TrackerRaw["dispatch"]>;
type HooksRaw = z.infer<typeof hooksRawSchema>;
type AgentRaw = z.infer<typeof agentRawSchema>;
type CodexRaw = z.infer<typeof codexRawSchema>;
type ClaudeRaw = z.infer<typeof claudeRawSchema>;
type StatusOverridesRaw = NonNullable<WorkflowConfigRaw["statusOverrides"]>;

const trackerAliases = {
  api_key: "apiKey",
  project_slug: "projectSlug",
  active_states: "activeStates",
  terminal_states: "terminalStates",
};
const dispatchAliases = {
  accept_unrouted: "acceptUnrouted",
  only_routes: "onlyRoutes",
  route_label_prefix: "routeLabelPrefix",
};
const pollingAliases = { interval_ms: "intervalMs" };
const workspaceAliases = {};
const workerAliases = {
  ssh_hosts: "sshHosts",
  ssh_timeout_ms: "sshTimeoutMs",
  max_concurrent_agents_per_host: "maxConcurrentAgentsPerHost",
  box_pool: "boxPool",
};
// NOTE: providerOptions (provider_options) is intentionally NOT alias-normalized.
// The normalizer is a flat per-key map that does not recurse into nested maps, so
// provider_options is passed through to providers verbatim (snake_case preserved).
// StaticSshBoxProvider therefore accepts both ssh_hosts and sshHosts.
const boxPoolAliases = {
  max_in_flight: "maxInFlight",
  ttl_ms: "ttlMs",
  idle_reap_ms: "idleReapMs",
  acquire_timeout_ms: "acquireTimeoutMs",
  reap_interval_ms: "reapIntervalMs",
  stale_heartbeat_ms: "staleHeartbeatMs",
  drain_deadline_ms: "drainDeadlineMs",
  max_boxes_per_issue: "maxBoxesPerIssue",
  co_residence: "coResidence",
  max_concurrent_tunnels: "maxConcurrentTunnels",
  provider_options: "providerOptions",
};
const boxPoolSpendAliases = {
  max_concurrent_boxes: "maxConcurrentBoxes",
  max_box_seconds: "maxBoxSeconds",
  daily_box_seconds: "dailyBoxSeconds",
};
const hooksAliases = {
  after_create: "afterCreate",
  before_run: "beforeRun",
  after_run: "afterRun",
  before_remove: "beforeRemove",
  timeout_ms: "timeoutMs",
};
const agentAliases = {
  max_concurrent_agents: "maxConcurrentAgents",
  max_turns: "maxTurns",
  max_retry_backoff_ms: "maxRetryBackoffMs",
  ensemble_size: "ensembleSize",
};
const codexAliases = {
  approval_policy: "approvalPolicy",
  thread_sandbox: "threadSandbox",
  turn_sandbox_policy: "turnSandboxPolicy",
  turn_timeout_ms: "turnTimeoutMs",
  read_timeout_ms: "readTimeoutMs",
  stall_timeout_ms: "stallTimeoutMs",
};
const claudeAliases = {
  permission_mode: "permissionMode",
  turn_timeout_ms: "turnTimeoutMs",
  stall_timeout_ms: "stallTimeoutMs",
  strict_mcp_config: "strictMcpConfig",
};
const acpAgentAliases = {
  bridge_command: "bridgeCommand",
  bridge_args: "bridgeArgs",
};
const agentRecordAliases = {
  ...codexAliases,
  ...claudeAliases,
  ...acpAgentAliases,
};
const observabilityAliases = {
  dashboard_enabled: "dashboardEnabled",
  refresh_ms: "refreshMs",
  render_interval_ms: "renderIntervalMs",
};
const loggingAliases = { log_file: "logFile" };

export interface DefaultSettingsOptions {
  tmpdir?: string | undefined;
  cwd?: string | undefined;
}

export const defaultSettings = (options: DefaultSettingsOptions = {}): Settings => {
  const tmpdir = options.tmpdir ?? "/tmp";
  const cwd = options.cwd ?? ".";
  const workspaceRoot = joinPath(tmpdir, "symphony_workspaces");
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
      root: workspaceRoot,
      rootExpression: workspaceRoot,
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
    logging: { logFile: joinPath(cwd, "log/symphony.log") },
    statusOverrides: new Map(),
  };
};

export function parseConfig(
  raw: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
  defaults: DefaultSettingsOptions = {},
): Settings {
  const settings = defaultSettings(defaults);
  const parsed = parseWorkflowConfig(raw);

  const trackerRaw = parsed.tracker ?? {};
  settings.tracker = parseTracker(settings.tracker, trackerRaw, env);

  const pollingRaw = parsed.polling ?? {};
  settings.polling.intervalMs = positiveInt(
    pollingRaw.intervalMs,
    settings.polling.intervalMs,
    "polling.interval_ms",
  );

  const workspaceRaw = parsed.workspace ?? {};
  const workspaceRootFallback = settings.workspace.rootExpression ?? settings.workspace.root;
  const workspaceRootExpression = resolveWorkspaceRootExpression(
    nonEmptyString(env.SYMPHONY_WORKSPACE_ROOT) ?? workspaceRaw.root,
    workspaceRootFallback,
    env,
  );
  settings.workspace.rootExpression = workspaceRootExpression;
  settings.workspace.root = expandLocalPath(workspaceRootExpression, env);

  const workerRaw = parsed.worker ?? {};
  settings.worker.sshHosts = stringArray(workerRaw.sshHosts, settings.worker.sshHosts);
  settings.worker.sshTimeoutMs = positiveInt(
    workerRaw.sshTimeoutMs,
    settings.worker.sshTimeoutMs,
    "worker.ssh_timeout_ms",
  );
  const hostCap = workerRaw.maxConcurrentAgentsPerHost;
  if (hostCap !== undefined) {
    settings.worker.maxConcurrentAgentsPerHost = positiveInt(
      hostCap,
      1,
      "worker.max_concurrent_agents_per_host",
    );
  }
  const boxPool = parseBoxPool(workerRaw.boxPool);
  if (boxPool) settings.worker.boxPool = boxPool;
  if (boxPool?.enabled && settings.worker.sshHosts.length > 0) {
    throw new Error("worker.box_pool.enabled cannot be combined with worker.ssh_hosts");
  }

  settings.hooks = parseHooks(settings.hooks, parsed.hooks ?? {});
  settings.agent = parseAgent(settings.agent, parsed.agent ?? {});
  settings.codex = parseCodex(settings.codex, parsed.codex ?? {});
  settings.claude = parseClaude(settings.claude, parsed.claude ?? {});
  settings.agents = parseAgents(parsed.agents ?? {}, settings.codex, settings.claude);
  applyKnownAgentRecords(settings);

  const observabilityRaw = parsed.observability ?? {};
  settings.observability.dashboardEnabled = booleanValue(
    observabilityRaw.dashboardEnabled,
    settings.observability.dashboardEnabled,
  );
  settings.observability.refreshMs = positiveInt(
    observabilityRaw.refreshMs,
    settings.observability.refreshMs,
    "observability.refresh_ms",
  );
  settings.observability.renderIntervalMs = positiveInt(
    observabilityRaw.renderIntervalMs,
    settings.observability.renderIntervalMs,
    "observability.render_interval_ms",
  );

  const serverRaw = parsed.server ?? {};
  settings.server.host = stringValue(serverRaw.host, settings.server.host);
  const port = serverRaw.port;
  if (port !== undefined) settings.server.port = nonNegativeInt(port, "server.port");

  settings.statusOverrides = parseStatusOverrides(parsed.statusOverrides ?? {});
  return settings;
}

function joinPath(root: string, child: string): string {
  if (root === "") return child;
  return `${root.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
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
  if (value === undefined || value === null) return "";
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value).trim().toLowerCase();
}

function parseTracker(
  defaults: TrackerSettings,
  trackerRaw: TrackerRaw,
  env: NodeJS.ProcessEnv,
): TrackerSettings {
  const kindRaw = trackerRaw.kind;
  const kind =
    kindRaw === undefined || kindRaw === null
      ? defaults.kind
      : trackerKindValue(kindRaw, "tracker.kind");

  const apiKey = resolveConfiguredSecret(trackerRaw.apiKey, env, "LINEAR_API_KEY");
  const projectSlug = resolveEnv(stringValue(trackerRaw.projectSlug, ""), env) || undefined;
  const assignee = resolveConfiguredSecret(trackerRaw.assignee, env, "LINEAR_ASSIGNEE");

  return {
    ...defaults,
    kind,
    endpoint: stringValue(trackerRaw.endpoint, defaults.endpoint),
    apiKey,
    projectSlug,
    assignee,
    activeStates: stringArray(trackerRaw.activeStates, defaults.activeStates),
    terminalStates: stringArray(trackerRaw.terminalStates, defaults.terminalStates),
    dispatch: parseDispatch(defaults.dispatch, trackerRaw.dispatch ?? {}),
  };
}

function expandLocalPath(value: string, env: NodeJS.ProcessEnv): string {
  const expanded = expandPathVariables(value, env);
  const home = nonEmptyString(env.HOME) ?? nonEmptyString(env.USERPROFILE);
  if (home && expanded === "~") return home;
  if (home && expanded.startsWith("~/")) return joinPath(home, expanded.slice(2));
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

function parseDispatch(defaults: TrackerSettings["dispatch"], raw: DispatchRaw) {
  const onlyRoutesRaw = raw.onlyRoutes;
  const onlyRoutes =
    onlyRoutesRaw === null
      ? null
      : onlyRoutesRaw === undefined
        ? defaults.onlyRoutes
        : normalizeOnlyRoutes(stringArray(onlyRoutesRaw, []));
  return {
    acceptUnrouted: booleanValue(raw.acceptUnrouted, defaults.acceptUnrouted),
    onlyRoutes,
    routeLabelPrefix: stringValue(raw.routeLabelPrefix, defaults.routeLabelPrefix).trim(),
  };
}

function parseHooks(defaults: HooksSettings, hooksRaw: HooksRaw): HooksSettings {
  return {
    afterCreate: optionalString(hooksRaw.afterCreate),
    beforeRun: optionalString(hooksRaw.beforeRun),
    afterRun: optionalString(hooksRaw.afterRun),
    beforeRemove: optionalString(hooksRaw.beforeRemove),
    timeoutMs: positiveInt(hooksRaw.timeoutMs, defaults.timeoutMs, "hooks.timeout_ms"),
  };
}

function parseBoxPool(raw: unknown): BoxPoolSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  const boxPoolRaw = parseBoxPoolSchema(raw);
  const providerOptions = optionalMap(
    boxPoolRaw.providerOptions,
    null,
    "worker.box_pool.provider_options",
  );

  const enabled = booleanValue(boxPoolRaw.enabled, false);
  const provider = boxPoolProviderValue(boxPoolRaw.provider, "fake", "worker.box_pool.provider");
  const min = nonNegativeIntWithFallback(boxPoolRaw.min, 0, "worker.box_pool.min");
  const max = positiveInt(boxPoolRaw.max, 1, "worker.box_pool.max");
  const warm = nonNegativeIntWithFallback(boxPoolRaw.warm, 1, "worker.box_pool.warm");

  if (max < min) {
    throw new Error("worker.box_pool.max must be >= worker.box_pool.min");
  }
  if (warm > max) {
    throw new Error("worker.box_pool.warm must be <= worker.box_pool.max");
  }

  // `maxInFlight` is a derived getter over `slotsPerMachine` (domain `withDerivedMaxInFlight`),
  // so the constructed object carries exactly ONE own field (`slotsPerMachine`). The config key
  // `worker.box_pool.max_in_flight` is unchanged; it parses into `slotsPerMachine`.
  const input: BoxPoolSettingsInput = {
    enabled,
    provider,
    min,
    max,
    warm,
    slotsPerMachine: positiveInt(boxPoolRaw.maxInFlight, 1, "worker.box_pool.max_in_flight"),
    ttlMs: positiveInt(boxPoolRaw.ttlMs, 3_600_000, "worker.box_pool.ttl_ms"),
    idleReapMs: positiveInt(boxPoolRaw.idleReapMs, 300_000, "worker.box_pool.idle_reap_ms"),
    acquireTimeoutMs: positiveInt(
      boxPoolRaw.acquireTimeoutMs,
      30_000,
      "worker.box_pool.acquire_timeout_ms",
    ),
    reapIntervalMs: positiveInt(
      boxPoolRaw.reapIntervalMs,
      15_000,
      "worker.box_pool.reap_interval_ms",
    ),
    staleHeartbeatMs: positiveInt(
      boxPoolRaw.staleHeartbeatMs,
      600_000,
      "worker.box_pool.stale_heartbeat_ms",
    ),
    drainDeadlineMs: positiveInt(
      boxPoolRaw.drainDeadlineMs,
      30_000,
      "worker.box_pool.drain_deadline_ms",
    ),
  };

  const settings = withDerivedMaxInFlight(input);

  if (boxPoolRaw.maxBoxesPerIssue !== undefined) {
    settings.maxBoxesPerIssue = positiveInt(
      boxPoolRaw.maxBoxesPerIssue,
      1,
      "worker.box_pool.max_boxes_per_issue",
    );
  }

  // Co-residence opt-in + tunnel ceiling stay absent unless explicitly set, so a default config's
  // settings object keeps exactly the same own fields (the absent-box_pool deep-equal-clone holds).
  if (boxPoolRaw.coResidence !== undefined) {
    settings.coResidence = booleanValue(boxPoolRaw.coResidence, false);
  }
  if (boxPoolRaw.maxConcurrentTunnels !== undefined) {
    settings.maxConcurrentTunnels = positiveInt(
      boxPoolRaw.maxConcurrentTunnels,
      1,
      "worker.box_pool.max_concurrent_tunnels",
    );
  }

  const spend = parseBoxPoolSpend(boxPoolRaw.spend);
  if (spend) settings.spend = spend;
  if (providerOptions) settings.providerOptions = providerOptions;

  if (enabled && provider === "static-ssh" && !hasStaticSshHosts(providerOptions)) {
    throw new Error("worker.box_pool.provider_options.ssh_hosts is required for static-ssh");
  }

  return settings;
}

function parseBoxPoolSpend(raw: unknown): BoxPoolSettings["spend"] {
  if (raw === undefined || raw === null) return undefined;
  const spendRaw = raw as Record<string, unknown>;
  const spend: NonNullable<BoxPoolSettings["spend"]> = {};
  if (spendRaw.maxConcurrentBoxes !== undefined) {
    spend.maxConcurrentBoxes = positiveInt(
      spendRaw.maxConcurrentBoxes,
      1,
      "worker.box_pool.spend.max_concurrent_boxes",
    );
  }
  if (spendRaw.maxBoxSeconds !== undefined) {
    spend.maxBoxSeconds = positiveInt(
      spendRaw.maxBoxSeconds,
      1,
      "worker.box_pool.spend.max_box_seconds",
    );
  }
  if (spendRaw.dailyBoxSeconds !== undefined) {
    spend.dailyBoxSeconds = positiveInt(
      spendRaw.dailyBoxSeconds,
      1,
      "worker.box_pool.spend.daily_box_seconds",
    );
  }
  return spend;
}

function parseBoxPoolSchema(raw: unknown): z.infer<typeof boxPoolRawSchema> {
  const result = boxPoolRawSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(configErrorMessage(result.error, "worker.box_pool"));
}

function hasStaticSshHosts(providerOptions: Record<string, unknown> | null): boolean {
  if (!providerOptions) return false;
  const hosts = providerOptions.ssh_hosts ?? providerOptions.sshHosts;
  return (
    Array.isArray(hosts) && hosts.length > 0 && hosts.every((host) => typeof host === "string")
  );
}

function boxPoolProviderValue(
  value: unknown,
  fallback: BoxPoolProvider,
  label: string,
): BoxPoolProvider {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (isOneOf(value, PROVIDER_KINDS)) return value;
  throw new Error(`unsupported ${label}: ${value}`);
}

function parseAgent(defaults: AgentSettings, agentRaw: AgentRaw): AgentSettings {
  const kind = stringValue(agentRaw.kind, defaults.kind);

  return {
    kind,
    maxConcurrentAgents: positiveInt(
      agentRaw.maxConcurrentAgents ?? undefined,
      defaults.maxConcurrentAgents,
      "agent.max_concurrent_agents",
    ),
    maxTurns: positiveInt(agentRaw.maxTurns, defaults.maxTurns, "agent.max_turns"),
    maxRetryBackoffMs: positiveInt(
      agentRaw.maxRetryBackoffMs ?? undefined,
      defaults.maxRetryBackoffMs,
      "agent.max_retry_backoff_ms",
    ),
    ensembleSize: positiveInt(agentRaw.ensembleSize, defaults.ensembleSize, "agent.ensemble_size"),
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
    const executor = stringValue(recordRaw.executor, normalized === "codex" ? "appserver" : "acp");
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
  throw new Error(configErrorMessage(result.error, label));
}

function parseAgentRecord(
  name: string,
  raw: Record<string, unknown>,
  defaults: { codex: AppServerAgentConfig; claude: AcpAgentConfig },
): AgentConfig {
  const executor = stringValue(raw.executor, name === "codex" ? "appserver" : "acp");
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
    bridgeCommand: stringValue(raw.bridgeCommand ?? raw.command, defaults.bridgeCommand),
    bridgeArgs: stringArray(raw.bridgeArgs, defaults.bridgeArgs),
    model: optionalString(raw.model) ?? defaults.model,
    permissionMode: optionalString(raw.permissionMode) ?? defaults.permissionMode,
    turnTimeoutMs: positiveInt(
      raw.turnTimeoutMs,
      defaults.turnTimeoutMs,
      `${label}.turn_timeout_ms`,
    ),
    stallTimeoutMs: nonNegativeIntWithFallback(
      raw.stallTimeoutMs,
      defaults.stallTimeoutMs,
      `${label}.stall_timeout_ms`,
    ),
    strictMcpConfig: booleanValue(raw.strictMcpConfig, defaults.strictMcpConfig ?? true),
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

function parseCodex(defaults: CodexSettings, codexRaw: CodexRaw): CodexSettings {
  return {
    command: stringValue(codexRaw.command, defaults.command),
    approvalPolicy: approvalPolicyValue(
      codexRaw.approvalPolicy,
      defaults.approvalPolicy,
      "codex.approval_policy",
    ),
    threadSandbox: sandboxModeValue(
      codexRaw.threadSandbox,
      defaults.threadSandbox,
      "codex.thread_sandbox",
    ),
    turnSandboxPolicy: optionalMap(
      codexRaw.turnSandboxPolicy,
      defaults.turnSandboxPolicy,
      "codex.turn_sandbox_policy",
    ),
    turnTimeoutMs: positiveInt(
      codexRaw.turnTimeoutMs,
      defaults.turnTimeoutMs,
      "codex.turn_timeout_ms",
    ),
    readTimeoutMs: positiveInt(
      codexRaw.readTimeoutMs,
      defaults.readTimeoutMs,
      "codex.read_timeout_ms",
    ),
    stallTimeoutMs: nonNegativeIntWithFallback(
      codexRaw.stallTimeoutMs ?? undefined,
      defaults.stallTimeoutMs,
      "codex.stall_timeout_ms",
    ),
  };
}

function parseClaude(defaults: ClaudeSettings, claudeRaw: ClaudeRaw): ClaudeSettings {
  return {
    command: stringValue(claudeRaw.command, defaults.command),
    model: stringValue(claudeRaw.model, defaults.model),
    permissionMode: stringValue(claudeRaw.permissionMode ?? undefined, defaults.permissionMode),
    turnTimeoutMs: positiveInt(
      claudeRaw.turnTimeoutMs ?? undefined,
      defaults.turnTimeoutMs,
      "claude.turn_timeout_ms",
    ),
    stallTimeoutMs: nonNegativeIntWithFallback(
      claudeRaw.stallTimeoutMs ?? undefined,
      defaults.stallTimeoutMs,
      "claude.stall_timeout_ms",
    ),
    strictMcpConfig: booleanValue(claudeRaw.strictMcpConfig ?? undefined, defaults.strictMcpConfig),
  };
}

function parseStatusOverrides(raw: StatusOverridesRaw): Map<string, PartialRuntimeSettings> {
  const overrides = new Map<string, PartialRuntimeSettings>();

  for (const [stateName, value] of Object.entries(raw)) {
    const normalizedState = normalizeStateName(stateName);
    if (!normalizedState) throw new Error("status_overrides state names must not be blank");

    const next: PartialRuntimeSettings = {};
    if (value.agent !== undefined) next.agent = parsePartialAgent(value.agent);
    if (value.codex !== undefined) next.codex = parsePartialCodex(value.codex);
    if (value.claude !== undefined) next.claude = parsePartialClaude(value.claude);
    overrides.set(normalizedState, next);
  }

  return overrides;
}

function parsePartialAgent(raw: Partial<AgentRaw>): Partial<AgentSettings> {
  const next: Partial<AgentSettings> = {};
  const kind = raw.kind;
  if (kind !== undefined) {
    next.kind = stringValue(kind, "");
  }
  putPositive(raw, next, "maxConcurrentAgents", "maxConcurrentAgents");
  putPositive(raw, next, "maxTurns", "maxTurns");
  putPositive(raw, next, "maxRetryBackoffMs", "maxRetryBackoffMs");
  putPositive(raw, next, "ensembleSize", "ensembleSize");
  return next;
}

function parsePartialCodex(raw: Partial<CodexRaw>): Partial<CodexSettings> {
  const next: Partial<CodexSettings> = {};
  if (raw.command !== undefined) next.command = stringValue(raw.command, "");
  if (raw.approvalPolicy !== undefined) {
    next.approvalPolicy = approvalPolicyValue(
      raw.approvalPolicy,
      "never",
      "status_overrides.*.codex.approval_policy",
    );
  }
  if (raw.threadSandbox !== undefined) {
    next.threadSandbox = sandboxModeValue(
      raw.threadSandbox,
      "workspace-write",
      "status_overrides.*.codex.thread_sandbox",
    );
  }
  if (raw.turnSandboxPolicy !== undefined) {
    next.turnSandboxPolicy = optionalMap(
      raw.turnSandboxPolicy,
      null,
      "status_overrides.*.codex.turn_sandbox_policy",
    );
  }
  putPositive(raw, next, "turnTimeoutMs", "turnTimeoutMs");
  putPositive(raw, next, "readTimeoutMs", "readTimeoutMs");
  putNonNegative(raw, next, "stallTimeoutMs", "stallTimeoutMs");
  return next;
}

function parsePartialClaude(raw: Partial<ClaudeRaw>): Partial<ClaudeSettings> {
  const next: Partial<ClaudeSettings> = {};
  if (raw.command !== undefined) next.command = stringValue(raw.command, "");
  if (raw.model !== undefined) next.model = stringValue(raw.model, "");
  if (raw.permissionMode !== undefined) {
    next.permissionMode = stringValue(raw.permissionMode, "");
  }
  if (raw.strictMcpConfig !== undefined) {
    next.strictMcpConfig = booleanValue(raw.strictMcpConfig, true);
  }
  putPositive(raw, next, "turnTimeoutMs", "turnTimeoutMs");
  putNonNegative(raw, next, "stallTimeoutMs", "stallTimeoutMs");
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
    worker: cloneWorkerSettings(settings.worker),
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

function cloneWorkerSettings(worker: WorkerSettings): WorkerSettings {
  const cloned: WorkerSettings = { ...worker, sshHosts: [...worker.sshHosts] };
  if (worker.boxPool === undefined) {
    delete cloned.boxPool;
  } else {
    cloned.boxPool = cloneBoxPool(worker.boxPool);
  }
  return cloned;
}

function cloneBoxPool(boxPool: BoxPoolSettings): BoxPoolSettings {
  // A shallow spread copies the enumerable `maxInFlight` getter as a plain data property; strip it
  // and re-install the derived accessor over the cloned `slotsPerMachine` so the clone stays
  // drift-proof (single own field) exactly like the parse path.
  const { maxInFlight: _maxInFlight, ...rest } = boxPool;
  const input: BoxPoolSettingsInput = { ...rest };
  if (boxPool.spend !== undefined) input.spend = { ...boxPool.spend };
  if (boxPool.providerOptions !== undefined) {
    // structuredClone guarantees nested arrays/objects (e.g. ssh_hosts) are copied,
    // so a per-issue settings clone never aliases the source providerOptions.
    input.providerOptions = structuredClone(boxPool.providerOptions);
  }
  return withDerivedMaxInFlight(input);
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
  value: CodexSettings["approvalPolicy"],
): CodexSettings["approvalPolicy"] {
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a map`);
  return value;
}

function parseWorkflowConfig(raw: Record<string, unknown>): WorkflowConfigRaw {
  const result = workflowConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(configErrorMessage(result.error));
}

function configErrorMessage(error: z.ZodError, baseLabel?: string): string {
  const issue = error.issues[0];
  if (!issue) return `${baseLabel ?? "workflow"} is invalid`;
  const label = pathLabel(issue.path, baseLabel);
  if (issue.code === "unrecognized_keys") {
    return `${label} contains unsupported keys: ${issue.keys.join(", ")}`;
  }
  if (issue.code === "invalid_type") {
    return `${label} must be a map`;
  }
  return `${label} is invalid: ${issue.message}`;
}

function pathLabel(
  pathSegments: readonly (string | number | symbol)[],
  baseLabel?: string,
): string {
  const suffix = pathSegments.map(String).join(".");
  if (suffix && baseLabel) return `${baseLabel}.${suffix}`;
  if (suffix) return suffix;
  return baseLabel ?? "workflow";
}

function normalizeWorkflowConfig(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  const raw = normalizeAliases(value, { status_overrides: "statusOverrides" });
  const normalized: Record<string, unknown> = { ...raw };

  normalizeNested(normalized, "tracker", trackerAliases);
  normalizeNested(normalized, "polling", pollingAliases);
  normalizeNested(normalized, "workspace", workspaceAliases);
  normalizeNested(normalized, "worker", workerAliases);
  if (isPlainRecord(normalized.worker) && isPlainRecord(normalized.worker.boxPool)) {
    normalizeNested(normalized.worker, "boxPool", boxPoolAliases);
    const boxPool = normalized.worker.boxPool;
    // providerOptions is intentionally NOT normalized (flat per-key normalizer, no recursion).
    if (isPlainRecord(boxPool) && isPlainRecord(boxPool.spend)) {
      normalizeNested(boxPool, "spend", boxPoolSpendAliases);
    }
  }
  normalizeNested(normalized, "hooks", hooksAliases);
  normalizeNested(normalized, "agent", agentAliases);
  normalizeNested(normalized, "codex", codexAliases);
  normalizeNested(normalized, "claude", claudeAliases);
  normalizeNested(normalized, "observability", observabilityAliases);
  normalizeNested(normalized, "server", {});
  normalizeNested(normalized, "logging", loggingAliases);

  if (isPlainRecord(normalized.tracker)) {
    normalizeNested(normalized.tracker, "dispatch", dispatchAliases);
  }
  if (isPlainRecord(normalized.agents)) {
    normalized.agents = Object.fromEntries(
      Object.entries(normalized.agents).map(([name, agent]) => [
        name,
        isPlainRecord(agent) ? normalizeAliases(agent, agentRecordAliases) : agent,
      ]),
    );
  }
  if (isPlainRecord(normalized.statusOverrides)) {
    normalized.statusOverrides = Object.fromEntries(
      Object.entries(normalized.statusOverrides).map(([state, override]) => {
        if (!isPlainRecord(override)) return [state, override];
        const normalizedOverride: Record<string, unknown> = { ...override };
        normalizeNested(normalizedOverride, "agent", agentAliases);
        normalizeNested(normalizedOverride, "codex", codexAliases);
        normalizeNested(normalizedOverride, "claude", claudeAliases);
        return [state, normalizedOverride];
      }),
    );
  }
  return normalized;
}

function normalizeNested(
  raw: Record<string, unknown>,
  key: string,
  aliases: Record<string, string>,
): void {
  if (isPlainRecord(raw[key])) raw[key] = normalizeAliases(raw[key], aliases);
}

function normalizeAliases(
  raw: Record<string, unknown>,
  aliases: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (Object.prototype.hasOwnProperty.call(raw, alias)) {
      out[canonical] = raw[alias];
      delete out[alias];
    }
  }
  return out;
}

function stringValue(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

function trackerKindValue(value: unknown, label: string): TrackerKind {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (isOneOf(value, TRACKER_KINDS)) return value;
  throw new Error(`unsupported ${label}: ${value}`);
}

function approvalPolicyValue(
  value: unknown,
  fallback: CodexSettings["approvalPolicy"],
  label: string,
): CodexSettings["approvalPolicy"] {
  if (value === undefined || value === null) return fallback;
  if (isPlainRecord(value)) return value;
  if (typeof value !== "string") throw new Error(`${label} must be a string or map`);
  if (isOneOf(value, CODEX_APPROVAL_POLICY_NAMES)) return value;
  throw new Error(`unsupported ${label}: ${value}`);
}

function sandboxModeValue(
  value: unknown,
  fallback: CodexSettings["threadSandbox"],
  label: string,
): CodexSettings["threadSandbox"] {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (isOneOf(value, CODEX_SANDBOX_MODES)) return value;
  throw new Error(`unsupported ${label}: ${value}`);
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
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
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
  if (value === undefined || value === null) {
    const fallback = nonEmptyString(env[fallbackEnvName]);
    return resolveOnePasswordRef(fallback, env);
  }
  const resolved = resolveEnv(stringValue(value, ""), env);
  const secret = nonEmptyString(resolved) ?? nonEmptyString(env[fallbackEnvName]);
  return resolveOnePasswordRef(secret, env);
}

function resolveOnePasswordRef(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (value === undefined || !value.startsWith("op://")) return value;
  const mergedEnv = { ...process.env, ...env };
  try {
    execaSync("op", ["--version"], { env: mergedEnv });
  } catch {
    throw new Error(
      "1Password CLI (op) is required to resolve op:// references but was not found. " +
        "Install it from https://developer.1password.com/docs/cli/get-started — it cannot be managed by mise.",
    );
  }
  try {
    const result = execaSync("op", ["read", value], { env: mergedEnv });
    return result.stdout.trim();
  } catch {
    throw new Error(`Failed to resolve 1Password reference: ${value}`);
  }
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
  key: string,
  property: keyof T,
): void {
  const value = raw[key];
  if (value !== undefined) target[property] = positiveInt(value, 1, String(property)) as T[keyof T];
}

function putNonNegative<T extends object>(
  raw: Record<string, unknown>,
  target: T,
  key: string,
  property: keyof T,
): void {
  const value = raw[key];
  if (value !== undefined) target[property] = nonNegativeInt(value, String(property)) as T[keyof T];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<const Values extends readonly string[]>(
  value: string,
  values: Values,
): value is Values[number] {
  return (values as readonly string[]).includes(value);
}
