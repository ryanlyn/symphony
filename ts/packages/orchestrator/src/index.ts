import {
  dispatchBlockReason,
  firstUnclaimedSlot,
  issueIsActive,
  shouldDispatchIssue,
  slotKey,
  sortForDispatch,
} from "@symphony/dispatch";
import { ensembleSize } from "@symphony/issue";
import { settingsForIssueState } from "@symphony/config";
import { retryBackoffMs } from "@symphony/policies/retry";
import { mergeMonotonicUsage } from "@symphony/policies/usage";
import { selectLeastLoadedHost } from "@symphony/policies/workerHost";
import type {
  AgentUpdate,
  DispatchBlockEntry,
  Issue,
  RetryEntry,
  RunningEntry,
  Settings,
  UsageTotals,
} from "@symphony/domain";
import { systemClock, type ClockPort } from "@symphony/ports";

import { type SlotState, type SlotEvent, transitionSlot, applyUpdateToEntry, isTerminalOrEmptyPhase } from "./slot-state.js";

export type FinishOutcome =
  | { type: "retry"; kind: "failure" | "continuation"; error?: string }
  | { type: "done" };

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  usageTotals: UsageTotals;
  rateLimits: unknown;
  blockedDispatches: DispatchBlockEntry[];
}

export function createState(): OrchestratorState {
  return {
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
    blockedDispatches: [],
  };
}

export class Orchestrator {
  /**
   * @internal Use snapshot() for external reads. Direct access bypasses the
   * slot FSM and will break the dual-write invariant.
   * Tests that need internal state can use `(orchestrator as any).state`.
   */
  private readonly _state: OrchestratorState;

  /**
   * @internal Exposed for test assertions only. Returns the internal state
   * object directly. Production code should use snapshot().
   */
  get state(): OrchestratorState {
    return this._state;
  }

  /**
   * Slot FSM state -- authoritative source of truth for slot lifecycle phase.
   * Legacy collections are dual-written until the migration completes.
   * New phases/events must update BOTH the FSM and legacy writes.
   * Tracking: https://github.com/ryanlyn/symphony/issues/fsm-migration-remove-dual-write
   */
  private readonly slots = new Map<string, SlotState>();

  constructor(
    public settings: Settings,
    private readonly clock: ClockPort = systemClock,
    state: OrchestratorState = createState(),
  ) {
    this._state = state;
  }

  private getSlotState(key: string): SlotState {
    return this.slots.get(key) ?? { phase: "idle" };
  }

  private setSlotState(key: string, slotState: SlotState): void {
    if (isTerminalOrEmptyPhase(slotState)) {
      this.slots.delete(key);
    } else {
      this.slots.set(key, slotState);
    }
  }

  /** Apply a slot FSM transition: reads current state, transitions, and stores result. */
  private applySlotTransition(key: string, event: SlotEvent): SlotState {
    const current = this.getSlotState(key);
    const next = transitionSlot(current, event);
    this.setSlotState(key, next);
    return next;
  }

  /** Returns slot keys for a given issue that match one of the specified phases. */
  private slotKeysForIssue(issueId: string, phases?: ReadonlySet<SlotState["phase"]>): string[] {
    return [...this.slots.entries()]
      .filter(([key, s]) => issueIdFromSlotKey(key) === issueId && (!phases || phases.has(s.phase)))
      .map(([key]) => key);
  }

  eligibleIssues(issues: Issue[]): Issue[] {
    this.cleanupRetryAttempts(issues);
    this._state.blockedDispatches = [];
    const runningByState = new Map<string, number>();
    for (const entry of this._state.running.values()) {
      runningByState.set(entry.issue.state, (runningByState.get(entry.issue.state) ?? 0) + 1);
    }

    return sortForDispatch(issues).filter((issue) => {
      const retry = this._state.retryAttempts.get(issue.id);
      if (retry && retry.dueAt.getTime() > this.clock.now().getTime()) return false;
      if (retry) this.releaseStaleClaimsForRetry(issue.id);
      const dispatchState = {
        runningCount: this._state.running.size,
        runningByState,
        claimedSlots: this._state.claimed,
        workerCapacityAvailable: this.workerCapacityAvailable(),
      };
      const reason = dispatchBlockReason(issue, this.settings, dispatchState);
      if (reason) {
        this._state.blockedDispatches.push({
          issueId: issue.id,
          identifier: issue.identifier,
          state: issue.state,
          reason,
          workerHost: null,
        });
        return false;
      }
      return shouldDispatchIssue(issue, this.settings, dispatchState);
    });
  }

