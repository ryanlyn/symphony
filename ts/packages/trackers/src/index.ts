import { linearTrackerProvider } from "@symphony/linear-tracker";
import { localTrackerProvider } from "@symphony/local-tracker";
import { memoryTrackerProvider } from "@symphony/memory-tracker";
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
