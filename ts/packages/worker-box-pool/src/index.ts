// Public barrel for @symphony/worker-box-pool.
//
// Re-exports the public API (shared types, the async mutex, the provider
// registry, every built-in provider, and the `createBoxPool` factory) and
// registers each built-in provider at module load so a downstream consumer that
// only imports this barrel can construct a pool for any built-in `kind` without
// any extra wiring. Importing each provider module here is the spec's "imports
// each provider module so they self-register" contract.
//
// Cloud providers (e2b, modal) need an injected transport (an SDK client / CLI
// shim) that this package deliberately does NOT depend on. The stock daemon
// supplies no such client/transport, so e2b/modal are NOT daemon-constructible:
// their built-in factory fails LOUD at construction with an actionable
// `box_pool_provider_unavailable` error (consistent with `resolveProvider`'s
// fail-loud contract) rather than constructing a provider that only throws at
// first provision. A real deployment makes the kind constructible by registering
// a custom factory (via `registerBoxProvider`) that injects a real
// client/transport BEFORE enabling it (last write wins over the built-in).

import { DockerBoxProvider } from "./providers/docker.js";
import { E2BBoxProvider } from "./providers/e2b.js";
import { FakeBoxProvider } from "./providers/fake.js";
import { FlyBoxProvider } from "./providers/fly.js";
import { ModalBoxProvider } from "./providers/modal.js";
import { StaticSshBoxProvider } from "./providers/static-ssh.js";
import { registerBoxProvider } from "./registry.js";

export type {
  BoxOutcome,
  TeardownReason,
  BoxHealth,
  ProviderCapabilities,
  BoxDescriptor,
  ProvisionRequest,
  BoxProvider,
  ProviderDeps,
  BoxProviderFactory,
  WarmupStrategy,
  BoxState,
  BoxRecord,
  LedgerRow,
  BoxLease,
  AcquireRequest,
  AcquireResult,
  BoxPoolSnapshot,
  BoxPool,
  Mutex,
} from "./types.js";

export { createMutex } from "./mutex.js";

export { registerBoxProvider, resolveProvider, clearBoxProviderRegistry } from "./registry.js";

export { FakeBoxProvider } from "./providers/fake.js";

export { StaticSshBoxProvider, type StaticSshProviderOverrides } from "./providers/static-ssh.js";

export {
  DockerBoxProvider,
  type DockerCommandResult,
  type DockerProviderOverrides,
  type RunDocker,
} from "./providers/docker.js";

export {
  FlyBoxProvider,
  type FlyFetch,
  type FlyFetchInit,
  type FlyFetchResponse,
  type FlyProviderOverrides,
} from "./providers/fly.js";

export {
  E2BBoxProvider,
  E2B_BOX_POOL_LABEL,
  type E2BProviderOverrides,
  type E2BSandboxClient,
  type E2BSandboxHandle,
  type E2BSandboxInfo,
  type E2BSshEndpoint,
} from "./providers/e2b.js";

export {
  ModalBoxProvider,
  type ModalCreateRequest,
  type ModalProviderOverrides,
  type ModalSandbox,
  type ModalTransport,
} from "./providers/modal.js";

export { createBoxPool, POOL_OWNED_LABEL, type CreateBoxPoolDeps } from "./pool.js";

/**
 * Registers every built-in provider against the module-level registry. Idempotent
 * (last write wins per `kind`), so calling it again after a `clearBoxProviderRegistry`
 * re-applies the same wiring. Invoked once at barrel load so each built-in `kind`
 * is resolvable on import; exported so tests (which clear the shared registry for
 * isolation) can re-establish the built-ins deterministically.
 *
 * `static-ssh`, `docker`, and `fly` default to the real ssh/docker/`fetch`
 * transports (subprocess / `fetch`), so their factory constructs the concrete
 * provider directly and is daemon-constructible. `e2b` and `modal` require an
 * injected client/transport this package does not depend on; their built-in
 * factory therefore fails LOUD at construction (an actionable
 * `box_pool_provider_unavailable: <kind> requires an injected <client|transport>`
 * error) UNLESS one was threaded through `deps` (`e2bClient` / `modalTransport`).
 * A deployment makes these kinds constructible by registering a custom factory
 * that injects a real client/transport (it overrides this built-in, last write
 * wins).
 */
export function registerBuiltInBoxProviders(): void {
  registerBoxProvider("fake", (_settings, deps) => new FakeBoxProvider(deps));
  registerBoxProvider("static-ssh", (settings, deps) => new StaticSshBoxProvider(settings, deps));
  registerBoxProvider("docker", (settings, deps) => new DockerBoxProvider(settings, deps));
  registerBoxProvider("fly", (settings, deps) => new FlyBoxProvider(settings, deps));
  registerBoxProvider("e2b", (settings, deps) => {
    // The E2B SDK client is an injected dependency this package does not provide.
    // Without it the stock daemon cannot construct an `e2b` pool, so fail loud at
    // construction with an actionable error (rather than building a provider that
    // only throws `e2b_provision_failed`/`e2b_client_unavailable` at first
    // provision). A deployment registers a custom factory that injects a real
    // client before enabling the kind.
    if (!deps.e2bClient) {
      throw new Error(
        "box_pool_provider_unavailable: e2b requires an injected client; register a custom 'e2b' factory via registerBoxProvider(...) before enabling it",
      );
    }
    return new E2BBoxProvider(settings, deps, { client: deps.e2bClient });
  });
  registerBoxProvider("modal", (settings, deps) => {
    // The Modal transport is an injected dependency this package does not
    // provide. Without it the stock daemon cannot construct a `modal` pool, so
    // fail loud at construction with an actionable error (rather than building a
    // provider that only throws at first provision). A deployment registers a
    // custom factory that injects a real transport before enabling the kind.
    if (!deps.modalTransport) {
      throw new Error(
        "box_pool_provider_unavailable: modal requires an injected transport; register a custom 'modal' factory via registerBoxProvider(...) before enabling it",
      );
    }
    return new ModalBoxProvider(settings, deps, { transport: deps.modalTransport });
  });
}

// Self-register the built-ins at module load (the spec's "imports each provider
// module so they self-register" contract).
registerBuiltInBoxProviders();
