import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { IssueStore } from "../src/issue-store.js";

function makeTempDir(): string {
  const dir = path.join(
    tmpdir(),
    `issue-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("IssueStore", () => {
  let dir: string;
  let store: IssueStore;

  beforeEach(() => {
    dir = makeTempDir();
    store = new IssueStore(path.join(dir, "issues.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and retrieves a record", () => {
    store.upsert({ id: "id-1", identifier: "ENG-1", title: "Fix bug", url: "https://example.com" });

    const record = store.get("id-1");
    expect(record).toEqual({
      id: "id-1",
      identifier: "ENG-1",
      title: "Fix bug",
      url: "https://example.com",
    });
  });

  it("upserts existing record with new title and url", () => {
    store.upsert({ id: "id-1", identifier: "ENG-1", title: "Old title", url: null });
    store.upsert({ id: "id-1", identifier: "ENG-1", title: "New title", url: "https://new.url" });

    const record = store.get("id-1");
    expect(record?.title).toBe("New title");
    expect(record?.url).toBe("https://new.url");
  });

  it("updates identifier on upsert", () => {
    store.upsert({ id: "id-1", identifier: "ENG-1", title: "Title", url: null });
    store.upsert({ id: "id-1", identifier: "ENG-2", title: "Title", url: null });

    const record = store.get("id-1");
    expect(record?.identifier).toBe("ENG-2");
  });

  it("returns undefined for non-existent id", () => {
    expect(store.get("no-such-id")).toBeUndefined();
  });

  it("handles null title and url", () => {
    store.upsert({ id: "id-1", identifier: "ENG-1", title: null, url: null });

    const record = store.get("id-1");
    expect(record?.title).toBeNull();
    expect(record?.url).toBeNull();
  });

  it("getAll returns all records", () => {
    store.upsert({ id: "id-1", identifier: "ENG-1", title: "A", url: null });
    store.upsert({ id: "id-2", identifier: "ENG-2", title: "B", url: null });
    store.upsert({ id: "id-3", identifier: "ENG-3", title: "C", url: null });

    const all = store.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.id).sort()).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("survives close and reopen", () => {
    store.upsert({ id: "id-1", identifier: "ENG-1", title: "Persistent", url: null });
    store.close();

    const store2 = new IssueStore(path.join(dir, "issues.db"));
    const record = store2.get("id-1");
    expect(record?.title).toBe("Persistent");
    store2.close();
  });
});
