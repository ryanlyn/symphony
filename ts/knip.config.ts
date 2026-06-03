import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: ["test/**/*.test.ts", "sandbox/**/*.ts"],
      ignoreDependencies: [
        "@symphony/dispatch",
        "@symphony/humanize",
        "@symphony/mcp",
        "@symphony/memory-tracker",
        "@symphony/orchestrator",
        "@symphony/policies",
        "@symphony/projections",
        "@symphony/retry-scheduler",
        "@symphony/runtime-events",
        "@symphony/ssh",
        "@symphony/tui",
        "@symphony/worker-host-pool",
        "@symphony/workflow",
        "@symphony/workspace",
      ],
    },
    "apps/cli": {
      entry: ["src/bin/cli.ts"],
    },
    "apps/symphony-dashboard": {
      entry: ["src/main.tsx"],
    },
    "packages/*": {
      entry: ["src/index.{ts,tsx}"],
    },
  },
  ignoreDependencies: ["tsx"],
  ignoreBinaries: ["op"],
  ignore: ["sandbox/**"],
};

export default config;
