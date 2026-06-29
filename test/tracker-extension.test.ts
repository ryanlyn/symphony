import { test } from "vitest";
import { parseConfig, validateDispatchConfig } from "@lorenz/config";
import type { Issue, RuntimeTrackerClient, Settings } from "@lorenz/domain";
import { AgentExecutorRegistry, type AgentExecutorProvider } from "@lorenz/agent-sdk";
import {
  TrackerRegistry,
  rejectUnknownOptions,
  stringOption,
  type TrackerProvider,
} from "@lorenz/tracker-sdk";
import { assert } from "@lorenz/test-utils";

// Stand-in for the composition root's executor registration; the default agent records
// select the "acp" executor, and this test only needs validation to pass.
const stubExecutorProvider: AgentExecutorProvider = {
  executor: "acp",
  createExecutor: () => {
    throw new Error("not under test");
  },
};

function executorRegistry(): AgentExecutorRegistry {
  const registry = new AgentExecutorRegistry();
  registry.register(stubExecutorProvider);
  return registry;
}

/**
 * Architectural regression test for the extension contract: a brand-new tracker backend
 * is one TrackerProvider implementation plus one registry registration. Everything below
 * uses only the SDK surface - if this test needs core (domain/config/mcp/cli) changes to
 * keep passing for a new backend, the provider boundary has regressed.
 */

const fakeIssue: Issue = {
  id: "notion-1",
  identifier: "NTN-1",
  title: "Wire the flux capacitor",
  state: "To Do",
  stateType: "unstarted",
  labels: [],
  blockers: [],
};

class FakeNotionClient implements RuntimeTrackerClient {
  constructor(readonly baseUrl: string) {}
  async fetchCandidateIssues(): Promise<Issue[]> {
    return [fakeIssue];
  }
  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    return ids.includes(fakeIssue.id) ? [fakeIssue] : [];
  }
}

function fakeNotionProvider(): TrackerProvider {
  return {
    kind: "notion",
    configAliases: { database_id: "databaseId" },
    envFallbacks: { apiKey: "NOTION_API_KEY" },
    defaultEndpoint: "https://api.notion.example",
    parseOptions(options) {
      rejectUnknownOptions(options, ["databaseId"], "notion");
      const databaseId = stringOption(options, "databaseId");
      return databaseId === undefined ? {} : { databaseId };
    },
    validateDispatch(settings) {
      if (!settings.tracker.apiKey) throw new Error("tracker.api_key is required");
      if (!settings.tracker.options.databaseId) throw new Error("tracker.database_id is required");
    },
    createClient(settings) {
      return new FakeNotionClient(settings.tracker.endpoint!);
    },
    projectUrl: (settings) =>
      `https://notion.example/${String(settings.tracker.options.databaseId)}`,
  };
}

function registryWithFakeNotion(): TrackerRegistry {
  const registry = new TrackerRegistry();
  registry.register(fakeNotionProvider());
  return registry;
}

function parseFakeNotion(
  env: NodeJS.ProcessEnv = {},
  registry = registryWithFakeNotion(),
): Settings {
  return parseConfig(
    {
      tracker: {
        kind: "notion",
        database_id: "db-eng",
        active_states: ["To Do"],
      },
    },
    env,
    {},
    registry,
  );
}

test("a new provider's config section parses through its aliases, options, and env fallbacks", () => {
  const settings = parseFakeNotion({ NOTION_API_KEY: "notion-token" });

  assert.equal(settings.tracker.kind, "notion");
  assert.equal(settings.tracker.apiKey, "notion-token");
  assert.equal(settings.tracker.endpoint, "https://api.notion.example");
  assert.deepEqual(settings.tracker.options, { databaseId: "db-eng" });
});

test("a new provider's option typos and dispatch requirements are enforced", () => {
  const registry = registryWithFakeNotion();
  assert.throws(
    () => parseConfig({ tracker: { kind: "notion", database_idd: "db-eng" } }, {}, {}, registry),
    /unsupported tracker option\(s\) for kind "notion": database_idd/,
  );

  const missingKey = parseConfig({ tracker: { kind: "notion" } }, {}, {}, registry);
  assert.throws(
    () => validateDispatchConfig(missingKey, registry, executorRegistry()),
    /tracker.api_key is required/,
  );
});

test("a new provider supplies the runtime client and project URL without core changes", async () => {
  const registry = registryWithFakeNotion();
  const settings = parseFakeNotion({ NOTION_API_KEY: "notion-token" }, registry);
  validateDispatchConfig(settings, registry, executorRegistry());

  const client = registry.require(settings.tracker.kind).createClient(settings, { env: {} });
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((issue) => issue.identifier),
    ["NTN-1"],
  );

  assert.equal(
    registry.providerFor(settings)?.projectUrl?.(settings),
    "https://notion.example/db-eng",
  );
});

test("unknown kinds parse leniently and fail dispatch validation with the known-kind list", () => {
  const registry = registryWithFakeNotion();
  const settings = parseConfig({ tracker: { kind: "github", anything: true } }, {}, {}, registry);
  assert.deepEqual(settings.tracker.options, { anything: true });
  assert.throws(
    () => validateDispatchConfig(settings, registry, executorRegistry()),
    /unsupported tracker.kind: github \(known kinds: notion\)/,
  );
});
