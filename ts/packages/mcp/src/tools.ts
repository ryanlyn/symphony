import type { Settings } from "@symphony/domain";
import {
  defaultTrackerRegistry,
  unsupportedToolFailure,
  type ToolResult,
  type ToolSpec,
  type TrackerProvider,
  type TrackerRegistry,
} from "@symphony/tracker-sdk";

export type { ToolResult, ToolSpec } from "@symphony/tracker-sdk";

function providerFor(settings: Settings, registry: TrackerRegistry): TrackerProvider | undefined {
  return registry.providerFor(settings);
}

/** Tools the configured tracker provider exposes to agent sessions; empty when it has none. */
export function toolSpecs(
  settings: Settings,
  registry: TrackerRegistry = defaultTrackerRegistry,
): ToolSpec[] {
  return providerFor(settings, registry)?.toolSpecs?.(settings) ?? [];
}

export async function executeTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
  registry: TrackerRegistry = defaultTrackerRegistry,
): Promise<ToolResult> {
  const provider = providerFor(settings, registry);
  if (!provider?.executeTool) {
    return unsupportedToolFailure(name, provider?.toolSpecs?.(settings).map((s) => s.name) ?? []);
  }
  return provider.executeTool(name, input, { settings, fetchImpl });
}
