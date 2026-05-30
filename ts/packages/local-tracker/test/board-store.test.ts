import { mkdtemp, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { BoardStore } from "@symphony/local-tracker";

async function tempBoard(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "board-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

test("create allocates incrementing BOARD ids and round-trips", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);

  const a = await store.create({ title: "First", body: "Body A", status: "Todo" });
  const b = await store.create({ title: "Second" });
  assert.deepEqual([a.identifier, b.identifier], ["BOARD-1", "BOARD-2"]);
  assert.equal(a.id, "BOARD-1");
  assert.equal(a.title, "First");
  assert.equal(a.description, "Body A");
  assert.equal(a.state, "Todo");
  assert.equal(a.stateType, "unstarted");
  assert.equal(b.state, "Todo");

  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /status: Todo/);
  assert.match(file, /# First/);
});

test("updateStatus rewrites only the status and preserves body", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "Fix it", body: "Details here", status: "Todo" });

  const updated = await store.updateStatus("BOARD-1", "In Progress");
  assert.equal(updated.state, "In Progress");
  assert.equal(updated.stateType, "started");
  assert.equal(updated.description, "Details here");
});

test("updateStatus rejects a blank status and leaves the file intact", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "Keep me", body: "Details here", status: "Todo" });
  const before = await readFile(path.join(dir, "BOARD-1.md"), "utf8");

  // A whitespace-only status would corrupt the file (parse() drops a status-less issue),
  // so it must be rejected before any write touches disk.
  await assert.rejects(() => store.updateStatus("BOARD-1", "   "), /status/);

  // The file is byte-for-byte unchanged and the issue still lists with its prior status.
  assert.equal(await readFile(path.join(dir, "BOARD-1.md"), "utf8"), before);
  const issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.state, "Todo");
  assert.deepEqual(
    (await store.list()).map((i) => i.identifier),
    ["BOARD-1"],
  );
});

test("appendComment adds a Comments section without touching description", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "T", body: "Desc", status: "Todo" });

  await store.appendComment("BOARD-1", "opened PR #42", () => new Date("2026-05-29T10:00:00Z"));
  await store.appendComment("BOARD-1", "checks green", () => new Date("2026-05-29T11:00:00Z"));

  const issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.description, "Desc");
  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /## Comments/);
  assert.match(file, /- 2026-05-29T10:00:00.000Z agent: opened PR #42/);
  assert.match(file, /- 2026-05-29T11:00:00.000Z agent: checks green/);
});

test("byStatus filters case-insensitively; getByIds preserves order and skips missing", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "One", status: "Todo" });
  await store.create({ title: "Two", status: "Done" });
  await store.create({ title: "Three", status: "in progress" });

  const active = await store.byStatus(["todo", "In Progress"]);
  assert.deepEqual(active.map((i) => i.identifier).sort(), ["BOARD-1", "BOARD-3"]);

  const byId = await store.getByIds(["BOARD-2", "BOARD-404", "BOARD-1"]);
  assert.deepEqual(
    byId.map((i) => i.identifier),
    ["BOARD-2", "BOARD-1"],
  );
});

test("labels parse from frontmatter and lower-case; title falls back to id", async () => {
  const dir = await tempBoard();
  await writeFile(
    path.join(dir, "BOARD-7.md"),
    "---\nstatus: Todo\nlabels:\n  - Backend\n  - Symphony:API\n---\n\nNo heading body\n",
    "utf8",
  );
  const store = new BoardStore(dir);
  const issue = (await store.getByIds(["BOARD-7"]))[0]!;
  assert.deepEqual(issue.labels, ["backend", "symphony:api"]);
  assert.equal(issue.title, "BOARD-7");
  assert.equal(issue.description, "No heading body");
});

