import type { WorkerProviderKind } from "@symphony/domain";

export type { WorkerProviderKind };

/**
 * The backward-compatible execution target the rest of symphony consumes.
 * `workerHost === null` runs locally; a string is an OpenSSH destination
 * (`user@host:port`) the existing workspace/executor/tunnel code understands.
 */
export interface ExecutionTarget {
  workerHost: string | null;
}

/**
 * Opaque handle a provider returns for a leased worker. Only `target` is read
 * outside the pool; the rest is lifecycle/observability metadata.
 */
export interface WorkerHandle {
  readonly id: string;
  readonly providerKind: WorkerProviderKind;
  readonly target: ExecutionTarget;
  /** Provider-native id (sandbox id, vm id); absent for local/ssh. */
  readonly providerRef?: string | undefined;
  readonly createdAt: Date;
  /** Lease time-to-live in ms; absent means no TTL (local/static ssh). */
  readonly ttlMs?: number | undefined;
}

export type LeaseState =
  | "provisioning"
  | "ready"
  | "assigned"
  | "draining"
  | "expired"
  | "unhealthy";

/** A worker tracked by the pool, in use or idle/warm. */
export interface Lease {
  readonly handle: WorkerHandle;
  state: LeaseState;
  lastHealthyAt: Date | null;
  lastAssignedAt: Date | null;
  /** slotKey(issueId, slotIndex) of the run holding this lease, or null when idle. */
  holderKey: string | null;
}

/** Current in-use worker counts, used by providers for synchronous placement. */
export interface ProviderUsage {
  total: number;
  perHost: Map<string, number>;
}

/** Input to a provider's synchronous placement decision on the claim hot path. */
export interface PlacementInput {
  /** Pool-unique id the provider must stamp onto the returned handle. */
  leaseId: string;
  usage: ProviderUsage;
  hint?: string | null | undefined;
}

export interface ReleaseOptions {
  /** Destroy the worker rather than keep it for reuse. */
  recycle: boolean;
}

export interface WorkerPoolSnapshot {
  total: number;
  ready: number;
  assigned: number;
  draining: number;
  byKind: Partial<Record<WorkerProviderKind, { ready: number; assigned: number }>>;
  ttlMs: number | null;
}