  claim(issue: Issue): RunningEntry | null {
    const retry = this._state.retryAttempts.get(issue.id);
    if (retry && retry.dueAt.getTime() <= this.clock.now().getTime())
      this.releaseStaleClaimsForRetry(issue.id);
    const runningByState = new Map<string, number>();
    for (const entry of this._state.running.values()) {
      runningByState.set(entry.issue.state, (runningByState.get(entry.issue.state) ?? 0) + 1);
    }
    if (
      !shouldDispatchIssue(issue, this.settings, {
        runningCount: this._state.running.size,
        runningByState,
        claimedSlots: this._state.claimed,
        workerCapacityAvailable: this.workerCapacityAvailable(),
      })
    ) {
      return null;
    }
    const slotIndex = firstUnclaimedSlot(
      issue,
      this.settings,
      this._state.claimed,
      retry?.slotIndex,
    );
    if (slotIndex === null) return null;
    const workerHost = this.selectWorkerHost();
    if (workerHost === undefined) return null;

    const effective = settingsForIssueState(this.settings, issue.state);
    const size = ensembleSize(issue) ?? this.settings.agent.ensembleSize;
    const key = slotKey(issue.id, slotIndex);
    const entry: RunningEntry = {
      issue,
      identifier: issue.identifier,
      slotIndex,
      ensembleSize: size,
      agentKind: effective.agent.kind,
      workerHost,
      workspacePath: null,
      sessionId: null,
      resumeId: null,
      executorPid: null,
      turnCount: 0,
      startedAt: this.clock.now(),
      lastAgentEvent: null,
      lastAgentTimestamp: null,
      usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      retryAttempt: retry?.attempt ?? null,
    };

    // Transition slot state machine.
    // Note: The FSM and legacy map share the same entry reference initially, but they
    // diverge after applyUpdate (which replaces the legacy entry with a usage-updated
    // copy). This is intentional -- the FSM entry does not track usage during migration.
    this.applySlotTransition(key, { type: "CLAIM", entry });

    // Maintain legacy data structures
    this._state.claimed.add(key);
    this._state.running.set(key, entry);
    this._state.retryAttempts.delete(issue.id);

    // Return a shallow copy so callers cannot mutate orchestrator-internal state.
    // The FSM's UPDATE event is the only sanctioned path for entry mutations.
    return { ...entry };
  }

  private selectWorkerHost(): string | null | undefined {
    const counts = new Map<string, number>();
    for (const entry of this._state.running.values()) {
      if (entry.workerHost) counts.set(entry.workerHost, (counts.get(entry.workerHost) ?? 0) + 1);
    }
    return selectLeastLoadedHost({
      hosts: this.settings.worker.sshHosts,
      runningCounts: counts,
      cap:
        this.settings.worker.maxConcurrentAgentsPerHost ?? this.settings.agent.maxConcurrentAgents,
    });
  }

  private workerCapacityAvailable(): boolean {
    if (this.settings.worker.sshHosts.length === 0) return true;
    return this.selectWorkerHost() !== undefined;
  }

  refreshRunningIssue(issue: Issue): void {
    for (const [key, entry] of this._state.running.entries()) {
      if (entry.issue.id === issue.id) {
        // Dual-write: mutate the legacy map entry in place (preserving existing behavior
        // for consumers still reading state.running), while the FSM produces a fresh
        // immutable entry (for correctness when migration completes).
        entry.issue = issue;
        this.applySlotTransition(key, { type: "REFRESH_ISSUE", issue });
      }
    }
  }

