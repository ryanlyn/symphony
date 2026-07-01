import { issueHasOpenBlockers, issueIsActive, routedToThisWorker, slotKey } from "@lorenz/dispatch";
import { settingsForIssueState } from "@lorenz/config";
import { isTerminalState } from "@lorenz/issue";
import type { Orchestrator } from "@lorenz/orchestrator";
import { reconciliationStopReason } from "@lorenz/policies/reconciliation";
import {
  durationMs,
  errorMessage,
  type ClockPort,
  type Issue,
  type RunningEntry,
  type RuntimeTrackerClient,
  type WorkflowDefinition,
} from "@lorenz/domain";
import type { RuntimeEventType, RuntimeRunHistoryEntry } from "@lorenz/runtime-events";

import { buildRunHistoryEntry } from "./history.js";
import type { RuntimeWorkspaceRemover } from "./cleanup.js";

interface RuntimeReconciliationHandle {
  readonly runId: string;
  finishExternally(
    reason?: "stalled" | null,
    options?: { abandonClaimOnSettlement?: boolean | undefined },
  ): void;
}

export interface RuntimeReconcilerOptions {
  workflow(): WorkflowDefinition;
  client(): RuntimeTrackerClient;
  orchestrator: Orchestrator;
  clock: ClockPort;
  activeRuns: Map<string, RuntimeReconciliationHandle>;
  addEvent(type: RuntimeEventType, message: string): void;
  abortIssueRuns(issueId: string): void;
  clearRetryTimer(issueId: string): void;
  syncRetryTimerSafely(issueId: string): string | null;
  removeIssueWorkspaces: RuntimeWorkspaceRemover;
  recordHistory(entry: RuntimeRunHistoryEntry): void;
  recordClaimStoreFailure(reason: string, error: unknown): void;
}

export class RuntimeReconciler {
  constructor(private readonly options: RuntimeReconcilerOptions) {}

  async reconcileTrackedIssues(): Promise<void> {
    const workflow = this.options.workflow();
    const snapshot = await this.options.orchestrator.snapshotAsync();
    const tracked = new Map<
      string,
      {
        identifier: string;
        workerHost?: string | null | undefined;
        workspacePath?: string | null | undefined;
      }
    >();
    for (const entry of snapshot.reserving) {
      if (!(await this.options.orchestrator.ownsClaimAsync(entry.issueId, entry.slotIndex)))
        continue;
      tracked.set(entry.issueId, {
        identifier: entry.identifier,
        workerHost: null,
        workspacePath: null,
      });
    }
    for (const entry of snapshot.running) {
      if (!(await this.options.orchestrator.ownsClaimAsync(entry.issue.id, entry.slotIndex)))
        continue;
      tracked.set(entry.issue.id, {
        identifier: entry.issue.identifier,
        workerHost: entry.workerHost,
        workspacePath: entry.workspacePath,
      });
    }
    for (const entry of snapshot.retrying) {
      if (tracked.has(entry.issueId)) continue;
      tracked.set(entry.issueId, {
        identifier: entry.identifier,
        workerHost: entry.workerHost,
        workspacePath: entry.workspacePath,
      });
    }
    if (tracked.size === 0) return;

    let refreshed: Issue[];
    try {
      refreshed = await this.options.client().fetchIssuesByIds([...tracked.keys()]);
    } catch (error) {
      this.options.addEvent("reconcile_refresh_failed", errorMessage(error));
      return;
    }
    const refreshedIds = new Set(refreshed.map((issue) => issue.id));
    for (const issue of refreshed) {
      const meta = tracked.get(issue.id);
      const active = issueIsActive(issue, workflow.settings);
      const routed = routedToThisWorker(issue, workflow.settings);
      if (active && routed && !issueHasOpenBlockers(issue, workflow.settings)) {
        await this.options.orchestrator.refreshRunningIssueAsync(issue);
        continue;
      }
      try {
        await this.options.orchestrator.cleanupIssueAsync(issue.id);
      } catch (error) {
        this.options.recordClaimStoreFailure("claim_cleanup_failed", error);
        continue;
      }
      this.options.abortIssueRuns(issue.id);
      this.options.clearRetryTimer(issue.id);
      const reason = reconciliationStopReason(issue, workflow.settings);
      if (isTerminalState(issue.state, workflow.settings.tracker.terminalStates)) {
        await this.options.removeIssueWorkspaces({
          settings: workflow.settings,
          issueIdentifier: issue.identifier || meta?.identifier,
          workerHost: meta?.workerHost,
          issue,
        });
        this.options.addEvent("workspace_cleanup", `${issue.identifier} ${reason}`);
      } else {
        this.options.addEvent("run_reconciled", `${issue.identifier} ${reason}`);
      }
    }
    for (const [issueId, meta] of tracked.entries()) {
      if (refreshedIds.has(issueId)) continue;
      try {
        await this.options.orchestrator.cleanupIssueAsync(issueId);
      } catch (error) {
        this.options.recordClaimStoreFailure("claim_cleanup_failed", error);
        continue;
      }
      this.options.abortIssueRuns(issueId);
      this.options.clearRetryTimer(issueId);
      this.options.addEvent("run_reconciled", `${meta.identifier} missing`);
    }
  }

