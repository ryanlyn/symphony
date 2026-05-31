import { mkdirSync, appendFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import type { AgentUpdate } from "@symphony/domain";

export class TraceEmitter {
  private readonly traceDir: string;
  private initialized = false;

  constructor(traceDir: string) {
    this.traceDir = traceDir;
  }

  emit(issueId: string, issueIdentifier: string, update: AgentUpdate): void {
    if (!this.initialized) {
      mkdirSync(this.traceDir, { recursive: true });
      this.initialized = true;
    }
    const line = JSON.stringify({
      type: update.type,
      issueId,
      issueIdentifier,
      timestamp: update.timestamp ? update.timestamp.toISOString() : null,
      message: update.message ?? null,
      usage: update.usage ?? null,
      workspacePath: update.workspacePath ?? null,
      sessionId: update.sessionId ?? null,
      executorPid: update.executorPid ?? null,
    });
    appendFileSync(TraceEmitter.tracePathForIssue(this.traceDir, issueId), line + "\n");
  }

  clear(issueId: string): void {
    const filePath = TraceEmitter.tracePathForIssue(this.traceDir, issueId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  static tracePathForIssue(traceDir: string, issueId: string): string {
    return path.join(traceDir, issueId + ".jsonl");
  }
}