  applyUpdate(issueId: string, slotIndex: number, update: AgentUpdate): void {
    const key = slotKey(issueId, slotIndex);

    // Read from slot FSM as the guard -- only process updates for running slots
    const slotState = this.getSlotState(key);
    if (slotState.phase !== "running") return;

    // Capture timestamp once so both FSM and legacy paths use the same value
    const now = this.clock.now();

    // Transition slot state -- returns a new state with an updated entry copy.
    // TODO(fsm-migration): The FSM entry does not currently receive usage deltas because
    // applyUsageDelta has side effects on global totals (this._state.usageTotals). Once the
    // legacy collections are removed, usage delta logic should be moved into the FSM
    // transition or applied to the FSM entry exclusively.
    this.applySlotTransition(key, { type: "UPDATE", update, now });

    // Dual-write: update the legacy running map entry using the shared applyUpdateToEntry logic.
    // We replace the entry in the map with a fresh copy (same approach as the FSM), then
    // apply usage deltas to the new entry which remains in the map by reference.
    const legacyEntry = this._state.running.get(key);
    if (legacyEntry) {
      const updated = applyUpdateToEntry(legacyEntry, update, now);
      // Apply usage delta onto the new entry before storing, so the map holds the final state
      if (update.usage) this.applyUsageDelta(updated, update.usage);
      this._state.running.set(key, updated);
    }

    // Handle orchestrator-level side effects not managed by slot state
    if (update.rateLimits !== undefined) this._state.rateLimits = update.rateLimits;
  }

  finish(
    issueId: string,
    slotIndex: number,
    outcome: FinishOutcome,
  ): void {
    const key = slotKey(issueId, slotIndex);
    const entry = this._state.running.get(key);
    if (!entry) return;

    // Accumulate runtime before clearing
    this._state.usageTotals.secondsRunning += Math.max(
      0,
      (this.clock.now().getTime() - entry.startedAt.getTime()) / 1000,
    );

    if (outcome.type === "retry") {
      const retryKind = outcome.kind;
      const error = outcome.error;
      const attempt = retryKind === "continuation" ? 1 : (entry.retryAttempt ?? 0) + 1;
      const retryEntry: RetryEntry = {
        issueId,
        identifier: entry.identifier,
        attempt,
        dueAt: this.dueAt(
          retryBackoffMs(attempt, this.settings.agent.maxRetryBackoffMs, retryKind),
        ),
        slotIndex,
        workerHost: entry.workerHost,
        workspacePath: entry.workspacePath,
        error,
      };

      // Transition slot state machine: running -> retrying
      this.applySlotTransition(key, { type: "FINISH_WITH_RETRY", retryEntry });

      // Maintain legacy data structures
      this._state.completed.add(issueId);
      this._state.retryAttempts.set(issueId, retryEntry);
    } else {
      // Transition slot state machine: running -> idle
      this.applySlotTransition(key, { type: "FINISH_NO_RETRY" });
    }

    // Clear from legacy running/claimed
    this._state.running.delete(key);
    this._state.claimed.delete(key);
  }

  cleanupIssue(issueId: string): void {
    // Collect keys first to avoid iterating while mutating
    const runningKeys = [...this._state.running.entries()]
      .filter(([, entry]) => entry.issue.id === issueId)
      .map(([key]) => key);
    for (const key of runningKeys) {
      this.applySlotTransition(key, { type: "CLEANUP" });
      this._state.running.delete(key);
      this._state.claimed.delete(key);
    }

    // Also cleanup any retry-phase slots for this issue.
    const retryPhases: ReadonlySet<SlotState["phase"]> = new Set(["retrying"]);
    for (const key of this.slotKeysForIssue(issueId, retryPhases)) {
      this.applySlotTransition(key, { type: "CLEANUP" });
    }

    this._state.retryAttempts.delete(issueId);
    this._state.completed.add(issueId);
  }

  snapshot(): {
    running: RunningEntry[];
    retrying: RetryEntry[];
    blocked: DispatchBlockEntry[];
    usageTotals: UsageTotals;
    rateLimits: unknown;
  } {
    return {
      running: [...this._state.running.values()].map((entry) => ({
        ...entry,
        issue: { ...entry.issue },
        usageTotals: { ...entry.usageTotals },
      })),
      retrying: [...this._state.retryAttempts.values()].map((entry) => ({ ...entry })),
      blocked: this._state.blockedDispatches.map((entry) => ({ ...entry })),
      usageTotals: { ...this._state.usageTotals },
      rateLimits: this._state.rateLimits,
    };
  }

