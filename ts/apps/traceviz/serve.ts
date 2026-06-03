/**
 * Standalone trace viewer: reads a JSONL trace file and serves
 * the dashboard UI with the parsed events.
 *
 * Usage:
 *   pnpm traceviz path/to/trace.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { parseTraceLines, extractTicketMetadata, computeStats } from "@symphony/traceviz-server";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: pnpm traceviz <path-to-trace.jsonl>");
  process.exit(1);
}

const resolved = path.resolve(filePath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

const content = fs.readFileSync(resolved, "utf-8");
const lines = content.split("\n").filter((l) => l.trim().length > 0);
const events = parseTraceLines(lines);
const metadata = extractTicketMetadata(lines);
const stats = computeStats(events);

const issueId = metadata?.issueId ?? path.basename(resolved, ".jsonl");
const identifier = metadata?.issueIdentifier ?? path.basename(resolved, ".jsonl");

const app = new Hono();

app.get("/api/v1/tickets", (c) => {
  return c.json({
    tickets: [
      {
        issueId,
        identifier,
        turnCount: events.filter((e) => e.kind === "turn_started").length,
        status: "completed" as const,
        startedAt: events[0]?.timestamp,
      },
    ],
  });
});

app.get("/api/v1/tickets/:id/events", (c) => {
  return c.json({ events });
});

app.get("/api/v1/tickets/:id/stats", (c) => {
  return c.json(stats);
});

app.get("/health", (c) => c.json({ status: "ok" }));

const API_PORT = 4040;

serve({ fetch: app.fetch, port: API_PORT }, () => {
  console.log(`Trace: ${resolved} (${events.length} events)`);
  console.log();
  console.log(`  UI:  http://localhost:5173/#/trace/${encodeURIComponent(issueId)}`);
  console.log(`  API: http://localhost:${API_PORT}`);
  console.log();
});

const dashboardDir = path.resolve(import.meta.dirname, "../symphony-dashboard");
const vite = spawn("npx", ["vite", "--open", `--open=#/trace/${encodeURIComponent(issueId)}`], {
  cwd: dashboardDir,
  stdio: "inherit",
  env: { ...process.env },
});

vite.on("error", (err) => {
  console.error(`Vite failed to start: ${err.message}`);
  console.log(
    `API is still running — open http://localhost:5173/#/trace/${encodeURIComponent(issueId)} manually after starting the dashboard with: pnpm dashboard:ui`,
  );
});

vite.on("close", (code) => {
  if (code !== 0) {
    console.log(`Vite exited with code ${code}. API still running at http://localhost:${API_PORT}`);
    console.log(`Start the dashboard manually: pnpm dashboard:ui`);
    return;
  }
  process.exit(0);
});

process.on("SIGINT", () => {
  vite.kill("SIGINT");
  process.exit(0);
});
