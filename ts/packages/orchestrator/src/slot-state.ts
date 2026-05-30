import type { AgentUpdate, Issue, RetryEntry, RunningEntry } from "@symphony/domain";

/**
 * Discriminated union for the lifecycle of a single issue slot.
 * Each slot transitions through these phases -- no separate boolean flags or
 * parallel data structures needed.
 *
 * Design note: This uses a discriminated union (different fields per phase variant)
 * because each slot phase carries fundamentally different data (e.g., running carries
 * a RunningEntry, retrying carries a RetryEntry). In contrast, the runtime's
 * RuntimePhase (@symphony/runtime runtime-state.ts) uses a flat interface because it
 * tracks cross-cutting counters (activeRuns, startupCleanupDone) relevant across all
 * phases. See the design note in runtime-state.ts lines 14-23 for the full rationale.
 */
export type SlotState =
  | { phase: "idle" }
  | { phase: "running"; entry: RunningEntry }
  | { phase: "retrying"; retry: RetryEntry }
  | { phase: "completed" };

/**
 * Events that cause slot state transitions.
 * Each event variant carries all data required for its transition -- no
 * out-of-band parameters needed.
 *
 * See also: RuntimePhaseEvent in @symphony/runtime for the runtime-level FSM,
 * and RunPhase in @symphony/agent-runner for a simpler imperative label approach
 * used when the lifecycle is strictly sequential.
 */
export type SlotEvent =
  | { type: "CLAIM"; entry: RunningEntry }
  | { type: "UPDATE"; update: AgentUpdate; now: Date }
  | { type: "REFRESH_ISSUE"; issue: Issue }
  | { type: "FINISH_WITH_RETRY"; retryEntry: RetryEntry }
  | { type: "FINISH_NO_RETRY" }
  | { type: "CLEANUP" };

/**
 * Creates a new entry with the agent update applied (pure -- does not mutate the input).
 */
export function applyUpdateToEntry(entry: RunningEntry, update: AgentUpdate, now: Date): RunningEntry {
  return {
    ...entry,
    lastAgentEvent: update.type,
    lastAgentMessage: update.message,
    lastAgentTimestamp: update.timestamp ?? now,
    ...(update.sessionId !== undefined ? { sessionId: update.sessionId } : {}),
    ...(update.resumeId !== undefined ? { resumeId: update.resumeId } : {}),
    ...(update.executorPid !== undefined ? { executorPid: update.executorPid } : {}),
    ...(update.workspacePath !== undefined ? { workspacePath: update.workspacePath } : {}),
    turnCount: update.type === "turn_completed" ? entry.turnCount + 1 : entry.turnCount,
  };
}

/**
 * Pure transition function for a single slot's lifecycle.
 * Given the current state and an event, returns the next state.
 * The input state is never mutated.
 */
export function transitionSlot(state: SlotState, event: SlotEvent): SlotState {
  switch (state.phase) {
    case "idle":
      if (event.type === "CLAIM") return { phase: "running", entry: event.entry };
      if (event.type === "CLEANUP") return { phase: "completed" };
      return state; // invalid event in this state -- no-op

    case "running":
      if (event.type === "UPDATE") {
        const updatedEntry = applyUpdateToEntry(state.entry, event.update, event.now);
        return { phase: "running", entry: updatedEntry };
      }
      if (event.type === "REFRESH_ISSUE") {
        return { phase: "running", entry: { ...state.entry, issue: event.issue } };
      }
      if (event.type === "FINISH_WITH_RETRY") return { phase: "retrying", retry: event.retryEntry };
      if (event.type === "FINISH_NO_RETRY") return { phase: "idle" };
      if (event.type === "CLEANUP") return { phase: "completed" };
      return state;

    case "retrying":
      if (event.type === "CLEANUP") return { phase: "completed" };
      if (event.type === "CLAIM") return { phase: "running", entry: event.entry };
      return state;

    case "completed":
      return state; // terminal, absorbs all events
  }
}

/**
 * Returns true if the given slot state is terminal or empty (i.e., the slot
 * should not be stored in the active slots map). Uses a switch with exhaustiveness
 * guard so that adding a new phase forces an explicit classification decision.
 */
export function isTerminalOrEmptyPhase(state: SlotState): boolean {
  switch (state.phase) {
    case "idle":
    case "completed":
      return true;
    case "running":
    case "retrying":
      return false;
    default:
      return assertNeverSlotPhase(state);
  }
}

function assertNeverSlotPhase(_state: never): never {
  throw new Error(`Unhandled slot phase: ${(_state as SlotState).phase}`);
}

/**
 * Initial state for a fresh slot.
 */
export function initialSlotState(): SlotState {
  return { phase: "idle" };
}
