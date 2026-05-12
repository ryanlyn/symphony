import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliArgs, projectUrlForSettings, usageText } from "../src/cli.js";
import { parseConfig } from "../src/config.js";

test("CLI accepts Elixir-compatible workflow path and TS runtime flags", () => {
  assert.deepEqual(
    parseCliArgs(["--once", "--dry-run", "--no-tui", "--port", "4100", "WORKFLOW_FULL_ACCESS.md"]),
    {
      status: "ok",
      options: {
        workflowPath: "WORKFLOW_FULL_ACCESS.md",
        once: true,
        dryRun: true,
        tui: false,
        port: 4100,
        logsRoot: null,
      },
    },
  );
});

test("CLI defaults to a TUI daemon when only workflow path is supplied", () => {
  assert.deepEqual(parseCliArgs(["WORKFLOW.md"]), {
    status: "ok",
    options: {
      workflowPath: "WORKFLOW.md",
      once: false,
      dryRun: false,
      tui: true,
      port: null,
      logsRoot: null,
    },
  });
  assert.deepEqual(parseCliArgs(["--logs-root", "tmp/custom-logs", "--port", "0", "WORKFLOW.md"]), {
    status: "ok",
    options: {
      workflowPath: "WORKFLOW.md",
      once: false,
      dryRun: false,
      tui: true,
      port: 0,
      logsRoot: "tmp/custom-logs",
    },
  });
});

test("CLI reports help and invalid arguments", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { status: "help", message: usageText });
  assert.deepEqual(parseCliArgs(["one.md", "two.md"]), {
    status: "error",
    message: usageText,
  });
  assert.deepEqual(parseCliArgs(["--port", "-1"]), {
    status: "error",
    message: "--port must be a non-negative integer",
  });
  assert.deepEqual(parseCliArgs(["--logs-root"]), {
    status: "error",
    message: "--logs-root requires a path",
  });
});

test("CLI dashboard options derive project URL from tracker project slug", () => {
  assert.equal(
    projectUrlForSettings(parseConfig({ tracker: { project_slug: "mono dev" } })),
    "https://linear.app/project/mono%20dev/issues",
  );
  assert.equal(projectUrlForSettings(parseConfig()), undefined);
});
