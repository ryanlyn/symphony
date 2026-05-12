import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { configureLogFile, defaultLogFile } from "../src/index.js";
import { tempDir } from "./helpers.js";

test("log file configuration uses Elixir-compatible default path and rotates old files", async () => {
  const root = await tempDir("symphony-ts-log-file");
  const logFile = defaultLogFile(root);
  assert.equal(logFile, path.join(root, "log", "symphony.log"));

  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(logFile, "0123456789");
  await fs.writeFile(`${logFile}.1`, "old-one");

  await configureLogFile(logFile, {
    maxBytes: 5,
    maxFiles: 2,
    now: () => new Date("2026-05-06T00:00:00.000Z"),
  });

  assert.equal(await fs.readFile(`${logFile}.1`, "utf8"), "0123456789");
  assert.equal(await fs.readFile(`${logFile}.2`, "utf8"), "old-one");
  assert.match(await fs.readFile(logFile, "utf8"), /symphony_ts_started/);
});

test("log file configuration warns without crashing when the sink is unavailable", async () => {
  const root = await tempDir("symphony-ts-log-file-blocked");
  const blocker = path.join(root, "blocked");
  await fs.writeFile(blocker, "not a directory");

  await configureLogFile(path.join(blocker, "symphony.log"));
});