test("missing status throws a clear error", async () => {
  const dir = await tempBoard();
  await writeFile(path.join(dir, "BOARD-9.md"), "---\nlabels: []\n---\n# T\n", "utf8");
  const store = new BoardStore(dir);
  await assert.rejects(() => store.getByIds(["BOARD-9"]), /BOARD-9.*status/);
});

test("list skips malformed files, reports them via onSkip, and returns the valid ones", async () => {
  const dir = await tempBoard();
  // A valid issue, a frontmatter-without-status issue, and an unparseable-YAML issue.
  await writeFile(
    path.join(dir, "BOARD-1.md"),
    "---\nstatus: Todo\n---\n# Valid\n\nBody\n",
    "utf8",
  );
  await writeFile(path.join(dir, "BOARD-2.md"), "---\nlabels: []\n---\n# No status\n", "utf8");
  await writeFile(
    path.join(dir, "BOARD-3.md"),
    "---\nstatus: [unterminated\n---\n# Bad YAML\n",
    "utf8",
  );

  const skipped: { id: string; error: string }[] = [];
  const store = new BoardStore(dir, { onSkip: (s) => skipped.push(s) });

  const issues = await store.list();
  // Only the valid file is returned; the two malformed files are skipped, not thrown.
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["BOARD-1"],
  );

  // Both malformed files are surfaced (observable), not silently hidden.
  assert.deepEqual(skipped.map((s) => s.id).sort(), ["BOARD-2", "BOARD-3"]);
  const missingStatus = skipped.find((s) => s.id === "BOARD-2")!;
  assert.match(missingStatus.error, /status/);

  // byStatus rides on the same resilient listing.
  const active = await store.byStatus(["Todo"]);
  assert.deepEqual(
    active.map((i) => i.identifier),
    ["BOARD-1"],
  );
});

test("getByIds stays strict: an explicitly-requested malformed id still throws", async () => {
  const dir = await tempBoard();
  await writeFile(path.join(dir, "BOARD-1.md"), "---\nstatus: Todo\n---\n# Valid\n", "utf8");
  await writeFile(path.join(dir, "BOARD-2.md"), "---\nlabels: []\n---\n# No status\n", "utf8");

  const skipped: { id: string; error: string }[] = [];
  const store = new BoardStore(dir, { onSkip: (s) => skipped.push(s) });

  // Explicitly asking for the bad id surfaces the error rather than skipping it.
  await assert.rejects(() => store.getByIds(["BOARD-2"]), /BOARD-2.*status/);
  // A strict fetch never routes through onSkip.
  assert.equal(skipped.length, 0);

  // A valid explicit fetch still works.
  const ok = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(ok.identifier, "BOARD-1");
});

test("description containing a literal '## Comments' heading survives round-trips", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  const body = "Intro\n## Comments\nplease comment";
  await store.create({ title: "T", body, status: "Todo" });

  let issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.description, body);

  await store.appendComment("BOARD-1", "real agent note", () => new Date("2026-05-29T10:00:00Z"));
  await store.updateStatus("BOARD-1", "In Progress");

  issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.description, body);
  assert.equal(issue.state, "In Progress");

  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /- 2026-05-29T10:00:00.000Z agent: real agent note/);
});

