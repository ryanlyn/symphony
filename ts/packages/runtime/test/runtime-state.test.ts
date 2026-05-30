import { test } from "vitest";
import type { RuntimeAppStatus as RuntimeEventsAppStatus } from "@symphony/runtime-events";

import { assert } from "../../../test/assert.js";
import {
  transitionRuntime,
  initialRuntimePhase,
  isStartupCleanupDone,
  isStopRequested,
} from "../src/runtime-state.js";

import { type RuntimePhase, deriveAppStatus } from "@symphony/runtime";
import type { RuntimeAppStatus } from "@symphony/runtime";

test("initialRuntimePhase starts in idle with startupCleanupDone=false", () => {
  const state = initialRuntimePhase();
  assert.deepEqual(state, { phase: "idle", activeRuns: 0, startupCleanupDone: false, lastError: null });
});

test("deriveAppStatus maps each phase to the correct RuntimeAppStatus", () => {
  assert.equal(deriveAppStatus({ phase: "idle", activeRuns: 0, startupCleanupDone: false, lastError: null }), "idle");
  assert.equal(deriveAppStatus({ phase: "idle", activeRuns: 0, startupCleanupDone: true, lastError: null }), "idle");
  assert.equal(
    deriveAppStatus({ phase: "polling", activeRuns: 0, startupCleanupDone: true, lastError: null }),
    "polling",
  );
  assert.equal(
    deriveAppStatus({ phase: "polling", activeRuns: 1, startupCleanupDone: true, lastError: null }),
    "running",
  );
  assert.equal(deriveAppStatus({ phase: "running", activeRuns: 1, startupCleanupDone: true, lastError: null }), "running");
  assert.equal(deriveAppStatus({ phase: "stopping", activeRuns: 0, startupCleanupDone: true, lastError: null }), "stopping");
  assert.equal(deriveAppStatus({ phase: "error", activeRuns: 0, startupCleanupDone: true, lastError: "boom" }), "error");
});

// --- idle phase transitions ---

test("idle + POLL_START -> polling (preserves startupCleanupDone)", () => {
  const state: RuntimePhase = { phase: "idle", activeRuns: 0, startupCleanupDone: false, lastError: null };
  const next = transitionRuntime(state, { type: "POLL_START" });
  assert.deepEqual(next, { phase: "polling", activeRuns: 0, startupCleanupDone: false, lastError: null });
});

test("idle + POLL_START after cleanup -> polling with startupCleanupDone=true", () => {
  const state: RuntimePhase = { phase: "idle", activeRuns: 0, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "POLL_START" });
  assert.deepEqual(next, { phase: "polling", activeRuns: 0, startupCleanupDone: true, lastError: null });
});

test("idle + STOP_REQUESTED -> stopping", () => {
  const state: RuntimePhase = { phase: "idle", activeRuns: 0, startupCleanupDone: false, lastError: null };
  const next = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 0, startupCleanupDone: false, lastError: null });
});

test("idle + RUN_STARTED is a no-op (cannot start run outside polling)", () => {
  const state: RuntimePhase = { phase: "idle", activeRuns: 0, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "RUN_STARTED" });
  assert.equal(next, state);
});

test("idle + irrelevant events are no-ops", () => {
  const state: RuntimePhase = { phase: "idle", activeRuns: 0, startupCleanupDone: true, lastError: null };
  assert.equal(transitionRuntime(state, { type: "POLL_SUCCESS" }), state);
  assert.equal(transitionRuntime(state, { type: "RUN_STARTED" }), state);
  assert.equal(transitionRuntime(state, { type: "RUN_FINISHED" }), state);
  assert.equal(transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" }), state);
  assert.equal(transitionRuntime(state, { type: "POLL_ERROR", error: "x" }), state);
});

// --- polling phase transitions ---

test("polling + RUN_STARTED increments activeRuns", () => {
  const state: RuntimePhase = { phase: "polling", activeRuns: 0, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "RUN_STARTED" });
  assert.deepEqual(next, { phase: "polling", activeRuns: 1, startupCleanupDone: true, lastError: null });
});

test("polling + RUN_FINISHED decrements activeRuns (clamped at 0)", () => {
  const state: RuntimePhase = { phase: "polling", activeRuns: 2, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "polling", activeRuns: 1, startupCleanupDone: true, lastError: null });

  const zero: RuntimePhase = { phase: "polling", activeRuns: 0, startupCleanupDone: true, lastError: null };
  const clamped = transitionRuntime(zero, { type: "RUN_FINISHED" });
  assert.deepEqual(clamped, { phase: "polling", activeRuns: 0, startupCleanupDone: true, lastError: null });
});

