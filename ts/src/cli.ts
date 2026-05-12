import React from "react";
import path from "node:path";
import { render } from "ink";
import { validateDispatchConfig } from "./config.js";
import { startObservabilityServer, type ObservabilityServerHandle } from "./httpServer.js";
import { configureLogFile } from "./logFile.js";
import { SymphonyRuntime } from "./runtime.js";
import { runRunsCommand, runsUsageText } from "./runsCommand.js";
import { RuntimeApp } from "./tui.js";
import { loadWorkflow } from "./workflow.js";
import type { Settings, WorkflowDefinition } from "./types.js";

export const usageText = `Usage: symphony-ts [--once] [--dry-run] [--no-tui] [--logs-root <path>] [--port <port>] [path-to-WORKFLOW.md]\n       ${runsUsageText}`;

export interface CliOptions {
  workflowPath: string | null;
  once: boolean;
  dryRun: boolean;
  tui: boolean;
  port: number | null;
  logsRoot: string | null;
}

export type CliParseResult =
  | { status: "ok"; options: CliOptions }
  | { status: "help"; message: string }
  | { status: "error"; message: string };

export function parseCliArgs(args: string[]): CliParseResult {
  const options: CliOptions = {
    workflowPath: null,
    once: false,
    dryRun: false,
    tui: true,
    port: null,
    logsRoot: null,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { status: "help", message: usageText };
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-tui") {
      options.tui = false;
      continue;
    }
    if (arg === "--port") {
      const value = args[index + 1];
      index += 1;
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0)
        return { status: "error", message: "--port must be a non-negative integer" };
      options.port = port;
      continue;
    }
    if (arg === "--logs-root") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined || value.trim() === "")
        return { status: "error", message: "--logs-root requires a path" };
      options.logsRoot = value;
      continue;
    }
    if (arg?.startsWith("--")) return { status: "error", message: `Unknown option: ${arg}` };
    if (arg !== undefined) positional.push(arg);
  }

  if (positional.length > 1) return { status: "error", message: usageText };
  options.workflowPath = positional[0] ?? null;
  return { status: "ok", options };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args[0] === "runs") {
    try {
      process.stdout.write(await runRunsCommand(args.slice(1)));
      return 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const parsed = parseCliArgs(args);
  if (parsed.status === "help") {
    process.stdout.write(`${parsed.message}\n`);
    return 0;
  }
  if (parsed.status === "error") {
    process.stderr.write(`${parsed.message}\n`);
    return 1;
  }

  try {
    let boundServerPort: number | null = null;
    const loadRuntimeWorkflow = async () => {
      const workflow = await loadWorkflow(parsed.options.workflowPath ?? undefined);
      applyCliOverrides(workflow, parsed.options);
      if (boundServerPort !== null) workflow.settings.server.port = boundServerPort;
      validateDispatchConfig(workflow.settings);
      return workflow;
    };
    const workflow = await loadRuntimeWorkflow();
    await configureLogFile(workflow.settings.logging.logFile);

    const runtime = new SymphonyRuntime({
      workflow,
      reloadWorkflow: loadRuntimeWorkflow,
    });
    let server: ObservabilityServerHandle | null = null;
    const stop = () => runtime.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    const shouldStartServer =
      typeof workflow.settings.server.port === "number" ||
      workflow.settings.agent.kind === "claude";
    if (shouldStartServer) {
      server = await startObservabilityServer(runtime, {
        host: workflow.settings.server.host,
        port: workflow.settings.server.port ?? 0,
      });
      workflow.settings.server.port = server.port;
      boundServerPort = server.port;
      process.stderr.write(`Observability API listening on ${server.url("/")}\n`);
    }

    const instance =
      parsed.options.tui && process.stdout.isTTY
        ? render(
            React.createElement(RuntimeApp, {
              runtime,
              dashboardUrl: server?.url("/") ?? null,
              projectUrl: projectUrlForSettings(workflow.settings),
            }),
          )
        : null;

    if (!instance) {
      runtime.subscribe((snapshot) => {
        process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      });
    }

    try {
      await runtime.start({ once: parsed.options.once, dryRun: parsed.options.dryRun });
    } finally {
      instance?.unmount();
      await server?.stop();
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function applyCliOverrides(workflow: WorkflowDefinition, options: CliOptions): void {
  if (options.port !== null) workflow.settings.server.port = options.port;
  if (options.logsRoot !== null) {
    workflow.settings.logging.logFile = path.join(
      path.resolve(options.logsRoot),
      "log",
      "symphony.log",
    );
  }
}

export function projectUrlForSettings(settings: Settings): string | undefined {
  const slug = settings.tracker.projectSlug?.trim();
  if (!slug) return undefined;
  return `https://linear.app/project/${encodeURIComponent(slug)}/issues`;
}
