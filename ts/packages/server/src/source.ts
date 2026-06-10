import type { Settings } from "@symphony/domain";
import type { RuntimeSnapshot } from "@symphony/runtime-events";

/**
 * The slice of the runtime the observability server reads: current settings, state
 * snapshots, and a refresh hook. Shared by the HTTP routes and the websocket push
 * transport without coupling either to the server entry module.
 */
export interface RuntimeServerSource {
  workflow?: { settings?: Settings } | undefined;
  snapshot(): RuntimeSnapshot;
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  requestRefresh(): Record<string, unknown>;
}
