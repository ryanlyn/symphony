import { jiraMcpTrackerProvider, jiraTrackerProvider } from "@symphony/jira-tracker";
import { linearToolProvider, linearTrackerProvider } from "@symphony/linear-tracker";
import { localToolProvider, localTrackerProvider } from "@symphony/local-tracker";
import { memoryTrackerProvider } from "@symphony/memory-tracker";
import {
  defaultToolRegistry,
  type ToolProvider,
  type ToolRegistry,
} from "@symphony/tool-sdk";
import { createTrackerToolProvider } from "@symphony/tracker-tools";
import {
  defaultTrackerRegistry,
  type TrackerProvider,
  type TrackerRegistry,
} from "@symphony/tracker-sdk";

/** The tracker backends Symphony ships with. */
export const builtinTrackerProviders: readonly TrackerProvider[] = [
  linearTrackerProvider,
  localTrackerProvider,
  memoryTrackerProvider,
  jiraTrackerProvider,
  jiraMcpTrackerProvider,
];

/**
 * Register the built-in tracker providers. Idempotent; called by the composition root
 * (the CLI, sandboxes, tests) before any config is parsed or clients are created.
 */
export function registerBuiltinTrackerProviders(
  registry: TrackerRegistry = defaultTrackerRegistry,
): void {
  for (const provider of builtinTrackerProviders) {
    if (registry.get(provider.kind) === undefined) registry.register(provider);
  }
}

/**
 * Register the built-in tool packs: the provider-neutral `tracker` pack (resolving its
 * operations through `trackers`) plus the provider-specific packs. Idempotent; called by
 * the composition root alongside {@link registerBuiltinTrackerProviders}.
 */
export function registerBuiltinToolProviders(
  registry: ToolRegistry = defaultToolRegistry,
  trackers: TrackerRegistry = defaultTrackerRegistry,
): void {
  const packs: readonly ToolProvider[] = [
    createTrackerToolProvider(trackers),
    linearToolProvider,
    localToolProvider,
  ];
  for (const pack of packs) {
    if (registry.get(pack.name) === undefined) registry.register(pack);
  }
}

/**
 * Register every built-in provider into the given registries. The single call a
 * composition root needs before parsing config or serving tools.
 */
export function registerBuiltinProviders(
  trackers: TrackerRegistry = defaultTrackerRegistry,
  tools: ToolRegistry = defaultToolRegistry,
): void {
  registerBuiltinTrackerProviders(trackers);
  registerBuiltinToolProviders(tools, trackers);
}