test("polling + STARTUP_CLEANUP_DONE sets flag", () => {
  const state: RuntimePhase = { phase: "polling", activeRuns: 0, startupCleanupDone: false, lastError: null };
  const next = transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" });
  assert.deepEqual(next, { phase: "polling", activeRuns: 0, startupCleanupDone: true, lastError: null });
});

test("polling + POLL_SUCCESS with no active runs -> idle", () => {
  const state: RuntimePhase = { phase: "polling", activeRuns: 0, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "POLL_SUCCESS" });
  assert.deepEqual(next, { phase: "idle", activeRuns: 0, startupCleanupDone: true, lastError: null });
});

test("polling + POLL_SUCCESS with active runs -> running", () => {
  const state: RuntimePhase = { phase: "polling", activeRuns: 2, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "POLL_SUCCESS" });
  assert.deepEqual(next, { phase: "running", activeRuns: 2, startupCleanupDone: true, lastError: null });
});

test("polling + POLL_ERROR -> error (preserves activeRuns and startupCleanupDone)", () => {
  const state: RuntimePhase = { phase: "polling", activeRuns: 1, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "POLL_ERROR", error: "timeout" });
  assert.deepEqual(next, { phase: "error", activeRuns: 1, startupCleanupDone: true, lastError: "timeout" });
});

test("polling + STOP_REQUESTED -> stopping (preserves activeRuns)", () => {
  const state: RuntimePhase = { phase: "polling", activeRuns: 3, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 3, startupCleanupDone: true, lastError: null });
});

// --- running phase transitions ---

test("running + RUN_FINISHED with 1 active run -> idle", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 1, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "idle", activeRuns: 0, startupCleanupDone: true, lastError: null });
});

test("running + RUN_FINISHED with multiple runs -> running (decremented)", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 3, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "running", activeRuns: 2, startupCleanupDone: true, lastError: null });
});

test("running + RUN_STARTED -> running (incremented)", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 1, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "RUN_STARTED" });
  assert.deepEqual(next, { phase: "running", activeRuns: 2, startupCleanupDone: true, lastError: null });
});

test("running + POLL_START -> polling (preserves activeRuns)", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 2, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "POLL_START" });
  assert.deepEqual(next, { phase: "polling", activeRuns: 2, startupCleanupDone: true, lastError: null });
});

test("running + STOP_REQUESTED -> stopping", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 2, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 2, startupCleanupDone: true, lastError: null });
});

test("running + POLL_ERROR is a no-op (errors only captured during polling phase)", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 2, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "POLL_ERROR", error: "timeout" });
  assert.equal(next, state);
});

test("running + irrelevant events are no-ops", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 1, startupCleanupDone: true, lastError: null };
  assert.equal(transitionRuntime(state, { type: "POLL_SUCCESS" }), state);
  assert.equal(transitionRuntime(state, { type: "POLL_ERROR", error: "x" }), state);
  assert.equal(transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" }), state);
});

// --- stopping phase transitions ---

test("stopping + RUN_FINISHED decrements activeRuns", () => {
  const state: RuntimePhase = { phase: "stopping", activeRuns: 2, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 1, startupCleanupDone: true, lastError: null });
});

test("stopping + RUN_FINISHED with activeRuns=0 clamps to 0 (defensive guard)", () => {
  const state: RuntimePhase = { phase: "stopping", activeRuns: 0, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 0, startupCleanupDone: true, lastError: null });
});

test("stopping + RUN_STARTED is a no-op (no new runs accepted during drain)", () => {
  const state: RuntimePhase = { phase: "stopping", activeRuns: 1, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "RUN_STARTED" });
  assert.equal(next, state);
});

