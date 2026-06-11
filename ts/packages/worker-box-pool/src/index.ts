// Public barrel for @symphony/worker-box-pool: the pool ENGINE.
//
// Exports the pool surface (createBoxPool + the lease/inventory/snapshot types)
// and re-exports the driver contract from `@symphony/box-sdk` so the engine
// surface stays one-stop for the runtime/CLI. Importing this barrel has NO side
// effects: no driver is registered here. Concrete drivers live in extensions
// (and the in-memory fake in the SDK); the composition root registers them into
// a `BoxDriverRegistry` (or the process-wide default) and threads that registry
// to `createBoxPool` via `CreateBoxPoolDeps.drivers`.

export type {
  AcquireRequest,
  AcquireResult,
  BoxLease,
  BoxOutcome,
  BoxPool,
  BoxPoolSnapshot,
  BoxRecord,
  BoxState,
  LedgerRow,
  MachineLease,
  Mutex,
} from "./types.js";

export { createMutex } from "./mutex.js";

export { createBoxPool, type CreateBoxPoolDeps } from "./pool.js";

// Driver-contract surface re-exported from the SDK so downstream engine
// consumers can keep importing it from this package.
export {
  BoxDriverRegistry,
  defaultBoxDriverRegistry,
  FakeBoxDriver,
  POOL_OWNED_LABEL,
  registerFakeBoxDriver,
} from "@symphony/box-sdk";
export type {
  BoxDescriptor,
  BoxDriver,
  BoxDriverFactory,
  BoxHealth,
  DriverDeps,
  TeardownReason,
} from "@symphony/box-sdk";
