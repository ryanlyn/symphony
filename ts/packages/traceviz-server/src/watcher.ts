/**
 * TraceWatcher: polls a trace directory for per-ticket subdirectories, each
 * containing a `trace.jsonl` file with one JSON line per AgentUpdate event
 * emitted by the TraceEmitter.
 *
 * Directory layout:
 *   traceDir/
 *     CAN-123/
 *       trace.jsonl
 *     CAN-456/
 *       trace.jsonl
 */

import { readFileSync } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { DisplayEvent } from "./models/display-events.js";
import type { TicketInfo } from "./models/api.js";
import { parseTraceLines, extractTicketMetadata } from "./parser.js";

const DEFAULT_POLL_INTERVAL_MS = 500;

interface FileState {
  issueId: string;
  issueIdentifier: string;
  lineCount: number;
  lastModified: number;
  filePath: string;
  turnStartedCount: number;
  turnCompletedCount: number;
  hasFailed: boolean;
  startedAt: string | undefined;
}

export type WatcherCallback = (issueId: string, events: DisplayEvent[]) => void;

export class TraceWatcher {
  private readonly traceDir: string;
  private readonly pollIntervalMs: number;
  private fileStates = new Map<string, FileState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private scanning = false;

  constructor(traceDir: string, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    this.traceDir = traceDir;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(callback: WatcherCallback): void {
    this.stopped = false;
    void this.scan(callback);
    this.timer = setInterval(() => {
      void this.scan(callback);
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getTickets(): TicketInfo[] {
    const tickets: TicketInfo[] = [];
    for (const state of this.fileStates.values()) {
      let status: TicketInfo["status"] = "idle";
      if (state.hasFailed) {
        status = "failed";
      } else if (state.turnStartedCount > 0 && state.turnCompletedCount >= state.turnStartedCount) {
        status = "completed";
      } else if (state.turnStartedCount > 0) {
        status = "running";
      }

      tickets.push({
        issueId: state.issueId,
        identifier: state.issueIdentifier,
        turnCount: state.turnStartedCount,
        status,
        startedAt: state.startedAt,
      });
    }
    return tickets;
  }

  hasTicket(issueId: string): boolean {
    return this.fileStates.has(issueId);
  }

  getEventsForTicket(issueId: string): DisplayEvent[] {
    const state = this.fileStates.get(issueId);
    if (!state) return [];
    return this.readAndParseSync(state.filePath);
  }

  private readAndParseSync(filePath: string): DisplayEvent[] {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      return parseTraceLines(lines);
    } catch {
      return [];
    }
  }

  private async scan(callback: WatcherCallback): Promise<void> {
    if (this.stopped) return;
    if (this.scanning) return;
    try {
      await access(this.traceDir);
    } catch {
      return;
    }

    this.scanning = true;
    try {
      let entries: string[];
      try {
        entries = await readdir(this.traceDir);
      } catch {
        return;
      }

      const resolvedDir = path.resolve(this.traceDir);

      for (const entry of entries) {
        const dirPath = path.join(this.traceDir, entry);

        const resolvedDirPath = path.resolve(dirPath);
        if (!resolvedDirPath.startsWith(resolvedDir + path.sep)) continue;

        const filePath = path.join(dirPath, "trace.jsonl");

        try {
          const dirStat = await stat(dirPath);
          if (!dirStat.isDirectory()) continue;

          const fileStat = await stat(filePath);
          const existing = this.fileStates.get(entry);

          if (existing && fileStat.mtimeMs <= existing.lastModified) {
            continue;
          }

          const result = await this.readFile(filePath, entry, fileStat.mtimeMs);
          if (result) {
            const canonicalKey = result.state.issueId;
            const existingByKey = this.fileStates.get(canonicalKey);
            if (result.state.lineCount !== (existingByKey?.lineCount ?? 0)) {
              this.fileStates.set(canonicalKey, result.state);
              callback(canonicalKey, result.events);
            } else {
              this.fileStates.set(canonicalKey, result.state);
            }
          }
        } catch {
          // Skip entries we cannot read
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private async readFile(
    filePath: string,
    issueId: string,
    mtimeMs?: number,
  ): Promise<{ state: FileState; events: DisplayEvent[] } | null> {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const events = parseTraceLines(lines);
      const metadata = extractTicketMetadata(lines);
      const lastModified = mtimeMs ?? (await stat(filePath)).mtimeMs;

      const turnStartedCount = events.filter((e) => e.kind === "turn_started").length;
      const turnCompletedCount = events.filter((e) => e.kind === "turn_completed").length;
      const hasFailed = events.some((e) => e.kind === "turn_failed");
      const firstEvent = events[0];
      const startedAt = firstEvent?.timestamp;

      const state: FileState = {
        issueId: metadata?.issueId ?? issueId,
        issueIdentifier: metadata?.issueIdentifier ?? issueId,
        lineCount: lines.length,
        lastModified,
        filePath,
        turnStartedCount,
        turnCompletedCount,
        hasFailed,
        startedAt,
      };

      return { state, events };
    } catch {
      return null;
    }
  }
}