test("stopping absorbs most events", () => {
  const state: RuntimePhase = { phase: "stopping", activeRuns: 1, startupCleanupDone: true, lastError: null };
  assert.equal(transitionRuntime(state, { type: "POLL_START" }), state);
  assert.equal(transitionRuntime(state, { type: "POLL_SUCCESS" }), state);
  assert.equal(transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" }), state);
  assert.equal(transitionRuntime(state, { type: "STOP_REQUESTED" }), state);
  assert.equal(transitionRuntime(state, { type: "RUN_STARTED" }), state);
  assert.equal(transitionRuntime(state, { type: "POLL_ERROR", error: "x" }), state);
});

// --- error phase transitions ---

test("error + POLL_START -> polling (preserves startupCleanupDone from error phase)", () => {
  const state: RuntimePhase = { phase: "error", activeRuns: 0, startupCleanupDone: false, lastError: "timeout" };
  const next = transitionRuntime(state, { type: "POLL_START" });
  assert.deepEqual(next, { phase: "polling", activeRuns: 0, startupCleanupDone: false, lastError: null });
});

test("error + POLL_START with startupCleanupDone=true -> polling with startupCleanupDone=true", () => {
  const state: RuntimePhase = { phase: "error", activeRuns: 0, startupCleanupDone: true, lastError: "timeout" };
  const next = transitionRuntime(state, { type: "POLL_START" });
  assert.deepEqual(next, { phase: "polling", activeRuns: 0, startupCleanupDone: true, lastError: null });
});

test("error + RUN_FINISHED decrements activeRuns", () => {
  const state: RuntimePhase = { phase: "error", activeRuns: 2, startupCleanupDone: true, lastError: "x" };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "error", activeRuns: 1, startupCleanupDone: true, lastError: "x" });
});

test("error + STOP_REQUESTED -> stopping", () => {
  const state: RuntimePhase = { phase: "error", activeRuns: 1, startupCleanupDone: true, lastError: "x" };
  const next = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 1, startupCleanupDone: true, lastError: null });
});

test("error absorbs irrelevant events", () => {
  const state: RuntimePhase = { phase: "error", activeRuns: 0, startupCleanupDone: true, lastError: "x" };
  assert.equal(transitionRuntime(state, { type: "POLL_SUCCESS" }), state);
  assert.equal(transitionRuntime(state, { type: "RUN_STARTED" }), state);
  assert.equal(transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" }), state);
});

// --- isStartupCleanupDone ---

test("isStartupCleanupDone returns the flag value for all phases", () => {
  assert.equal(isStartupCleanupDone({ phase: "idle", activeRuns: 0, startupCleanupDone: false, lastError: null }), false);
  assert.equal(isStartupCleanupDone({ phase: "idle", activeRuns: 0, startupCleanupDone: true, lastError: null }), true);
  assert.equal(isStartupCleanupDone({ phase: "polling", activeRuns: 0, startupCleanupDone: false, lastError: null }), false);
  assert.equal(isStartupCleanupDone({ phase: "polling", activeRuns: 0, startupCleanupDone: true, lastError: null }), true);
  assert.equal(isStartupCleanupDone({ phase: "running", activeRuns: 1, startupCleanupDone: true, lastError: null }), true);
  assert.equal(isStartupCleanupDone({ phase: "stopping", activeRuns: 0, startupCleanupDone: true, lastError: null }), true);
  assert.equal(isStartupCleanupDone({ phase: "error", activeRuns: 0, startupCleanupDone: true, lastError: "x" }), true);
  assert.equal(isStartupCleanupDone({ phase: "error", activeRuns: 0, startupCleanupDone: false, lastError: "x" }), false);
});

// --- isStopRequested ---

test("isStopRequested returns true only for stopping phase", () => {
  assert.equal(isStopRequested({ phase: "idle", activeRuns: 0, startupCleanupDone: false, lastError: null }), false);
  assert.equal(
    isStopRequested({ phase: "polling", activeRuns: 0, startupCleanupDone: true, lastError: null }),
    false,
  );
  assert.equal(isStopRequested({ phase: "running", activeRuns: 1, startupCleanupDone: true, lastError: null }), false);
  assert.equal(isStopRequested({ phase: "stopping", activeRuns: 0, startupCleanupDone: true, lastError: null }), true);
  assert.equal(isStopRequested({ phase: "stopping", activeRuns: 3, startupCleanupDone: true, lastError: null }), true);
  assert.equal(isStopRequested({ phase: "error", activeRuns: 0, startupCleanupDone: true, lastError: "x" }), false);
});


// --- immutability guarantee ---

test("transitionRuntime never mutates the input state", () => {
  const state: RuntimePhase = { phase: "polling", activeRuns: 1, startupCleanupDone: false, lastError: null };
  const frozen = Object.freeze({ ...state });
  // These should not throw since the function should not mutate the input
  const next = transitionRuntime(frozen, { type: "RUN_STARTED" });
  assert.equal(frozen.activeRuns, 1); // original unchanged
  assert.equal(next.activeRuns, 2);
  assert.notEqual(next, frozen);
});

test("transitionRuntime immutability: phase-changing transition preserves old reference", () => {
  const state: RuntimePhase = { phase: "polling", activeRuns: 2, startupCleanupDone: true, lastError: null };
  const frozen = Object.freeze({ ...state });
  // POLL_SUCCESS with activeRuns > 0 changes phase from polling -> running
  const next = transitionRuntime(frozen, { type: "POLL_SUCCESS" });
  assert.equal(frozen.phase, "polling"); // old reference retains old phase
  assert.equal(frozen.activeRuns, 2);
  assert.equal(next.phase, "running"); // new reference has the new phase
  assert.equal(next.activeRuns, 2);
  assert.notEqual(next, frozen);
});

test("transitionRuntime immutability: RUN_FINISHED from running->idle preserves old reference", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 1, startupCleanupDone: true, lastError: null };
  const frozen = Object.freeze({ ...state });
  const next = transitionRuntime(frozen, { type: "RUN_FINISHED" });
  assert.equal(frozen.phase, "running");
  assert.equal(frozen.activeRuns, 1);
  assert.equal(next.phase, "idle");
  assert.equal(next.activeRuns, 0);
  assert.notEqual(next, frozen);
});

