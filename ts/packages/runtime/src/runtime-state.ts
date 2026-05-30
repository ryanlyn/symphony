/**
 * Public-facing runtime app status. Defined here (single source of truth) and
 * re-exported from the runtime package index.
 *
 * Note: "starting" is included for API compatibility with external consumers
 * (e.g. runtime-events, TUI) but is never produced by deriveAppStatus().
 */
export type RuntimeAppStatus = "starting" | "idle" | "polling" | "running" | "stopping" | "error";

/**
 * Flat record representing the lifecycle state of the SymphonyRuntime.
 * This is the single source of truth for app status -- no separate boolean flags needed.
 *
 * Uses a single record shape with a phase discriminator rather than a discriminated union.
 * Adding a cross-cutting field only requires adding it here and in initialRuntimePhase().
 * See orchestrator's SlotState for the discriminated-union alternative (used when each
 * phase carries fundamentally different data).
 */
export interface RuntimePhase {
  phase: "idle" | "polling" | "running" | "stopping" | "error";
  activeRuns: number;
  startupCleanupDone: boolean;
  lastError: string | null;
}

/**
 * Events that trigger phase transitions in the runtime state machine.
 *
 * Named 'RuntimePhaseEvent' to parallel the 'RuntimePhase' state type it belongs to,
 * and to avoid collision with the RuntimeEvent interface used for runtime log events
 * in the package's public API.
 * Conceptually equivalent to SlotEvent in the orchestrator package.
 *
 * Note: The agent-runner package uses a simpler imperative RunPhase label rather than
 * a formal FSM, because its lifecycle is strictly sequential with no concurrent events.
 * See agent-runner/src/index.ts RunPhase type for that approach.
 */
export type RuntimePhaseEvent =
  | { type: "POLL_START" }
  | { type: "POLL_SUCCESS" }
  | { type: "POLL_ERROR"; error: string }
  | { type: "RUN_STARTED" }
  | { type: "RUN_FINISHED" }
  | { type: "STARTUP_CLEANUP_DONE" }
  | { type: "STOP_REQUESTED" }
  | { type: "RESTART" };

/**
 * Derives the public-facing RuntimeAppStatus from the internal phase.
 * This replaces the scattered `this.inFlight.size > 0 ? "running" : "idle"` computations.
 */
export function deriveAppStatus(state: RuntimePhase): RuntimeAppStatus {
  switch (state.phase) {
    case "idle":
      return "idle";
    case "polling":
      return state.activeRuns > 0 ? "running" : "polling";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "error":
      return "error";
    default:
      return assertNeverPhase(state.phase);
  }
}

/**
 * Extract whether startup cleanup has been done from the current phase.
 */
export function isStartupCleanupDone(state: RuntimePhase): boolean {
  return state.startupCleanupDone;
}

/**
 * Whether a stop has been requested (the runtime is draining active runs).
 * This replaces the old `stopped` boolean -- note that it means "stop requested",
 * not "fully quiesced".
 */
export function isStopRequested(state: RuntimePhase): boolean {
  return state.phase === "stopping";
}


/**
 * Pure transition function for the runtime state machine.
 * Given the current phase and an event, returns a new phase object.
 * Pure for the current flat shape (shallow spread suffices). If nested fields
 * are added, deep-copy or an immutable library will be needed.
 */
export function transitionRuntime(state: RuntimePhase, event: RuntimePhaseEvent): RuntimePhase {
  // --- Global events (handled regardless of current phase) ---

  // RESTART resets phase based on current activeRuns, preserving startupCleanupDone.
  // Blocked from "stopping" while activeRuns > 0 to prevent new dispatches during drain.
  if (event.type === "RESTART") {
    if (state.phase === "stopping" && state.activeRuns > 0) return state;
    if (state.activeRuns > 0) {
      return { ...state, phase: "running", lastError: null };
    }
    return { ...state, phase: "idle", lastError: null };
  }

  // STOP_REQUESTED transitions from any non-terminal state
  if (event.type === "STOP_REQUESTED") {
    if (state.phase === "stopping") return state;
    return { ...state, phase: "stopping", lastError: null };
  }

  // --- Phase-specific transitions ---

  switch (state.phase) {
    case "idle":
      if (event.type === "POLL_START")
        return { ...state, phase: "polling" };
      return state;

    case "polling":
      if (event.type === "RUN_STARTED")
        return { ...state, activeRuns: state.activeRuns + 1 };
      if (event.type === "RUN_FINISHED")
        return { ...state, activeRuns: Math.max(0, state.activeRuns - 1) };
      if (event.type === "STARTUP_CLEANUP_DONE")
        return { ...state, startupCleanupDone: true };
      if (event.type === "POLL_SUCCESS")
        return state.activeRuns > 0
          ? { ...state, phase: "running" }
          : { ...state, phase: "idle" };
      if (event.type === "POLL_ERROR")
        return { ...state, phase: "error", lastError: event.error };
      return state;

    case "running":
      if (event.type === "RUN_FINISHED")
        return state.activeRuns <= 1
          ? { ...state, phase: "idle", activeRuns: 0 }
          : { ...state, activeRuns: Math.max(0, state.activeRuns - 1) };
      if (event.type === "RUN_STARTED")
        return { ...state, activeRuns: state.activeRuns + 1 };
      if (event.type === "POLL_START")
        return { ...state, phase: "polling" };
      return state;

    case "stopping":
      // Once stop is requested, this is a drain-only state. RUN_STARTED is rejected
      // because the runtime must not account for new runs after stop() is called.
      if (event.type === "RUN_FINISHED")
        return { ...state, activeRuns: Math.max(0, state.activeRuns - 1) };
      return state;

    case "error":
      if (event.type === "POLL_START")
        return { ...state, phase: "polling", lastError: null };
      if (event.type === "RUN_FINISHED")
        return { ...state, activeRuns: Math.max(0, state.activeRuns - 1) };
      return state;

    default:
      return assertNeverPhase(state.phase);
  }
}

/**
 * Compile-time exhaustiveness guard. If a new phase is added to RuntimePhase['phase']
 * without handling it in transitionRuntime, this will produce a type error.
 */
function assertNeverPhase(_phase: never): never {
  throw new Error(`Unhandled runtime phase: ${String(_phase)}`);
}

/**
 * Initial state for the runtime state machine.
 */
export function initialRuntimePhase(): RuntimePhase {
  return { phase: "idle", activeRuns: 0, startupCleanupDone: false, lastError: null };
}
