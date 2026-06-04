/**
 * Trace routes for the unified dashboard.
 *
 * Exposes ticket/event/stats data from TraceWatcher via REST endpoints.
 * Issue metadata (title, url) comes from a local SQLite store rather than trace files.
 */

import { Hono } from "hono";
import { TraceWatcher, computeStats } from "@symphony/traceviz-server";

import type { IssueStore } from "./issue-store.js";

export interface TraceRoutesResult {
  app: Hono;
  watcher: TraceWatcher;
}

/**
 * Creates a Hono sub-app exposing trace routes and a TraceWatcher instance.
 *
 * The caller can wire the watcher's callback to WebSocket broadcast externally.
 */
export function createTraceRoutes(traceDir: string, issueStore: IssueStore): TraceRoutesResult {
  const watcher = new TraceWatcher(traceDir);
  const app = new Hono();

  app.get("/api/v1/tickets", (c) => {
    const tickets = watcher.getTickets().map((t) => {
      const record = issueStore.get(t.issueId);
      return {
        ...t,
        ...(record && { title: record.title, url: record.url }),
      };
    });
    return c.json({ tickets });
  });

  app.get("/api/v1/tickets/:id/events", (c) => {
    const issueId = decodeURIComponent(c.req.param("id"));
    const events = watcher.getEventsForTicket(issueId);
    const tickets = watcher.getTickets();
    const ticket = tickets.find((t) => t.issueId === issueId);
    const record = issueStore.get(issueId);
    return c.json({
      issueId,
      identifier: record?.issueIdentifier ?? ticket?.identifier ?? issueId,
      events,
    });
  });

  app.get("/api/v1/tickets/:id/stats", (c) => {
    const issueId = decodeURIComponent(c.req.param("id"));
    const events = watcher.getEventsForTicket(issueId);
    return c.json(computeStats(events));
  });

  return { app, watcher };
}