  async reconcileStalledRuns(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    const runningSnapshot = (await this.options.orchestrator.snapshotAsync()).running;
    for (const snapshotEntry of runningSnapshot) {
      if (
        !(await this.options.orchestrator.ownsClaimAsync(
          snapshotEntry.issue.id,
          snapshotEntry.slotIndex,
        ))
      )
        continue;
      const currentEntry = snapshotEntry;
      const workflow = this.options.workflow();
      const effective = settingsForIssueState(workflow.settings, currentEntry.issue.state);
      const agent = effective.agents[currentEntry.agentKind];
      if (!agent) throw new Error(`agents.${currentEntry.agentKind} is required`);
      const timeoutMs = agent.stallTimeoutMs;
      if (timeoutMs <= 0) continue;
      const lastActivity = currentEntry.lastAgentTimestamp ?? currentEntry.startedAt;
      const elapsedMs = this.options.clock.now().getTime() - lastActivity.getTime();
      if (elapsedMs <= timeoutMs) continue;

      const key = slotKey(currentEntry.issue.id, currentEntry.slotIndex);
      const activeHandle = this.options.activeRuns.get(key);
      const runId =
        activeHandle?.runId ?? `stalled-${currentEntry.issue.id}-${currentEntry.slotIndex}`;
      const error = `agent_stalled after ${timeoutMs}ms`;
      const entry = await this.runningEntry(snapshotEntry.issue.id, snapshotEntry.slotIndex);
      if (!entry) continue;
      let finished: RunningEntry | null;
      try {
        finished = await this.options.orchestrator.finishAsync(
          entry.issue.id,
          entry.slotIndex,
          true,
          error,
          "failure",
        );
      } catch (finishError) {
        this.options.recordClaimStoreFailure("claim_finish_failed", finishError);
        continue;
      }
      if (!finished) {
        activeHandle?.finishExternally();
        this.options.addEvent("dispatch_skipped", `${entry.identifier} claim_lost_before_finish`);
        continue;
      }
      activeHandle?.finishExternally("stalled");
      const endedAt = this.options.clock.now().toISOString();
      this.options.recordHistory(
        buildRunHistoryEntry({
          id: runId,
          issue: entry.issue,
          issueIdentifier: entry.identifier,
          slotIndex: entry.slotIndex,
          agentKind: entry.agentKind,
          outcome: "stalled",
          turnCount: entry.turnCount,
          runningEntry: entry,
          startedAt: entry.startedAt.toISOString(),
          endedAt,
          durationMs: durationMs(entry.startedAt.toISOString(), endedAt),
          error,
          fallbackLastEvent: "agent_stalled",
        }),
      );
      const retrySyncError = this.options.syncRetryTimerSafely(entry.issue.id);
      this.options.addEvent("run_stalled", `${entry.identifier} ${error}`);
      if (retrySyncError) this.options.addEvent("poll_error", retrySyncError);
    }
  }

  private async runningEntry(
    issueId: string,
    slotIndex: number,
  ): Promise<RunningEntry | undefined> {
    return (await this.options.orchestrator.snapshotAsync()).running.find(
      (entry) => entry.issue.id === issueId && entry.slotIndex === slotIndex,
    );
  }
}