// --- multi-step lifecycle tests (finding 8) ---

test("full lifecycle: idle -> polling -> running -> idle", () => {
  let state: RuntimePhase = initialRuntimePhase();
  assert.equal(state.phase, "idle");

  state = transitionRuntime(state, { type: "POLL_START" });
  assert.equal(state.phase, "polling");

  state = transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" });
  assert.equal(state.startupCleanupDone, true);

  state = transitionRuntime(state, { type: "RUN_STARTED" });
  assert.equal(state.activeRuns, 1);

  state = transitionRuntime(state, { type: "POLL_SUCCESS" });
  assert.equal(state.phase, "running");
  assert.equal(state.activeRuns, 1);

  state = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.equal(state.phase, "idle");
  assert.equal(state.activeRuns, 0);
  assert.equal(state.startupCleanupDone, true);
});

test("full lifecycle: idle -> polling -> error -> polling -> running -> stopping", () => {
  let state: RuntimePhase = initialRuntimePhase();

  state = transitionRuntime(state, { type: "POLL_START" });
  assert.equal(state.phase, "polling");

  state = transitionRuntime(state, { type: "RUN_STARTED" });
  assert.equal(state.activeRuns, 1);

  state = transitionRuntime(state, { type: "POLL_ERROR", error: "network" });
  assert.equal(state.phase, "error");
  assert.equal(state.lastError, "network");
  assert.equal(state.activeRuns, 1);
  assert.equal(state.startupCleanupDone, false);

  // Recovery from error
  state = transitionRuntime(state, { type: "POLL_START" });
  assert.equal(state.phase, "polling");
  assert.equal(state.startupCleanupDone, false); // preserved from error, not hardcoded true
  assert.equal(state.activeRuns, 1);

  state = transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" });
  assert.equal(state.startupCleanupDone, true);

  state = transitionRuntime(state, { type: "POLL_SUCCESS" });
  assert.equal(state.phase, "running");

  state = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.equal(state.phase, "stopping");
  assert.equal(state.activeRuns, 1);

  state = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.equal(state.phase, "stopping");
  assert.equal(state.activeRuns, 0);
});

test("multi-step: mutation leak does not occur between transitions", () => {
  let state: RuntimePhase = initialRuntimePhase();
  state = transitionRuntime(state, { type: "POLL_START" });

  const stateBeforeRun = state;
  state = transitionRuntime(state, { type: "RUN_STARTED" });

  // The previous reference should NOT have been mutated
  assert.equal(stateBeforeRun.activeRuns, 0);
  assert.equal(state.activeRuns, 1);
  assert.notEqual(stateBeforeRun, state);
});

// --- RESTART event tests ---

test("RESTART with activeRuns > 0 produces running phase, derives from current state", () => {
  const state: RuntimePhase = { phase: "idle", activeRuns: 3, startupCleanupDone: true, lastError: null };
  const next = transitionRuntime(state, { type: "RESTART" });
  assert.deepEqual(next, { phase: "running", activeRuns: 3, startupCleanupDone: true, lastError: null });
});

