import type { RuntimeDaemonStatus } from "@lorenz/runtime-events";

import { daemonLockIsStale, type DaemonEndpoint, type DaemonLockRecord } from "./daemonLock.js";

export interface DaemonStatusPayload {
  owner_id: string;
  pid: number;
  hostname: string;
  started_at: string;
  workflow_path: string;
  workspace_root: string;
  lock_path: string;
  endpoint: DaemonEndpoint;
  heartbeat_at: string;
  heartbeat_age_ms: number | null;
  stale: boolean;
  leadership_store_kind: string;
}

export function daemonStatusPayload(
  record: DaemonLockRecord,
  now = new Date(),
  staleAfterMs = 60_000,
  leadershipStoreKind = "local-file",
): DaemonStatusPayload {
  const heartbeatMs = Date.parse(record.heartbeatAt);
  const heartbeatAgeMs = Number.isFinite(heartbeatMs)
    ? Math.max(0, now.getTime() - heartbeatMs)
    : null;
  return {
    owner_id: record.ownerId,
    pid: record.pid,
    hostname: record.hostname,
    started_at: record.startedAt,
    workflow_path: record.workflowPath,
    workspace_root: record.workspaceRoot,
    lock_path: record.lockPath,
    endpoint: { ...record.endpoint },
    heartbeat_at: record.heartbeatAt,
    heartbeat_age_ms: heartbeatAgeMs,
    stale: daemonLockIsStale(record, now, staleAfterMs),
    leadership_store_kind: leadershipStoreKind,
  };
}

export function runtimeDaemonStatus(
  record: DaemonLockRecord,
  now = new Date(),
  staleAfterMs = 60_000,
  leadershipStoreKind = "local-file",
): RuntimeDaemonStatus {
  const payload = daemonStatusPayload(record, now, staleAfterMs, leadershipStoreKind);
  return {
    ownerId: payload.owner_id,
    pid: payload.pid,
    hostname: payload.hostname,
    startedAt: payload.started_at,
    workflowPath: payload.workflow_path,
    workspaceRoot: payload.workspace_root,
    lockPath: payload.lock_path,
    endpoint: { ...payload.endpoint },
    heartbeatAt: payload.heartbeat_at,
    heartbeatAgeMs: payload.heartbeat_age_ms,
    stale: payload.stale,
    leadershipStoreKind: payload.leadership_store_kind,
  };
}