test("rejects path-traversal and malformed issue ids without touching the filesystem", async () => {
  // Nest the board under a private parent (not the shared os.tmpdir()) so the "parent dir is
  // unchanged" assertion below only observes this test's files. Comparing the shared tmpdir
  // listing would flake whenever a concurrent test creates a temp dir there mid-run.
  const parent = await mkdtemp(path.join(tmpdir(), "board-traversal-"));
  const dir = path.join(parent, "board");
  await mkdir(dir, { recursive: true });
  const store = new BoardStore(dir);
  await store.create({ title: "Valid", body: "Body", status: "Todo" });

  const before = (await readdir(dir)).sort();
  // Capture a marker file outside the board dir so we can prove nothing escaped.
  const sentinel = path.join(parent, "outside-marker.txt");
  await writeFile(sentinel, "untouched", "utf8");
  const sentinelBefore = await readFile(sentinel, "utf8");
  const parentBefore = (await readdir(parent)).sort();

  const badIds = ["../../etc/passwd", "BOARD-1/../x", "foo", "", "BOARD-1/../../outside-marker"];
  for (const id of badIds) {
    await assert.rejects(() => store.updateStatus(id, "Done"), /invalid.*id|BOARD/i);
    await assert.rejects(() => store.appendComment(id, "x"), /invalid.*id|BOARD/i);
    await assert.rejects(() => store.getByIds([id]), /invalid.*id|BOARD/i);
  }

  // No file created or removed outside the board dir, and the board itself is unchanged.
  assert.deepEqual((await readdir(dir)).sort(), before);
  assert.equal(await readFile(sentinel, "utf8"), sentinelBefore);
  // The parent dir gained or lost nothing (the rejected ids never reached the filesystem).
  assert.deepEqual((await readdir(parent)).sort(), parentBefore);

  // A valid id still works end to end.
  const ok = await store.updateStatus("BOARD-1", "In Progress");
  assert.equal(ok.state, "In Progress");
  await store.appendComment("BOARD-1", "still works", () => new Date("2026-05-29T12:00:00Z"));
  const fetched = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(fetched.identifier, "BOARD-1");
});

test("write leaves no temporary file behind (atomic rename)", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "Atomic", body: "Body", status: "Todo" });
  await store.updateStatus("BOARD-1", "In Progress");
  await store.appendComment("BOARD-1", "note", () => new Date("2026-05-29T10:00:00Z"));

  const entries = (await readdir(dir)).sort();
  // The only artifact is the final issue file; no *.tmp / *.<pid> scratch files remain.
  assert.deepEqual(entries, ["BOARD-1.md"]);
  const issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.state, "In Progress");
});

test("create never overwrites a pre-existing higher id and stays collision-safe", async () => {
  const dir = await tempBoard();
  // Seed a hand-authored BOARD-3 directly on disk.
  await writeFile(
    path.join(dir, "BOARD-3.md"),
    "---\nstatus: Todo\n---\n\n# Seeded\n\nDo not clobber\n",
    "utf8",
  );
  const store = new BoardStore(dir);

  const created = await store.create({ title: "Next", status: "Todo" });
  assert.equal(created.identifier, "BOARD-4");

  // The seeded file is untouched.
  const seeded = await readFile(path.join(dir, "BOARD-3.md"), "utf8");
  assert.match(seeded, /# Seeded/);
  assert.match(seeded, /Do not clobber/);
});

test("concurrent create calls allocate unique ids without losing writes", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);

  // Fire many creates at once: the wx exclusive-create + retry path must keep ids unique.
  const results = await Promise.all(
    Array.from({ length: 12 }, (_unused, i) =>
      store.create({ title: `Task ${i}`, status: "Todo" }),
    ),
  );
  const ids = results.map((r) => r.identifier).sort();
  const unique = new Set(ids);
  assert.equal(unique.size, results.length, `expected unique ids, got ${ids.join(",")}`);

  // Every create produced exactly one file on disk; nothing was overwritten.
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  assert.equal(files.length, results.length);
  for (const id of ids) {
    const fileStat = await stat(path.join(dir, `${id}.md`));
    assert.equal(fileStat.isFile(), true);
  }
});

test("CRLF board files parse with clean status and description", async () => {
  const dir = await tempBoard();
  const raw = ["---", "status: In Progress", "---", "", "# Title", "", "Body line"].join("\r\n");
  await writeFile(path.join(dir, "BOARD-3.md"), `${raw}\r\n`, "utf8");
  const store = new BoardStore(dir);
  const issue = (await store.getByIds(["BOARD-3"]))[0]!;
  assert.equal(issue.state, "In Progress");
  assert.equal(issue.stateType, "started");
  assert.equal(issue.description, "Body line");
});