test("RESTART with activeRuns = 0 produces idle phase, derives from current state", () => {
  const state: RuntimePhase = { phase: "error", activeRuns: 0, startupCleanupDone: true, lastError: "x" };
  const next = transitionRuntime(state, { type: "RESTART" });
  assert.deepEqual(next, { phase: "idle", activeRuns: 0, startupCleanupDone: true, lastError: null });
});

test("RESTART preserves startupCleanupDone from current state", () => {
  const state: RuntimePhase = { phase: "idle", activeRuns: 2, startupCleanupDone: false, lastError: null };
  const next = transitionRuntime(state, { type: "RESTART" });
  assert.deepEqual(next, { phase: "running", activeRuns: 2, startupCleanupDone: false, lastError: null });
});

test("RESTART from stopping with activeRuns recovers to running (stop-then-restart scenario)", () => {
  // Simulates: start() -> dispatch run -> stop() -> start() again
  let state: RuntimePhase = initialRuntimePhase();

  // Start and dispatch a run
  state = transitionRuntime(state, { type: "POLL_START" });
  state = transitionRuntime(state, { type: "RUN_STARTED" });
  state = transitionRuntime(state, { type: "POLL_SUCCESS" });
  assert.equal(state.phase, "running");
  assert.equal(state.activeRuns, 1);

  // Stop requested
  state = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.equal(state.phase, "stopping");
  assert.equal(state.activeRuns, 1);

  // RESTART is blocked while stopping with activeRuns > 0 (prevents new dispatches during drain)
  state = transitionRuntime(state, { type: "RESTART" });
  assert.equal(state.phase, "stopping");
  assert.equal(state.activeRuns, 1);

  // Run finishes during drain
  state = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.equal(state.phase, "stopping");
  assert.equal(state.activeRuns, 0);

  // RESTART succeeds once activeRuns is 0
  state = transitionRuntime(state, { type: "RESTART" });
  assert.equal(state.phase, "idle");
  assert.equal(state.activeRuns, 0);
});

test("RESTART from stopping with no activeRuns recovers to idle", () => {
  let state: RuntimePhase = initialRuntimePhase();

  state = transitionRuntime(state, { type: "POLL_START" });
  state = transitionRuntime(state, { type: "POLL_SUCCESS" });
  assert.equal(state.phase, "idle");

  state = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.equal(state.phase, "stopping");

  // RESTART with no active runs -> idle
  state = transitionRuntime(state, { type: "RESTART" });
  assert.equal(state.phase, "idle");
  assert.equal(state.activeRuns, 0);
});

// --- STOP_REQUESTED preemption ---

test("STOP_REQUESTED during polling phase preempts subsequent POLL_ERROR", () => {
  let state: RuntimePhase = initialRuntimePhase();

  // Enter polling with an active run
  state = transitionRuntime(state, { type: "POLL_START" });
  state = transitionRuntime(state, { type: "RUN_STARTED" });
  assert.equal(state.phase, "polling");
  assert.equal(state.activeRuns, 1);

  // STOP_REQUESTED transitions to stopping
  state = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.equal(state.phase, "stopping");
  assert.equal(state.activeRuns, 1);

  // A subsequent POLL_ERROR is absorbed by the stopping phase (no transition to error)
  state = transitionRuntime(state, { type: "POLL_ERROR", error: "network timeout" });
  assert.equal(state.phase, "stopping");
  assert.equal(state.lastError, null); // error not recorded in stopping phase

  // RUN_FINISHED still drains correctly
  state = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.equal(state.phase, "stopping");
  assert.equal(state.activeRuns, 0);
});

// --- Type compatibility check for RuntimeAppStatus (Finding 9) ---
// This ensures the RuntimeAppStatus type in @symphony/runtime-events stays in sync.

test("RuntimeAppStatus type from runtime is compatible with runtime-events", () => {
  // If these imports compile, the types are compatible. At runtime just verify a value.
  const _check: RuntimeEventsAppStatus extends RuntimeAppStatus ? true : never = true;
  const _checkReverse: RuntimeAppStatus extends RuntimeEventsAppStatus ? true : never = true;
  assert.equal(_check, true);
  assert.equal(_checkReverse, true);
});
