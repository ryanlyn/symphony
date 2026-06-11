import { assert } from "@symphony/test-utils";
import { afterEach, beforeEach, test } from "vitest";
import { PROVIDER_KINDS, type BoxPoolSettings } from "@symphony/domain";
import { systemClock } from "@symphony/domain";

// Importing the public barrel is what self-registers EVERY built-in provider
// (fake + static-ssh + the four cloud kinds); everything else under test is
// pulled from the same barrel so this file exercises the package exactly as a
// downstream consumer would.
import {
  clearBoxProviderRegistry,
  createBoxPool,
  DockerBoxProvider,
  E2BBoxProvider,
  type E2BSandboxClient,
  FakeBoxProvider,
  FlyBoxProvider,
  ModalBoxProvider,
  type ModalTransport,
  registerBoxProvider,
  registerBuiltInBoxProviders,
  resolveProvider,
  StaticSshBoxProvider,
} from "../src/index.js";

// A full settings object so `createBoxPool` has every knob it reads; only
// `enabled`/`provider` matter for these wiring tests but the type wants the rest.
function poolSettings(overrides: Partial<BoxPoolSettings> = {}): BoxPoolSettings {
  return {
    enabled: true,
    provider: "fake",
    min: 0,
    max: 1,
    warm: 0,
    maxInFlight: 1,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 1_000,
    reapIntervalMs: 15_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
    ...overrides,
  };
}

// The minimal `providerOptions` each kind needs to CONSTRUCT (not run): the
// constructible kinds validate their config eagerly, so a missing required
// option would throw a config error rather than exercise the registry wiring.
function providerOptionsFor(kind: string): Record<string, unknown> {
  switch (kind) {
    case "static-ssh":
      return { ssh_hosts: ["alice@host-1"] };
    case "docker":
      return { image: "ghcr.io/org/box:latest" };
    case "fly":
      return { app: "symphony-pool", image: "registry.fly.io/box:latest", api_token: "test-token" };
    default:
      return {};
  }
}

const deps = {
  clock: systemClock,
  logEvent: () => undefined,
};

// Other test files in this package clear the shared module-level registry, so a
// previous run can leave it empty. Start each test from a known-empty registry
// and let `registerBuiltInBoxProviders` re-apply the barrel's load-time wiring,
// so we exercise the exact registration the barrel performs on import.
beforeEach(() => {
  clearBoxProviderRegistry();
  registerBuiltInBoxProviders();
});

afterEach(() => {
  clearBoxProviderRegistry();
});

test("createBoxPool resolves a working pool for the self-registered fake provider", () => {
  const pool = createBoxPool(poolSettings(), deps);

  // A live pool exposes the public surface and can accept work immediately.
  assert.ok(typeof pool.acquire === "function");
  assert.equal(pool.canAcquire(), true);

  const snapshot = pool.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.provider, "fake");
});

test("the barrel re-exports the public registry helpers and FakeBoxProvider", () => {
  // Re-registering through the barrel-exported helper yields a FakeBoxProvider
  // (also exported from the barrel) when resolved by kind.
  registerBoxProvider("fake", (_settings, providerDeps) => new FakeBoxProvider(providerDeps));
  const provider = resolveProvider("fake", poolSettings(), deps);

  assert.ok(provider instanceof FakeBoxProvider);
  assert.equal(provider.kind, "fake");
});

test("importing the barrel self-registers a factory for every PROVIDER_KIND", () => {
  // After barrel-wiring, EVERY built-in kind must resolve a factory: the only
  // way `resolveProvider` rejects with a REGISTRY MISS is when nothing is
  // registered, which must NOT happen for any of the six kinds. (Cloud kinds
  // e2b/modal still fail loud at construction for a missing injected
  // client/transport, but that is a factory-side `... requires an injected ...`
  // error, NOT the bare registry-miss `box_pool_provider_unavailable: <kind>`.)
  for (const kind of PROVIDER_KINDS) {
    let registryMiss = false;
    try {
      resolveProvider(
        kind,
        poolSettings({ provider: kind, providerOptions: providerOptionsFor(kind) }),
        deps,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The registry miss is the bare form ending right after the kind; the
      // cloud factories' "requires an injected ..." failure is NOT a miss.
      registryMiss = new RegExp(`box_pool_provider_unavailable: ${kind}$`).test(message);
    }
    assert.equal(registryMiss, false);
  }
});

test("createBoxPool throws box_pool_provider_unavailable at construction for e2b with no injected client", () => {
  // The stock daemon cannot construct e2b: it needs an injected SDK client this
  // package does not depend on. Enabling it without registering a custom factory
  // must fail LOUD at construction (consistent with the resolveProvider
  // fail-loud contract) - never construct-then-throw only at first provision (a
  // footgun).
  assert.throws(
    () => createBoxPool(poolSettings({ provider: "e2b", providerOptions: {} }), deps),
    /box_pool_provider_unavailable: e2b requires an injected client/,
  );
});

test("createBoxPool throws box_pool_provider_unavailable at construction for modal with no injected transport", () => {
  // The stock daemon cannot construct modal: it needs an injected transport this
  // package does not depend on. Same fail-loud-at-construction contract as e2b.
  assert.throws(
    () => createBoxPool(poolSettings({ provider: "modal", providerOptions: {} }), deps),
    /box_pool_provider_unavailable: modal requires an injected transport/,
  );
});

test("registering a custom e2b factory with a fake client makes createBoxPool construct", () => {
  // Extensibility preserved: a deployment registers a client-injecting factory
  // (here with a fake) BEFORE enabling the kind, and the pool then constructs
  // cleanly with no `box_pool_provider_unavailable`.
  const client: E2BSandboxClient = {
    create: async () => ({
      sandboxId: "sbx-1",
      getSshEndpoint: () => ({ host: "host", port: 22, user: "root" }),
    }),
    kill: async () => undefined,
    list: async () => [],
  };
  registerBoxProvider(
    "e2b",
    (settings, providerDeps) => new E2BBoxProvider(settings, providerDeps, { client }),
  );

  const pool = createBoxPool(poolSettings({ provider: "e2b", providerOptions: {} }), deps);
  const snapshot = pool.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.provider, "e2b");
});

