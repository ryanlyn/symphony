import { promises as fs } from "node:fs";
import path from "node:path";

import type { HostAssignmentRecord, HostAssignmentStorePort } from "@symphony/ports";

export interface FileHostAssignmentStoreOptions {
  filePath: string;
  onError?: (error: unknown) => void;
}

export class FileHostAssignmentStore implements HostAssignmentStorePort {
  private readonly cache = new Map<string, HostAssignmentRecord>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly options: FileHostAssignmentStoreOptions) {}

  static async load(options: FileHostAssignmentStoreOptions): Promise<FileHostAssignmentStore> {
    const store = new FileHostAssignmentStore(options);
    await store.loadFromDisk();
    return store;
  }

  get(issueId: string): string | null {
    return this.cache.get(issueId)?.workerHost ?? null;
  }

  set(issueId: string, record: HostAssignmentRecord): void {
    const existing = this.cache.get(issueId);
    const identifier = record.identifier ?? existing?.identifier ?? null;
    if (existing && existing.workerHost === record.workerHost && existing.identifier === identifier)
      return;
    this.cache.set(issueId, {
      workerHost: record.workerHost,
      identifier,
      updatedAt: new Date().toISOString(),
    });
    this.schedulePersist();
  }

  delete(issueId: string): void {
    if (!this.cache.has(issueId)) return;
    this.cache.delete(issueId);
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const text = await fs.readFile(this.options.filePath, "utf8");
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      for (const [issueId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const record = value as Partial<HostAssignmentRecord>;
        if (typeof record.workerHost === "string") {
          this.cache.set(issueId, {
            workerHost: record.workerHost,
            identifier: record.identifier ?? null,
            updatedAt: record.updatedAt,
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      this.options.onError?.(error);
    }
  }

  private schedulePersist(): void {
    this.writeQueue = this.writeQueue
      .then(async () => this.persist())
      .catch((error) => {
        this.options.onError?.(error);
      });
  }

  private async persist(): Promise<void> {
    const payload: Record<string, HostAssignmentRecord> = {};
    for (const [issueId, record] of this.cache.entries()) payload[issueId] = record;
    const tmp = `${this.options.filePath}.tmp`;
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    await fs.rename(tmp, this.options.filePath);
  }
}
