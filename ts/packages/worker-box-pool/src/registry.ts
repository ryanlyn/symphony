import type { BoxPoolProvider, BoxPoolSettings } from "@symphony/domain";

import type { BoxProvider, BoxProviderFactory, ProviderDeps } from "./types.js";

/**
 * Module-level registry mapping a provider `kind` to its factory. Built-in
 * providers (fake / static-ssh) self-register at import time in later tasks;
 * cloud providers register from their own packages. The map is process-global so
 * a single registration is shared across every pool instance in the daemon.
 */
const registry = new Map<BoxPoolProvider, BoxProviderFactory>();

/**
 * Registers a factory for a provider `kind`. A later registration for the same
 * `kind` overrides the prior one (last write wins), which keeps test setup and
 * provider re-registration simple.
 */
export function registerBoxProvider(kind: BoxPoolProvider, factory: BoxProviderFactory): void {
  registry.set(kind, factory);
}

/**
 * Resolves a provider by `kind`, invoking its registered factory with the pool
 * settings and provider deps. Throws `box_pool_provider_unavailable: <kind>` when
 * nothing is registered for the kind so the daemon can fail loud at startup
 * rather than silently disabling the pool.
 */
export function resolveProvider(
  kind: BoxPoolProvider,
  settings: BoxPoolSettings,
  deps: ProviderDeps,
): BoxProvider {
  const factory = registry.get(kind);
  if (!factory) {
    throw new Error(`box_pool_provider_unavailable: ${kind}`);
  }
  return factory(settings, deps);
}

/**
 * Clears every registration. Intended for test isolation so one test's stub
 * factory does not leak into the next; production code never calls this.
 */
export function clearBoxProviderRegistry(): void {
  registry.clear();
}
