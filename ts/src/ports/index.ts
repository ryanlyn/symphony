import type { RuntimeSnapshot } from "../runtime.js";
import type {
  AgentExecutor,
  Issue,
  RuntimeTrackerClient,
  Settings,
  WorkflowDefinition,
} from "../types.js";

export type TrackerPort = RuntimeTrackerClient;

export type AgentExecutorPort = AgentExecutor;

export interface ClockPort {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface TimerHandle {
  unref?: (() => void) | undefined;
}

export interface WorkspacePort {
  create(settings: Settings, issue: Issue, workerHost?: string | null): Promise<string>;
  remove(settings: Settings, issueIdentifier: string, workerHost?: string | null): Promise<void>;
}

export interface WorkerHostPort {
  acquire(workerHost: string): Promise<WorkerHostLease>;
}

export interface WorkerHostLease {
  workerHost: string;
  release(): Promise<void>;
}

export interface McpPort {
  issueToken(): string;
  revokeToken(token: string | null | undefined): void;
}

export interface LogSinkPort {
  append(event: Record<string, unknown>): Promise<void>;
}

export interface ProjectionSinkPort {
  snapshot(workflow: WorkflowDefinition): RuntimeSnapshot;
}
