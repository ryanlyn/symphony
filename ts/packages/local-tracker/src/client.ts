import path from "node:path";

import type { Issue, RuntimeTrackerClient, Settings } from "@symphony/domain";

import { BoardStore } from "./boardStore.js";

const DEFAULT_DIR = ".symphony/board";

export class LocalTrackerClient implements RuntimeTrackerClient {
  private readonly store: BoardStore;

  constructor(
    private readonly settings: Settings,
    cwd: string = process.cwd(),
  ) {
    const configured = settings.tracker.path ?? DEFAULT_DIR;
    const dir = path.isAbsolute(configured) ? configured : path.join(cwd, configured);
    this.store = new BoardStore(dir);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.store.byStatus(this.settings.tracker.activeStates);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    return this.store.getByIds(ids);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    return this.store.byStatus(states);
  }
}