test("registering a custom modal factory with a fake transport makes createBoxPool construct", () => {
  // Extensibility preserved: a deployment registers a transport-injecting
  // factory (here with a fake) BEFORE enabling the kind, and the pool then
  // constructs cleanly with no `box_pool_provider_unavailable`.
  const transport: ModalTransport = {
    create: async () => ({ sandboxId: "sb-0", sshHost: "modal@sb-0.modal.host:2200", labels: [] }),
    terminate: async () => undefined,
    list: async () => [],
  };
  registerBoxProvider(
    "modal",
    (settings, providerDeps) => new ModalBoxProvider(settings, providerDeps, { transport }),
  );

  const pool = createBoxPool(poolSettings({ provider: "modal", providerOptions: {} }), deps);
  const snapshot = pool.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.provider, "modal");
});

test("the barrel resolves the concrete provider class for each constructible kind", () => {
  // static-ssh, docker, and fly construct with no injected transport (they
  // default to the real ssh/docker/fetch transports), so the barrel factory
  // yields the concrete class when handed valid providerOptions.
  const staticSsh = resolveProvider(
    "static-ssh",
    poolSettings({ provider: "static-ssh", providerOptions: providerOptionsFor("static-ssh") }),
    deps,
  );
  assert.ok(staticSsh instanceof StaticSshBoxProvider);
  assert.equal(staticSsh.kind, "static-ssh");

  const docker = resolveProvider(
    "docker",
    poolSettings({ provider: "docker", providerOptions: providerOptionsFor("docker") }),
    deps,
  );
  assert.ok(docker instanceof DockerBoxProvider);
  assert.equal(docker.kind, "docker");

  const fly = resolveProvider(
    "fly",
    poolSettings({ provider: "fly", providerOptions: providerOptionsFor("fly") }),
    deps,
  );
  assert.ok(fly instanceof FlyBoxProvider);
  assert.equal(fly.kind, "fly");
});

test("createBoxPool builds a live pool for the self-registered static-ssh provider", () => {
  // static-ssh is now wired into the barrel, so an enabled pool for it
  // constructs (no `box_pool_provider_unavailable`).
  const pool = createBoxPool(
    poolSettings({ provider: "static-ssh", providerOptions: providerOptionsFor("static-ssh") }),
    deps,
  );

  const snapshot = pool.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.provider, "static-ssh");
});

test("the barrel re-exports every concrete provider class as a value", () => {
  // Downstream consumers (e.g. the daemon's transport-injecting wiring) import
  // the concrete classes from the barrel, so each must be a re-exported value.
  assert.equal(typeof FakeBoxProvider, "function");
  assert.equal(typeof StaticSshBoxProvider, "function");
  assert.equal(typeof DockerBoxProvider, "function");
  assert.equal(typeof FlyBoxProvider, "function");
  assert.equal(typeof E2BBoxProvider, "function");
  assert.equal(typeof ModalBoxProvider, "function");
});

test("createBoxPool throws box_pool_provider_unavailable when the registry is empty for a kind", () => {
  // Clearing the registry without re-registering leaves the kind unresolvable;
  // an enabled pool must fail loud at construction (daemon fails fast).
  clearBoxProviderRegistry();
  assert.throws(
    () => createBoxPool(poolSettings({ enabled: true, provider: "static-ssh" }), deps),
    /box_pool_provider_unavailable: static-ssh/,
  );
});