  private applyUsageDelta(entry: RunningEntry, usage: Partial<UsageTotals>): void {
    const merged = mergeMonotonicUsage({
      entryTotals: entry.usageTotals,
      reportedTotals: {
        inputTokens: entry.lastReportedInputTokens,
        outputTokens: entry.lastReportedOutputTokens,
        totalTokens: entry.lastReportedTotalTokens,
        secondsRunning: 0,
      },
      globalTotals: this._state.usageTotals,
      update: usage,
    });

    entry.usageTotals = merged.entryTotals;
    entry.lastReportedInputTokens = merged.reportedTotals.inputTokens;
    entry.lastReportedOutputTokens = merged.reportedTotals.outputTokens;
    entry.lastReportedTotalTokens = merged.reportedTotals.totalTokens;
    this._state.usageTotals = merged.globalTotals;
  }

  private cleanupRetryAttempts(issues: Issue[]): void {
    for (const issue of issues) {
      if (!issueIsActive(issue, this.settings)) this._state.retryAttempts.delete(issue.id);
    }
  }

  private dueAt(delayMs: number): Date {
    const dueAt = this.clock.now();
    dueAt.setTime(dueAt.getTime() + delayMs);
    return dueAt;
  }

  private releaseStaleClaimsForRetry(issueId: string): void {
    for (const key of [...this._state.claimed]) {
      if (issueIdFromSlotKey(key) !== issueId) continue;
      // Use the slot FSM as the source of truth: if the slot is not in "running"
      // phase, the claim is stale and should be released.
      const slot = this.getSlotState(key);
      if (slot.phase !== "running") this._state.claimed.delete(key);
    }
  }
}

/**
 * Extracts the issueId portion from a slot key produced by slotKey().
 * Coupled to the `${issueId}:${slotIndex}` format defined in @symphony/dispatch.
 */
function issueIdFromSlotKey(key: string): string {
  const sep = key.lastIndexOf(":");
  return sep === -1 ? key : key.slice(0, sep);
}

/**
 * Compile-time exhaustiveness guard for SlotState phases.
 * If a new phase is added to the SlotState union without updating the legacy dual-write
 * paths, calling this function with the unhandled phase will produce a type error.
 */
function assertNeverPhase(_phase: never): never {
  throw new Error(`Unhandled slot phase in legacy dual-write: ${String(_phase)}`);
}

/**
 * Asserts that the dual-write paths cover all slot phases at compile time.
 * Called at module load to surface missing phase handlers as a type error.
 * The function is never reached at runtime (it returns before the switch).
 *
 * TODO(fsm-migration): Remove once legacy collections are eliminated.
 */
function _assertDualWriteExhaustive(): void {
  const phase = (null as unknown as SlotState).phase;
  switch (phase) {
    case "idle":       // handled by: finish (FINISH_NO_RETRY), releaseStaleClaimsForRetry
    case "running":    // handled by: claim (CLAIM), applyUpdate (UPDATE), refreshRunningIssue (REFRESH_ISSUE)
    case "retrying":   // handled by: finish (FINISH_WITH_RETRY), cleanupIssue (CLEANUP)
    case "completed":  // handled by: cleanupIssue (CLEANUP)
      return;
    default:
      assertNeverPhase(phase);
  }
}
void _assertDualWriteExhaustive;

/**
 * Compile-time exhaustiveness guard for SlotEvent types.
 * If a new event type is added without handling it in the dual-write paths,
 * this produces a type error. TODO(fsm-migration): Remove with dual-write.
 */
function _assertEventExhaustive(): void {
  const event = (null as unknown as SlotEvent).type;
  switch (event) {
    case "CLAIM":              // handled by: claim()
    case "UPDATE":             // handled by: applyUpdate()
    case "REFRESH_ISSUE":      // handled by: refreshRunningIssue()
    case "FINISH_WITH_RETRY":  // handled by: finish()
    case "FINISH_NO_RETRY":    // handled by: finish()
    case "CLEANUP":            // handled by: cleanupIssue()
      return;
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled slot event in legacy dual-write: ${String(_exhaustive)}`);
    }
  }
}
void _assertEventExhaustive;

export type { SlotState } from "./slot-state.js";
export { transitionSlot, initialSlotState, isTerminalOrEmptyPhase } from "./slot-state.js";
export type { SlotEvent } from "./slot-state.js";
