import type { BoxDriverFactory } from "./types.js";

/**
 * Lookup table of {@link BoxDriverFactory}s keyed by `worker.box_pool.driver`.
 * The pool resolves the configured kind through a registry instead of
 * hardcoding backends, so the set of supported box drivers is decided by
 * whoever composes the application.
 */
export class BoxDriverRegistry {
  private readonly factories = new Map<string, BoxDriverFactory>();

  /** Register a factory. Throws when a different factory already claims the kind. */
  register(factory: BoxDriverFactory): void {
    const kind = factory.kind.trim();
    if (!kind) throw new Error("box driver kind must not be blank");
    const existing = this.factories.get(kind);
    if (existing && existing !== factory) {
      throw new Error(`box driver already registered for kind: ${kind}`);
    }
    this.factories.set(kind, factory);
  }

  get(kind: string | undefined): BoxDriverFactory | undefined {
    return kind === undefined ? undefined : this.factories.get(kind);
  }

  /** Like {@link get} but throws a config-style error listing the known kinds. */
  require(kind: string | undefined): BoxDriverFactory {
    if (kind === undefined || kind === null || kind === "") {
      throw new Error("worker.box_pool.driver is required");
    }
    const factory = this.factories.get(kind);
    if (!factory) {
      const known = this.kinds();
      const hint =
        known.length > 0
          ? ` (known kinds: ${known.join(", ")})`
          : " (no box drivers registered - register box driver extensions at the composition root)";
      throw new Error(`box_pool_driver_unavailable: ${kind}${hint}`);
    }
    return factory;
  }

  kinds(): string[] {
    return [...this.factories.keys()].sort();
  }
}

/**
 * Process-wide registry used as the default by the pool and the CLI. The
 * composition root (the CLI entrypoint, or a test) registers drivers here;
 * library code only reads from it. Call sites that need isolation can
 * construct their own {@link BoxDriverRegistry} and pass it explicitly.
 */
export const defaultBoxDriverRegistry = new BoxDriverRegistry();
