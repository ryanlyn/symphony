/**
 * Minimal debug script that exercises JiraClient.searchIssues directly.
 *
 * Usage:
 *   JIRA_BASE_URL=https://xxx.atlassian.net JIRA_EMAIL=you@co.com JIRA_API_TOKEN=xxx npx tsx debug-jira-client.ts [jql]
 */

import { JiraClient } from "./extensions/jira-tracker/src/client.js";
import type { Settings } from "@lorenz/domain";

const BASE_URL = process.env.JIRA_BASE_URL?.replace(/\/+$/, "");
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

if (!BASE_URL || !EMAIL || !TOKEN) {
  console.error("Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
  process.exit(1);
}

const JQL =
  process.argv[2] ??
  'project = MARAU AND labels = "acai" AND labels = "agent" AND assignee = currentUser() ORDER BY created DESC';

// Build a minimal Settings object that satisfies the client
const settings: Settings = {
  tracker: {
    kind: "jira",
    apiKey: TOKEN,
    assignee: "me",
    activeStates: ["In Progress", "Testing", "Review", "Ready to Ship", "Shaping", "Rollout", "Refining", "Ready"],
    terminalStates: [],
    dispatch: { maxConcurrency: 1, strategy: "priority" } as any,
    options: {
      baseUrl: BASE_URL,
      email: EMAIL,
      projectKeys: ["MARAU"],
    },
  },
  polling: { intervalMs: 60000 },
  workspace: {} as any,
  worker: {} as any,
  hooks: {} as any,
  agent: {} as any,
  agents: {},
  observability: {} as any,
  server: {} as any,
  logging: {} as any,
  statusOverrides: new Map(),
};

const client = new JiraClient(settings);

// Replicate candidateJql logic to show what the runtime would query
function showCandidateJql() {
  const parts: string[] = [];
  const jql = (settings.tracker.options as any).jql?.trim();
  const projectKeys = (settings.tracker.options as any).projectKeys ?? [];
  if (jql) {
    parts.push(`(${jql})`);
  } else if (projectKeys.length > 0) {
    parts.push(`project in (${projectKeys.map((k: string) => `"${k}"`).join(", ")})`);
  }
  if (settings.tracker.activeStates.length > 0) {
    parts.push(`status in (${settings.tracker.activeStates.map((s: string) => `"${s}"`).join(", ")})`);
  }
  const assignee = settings.tracker.assignee?.trim();
  parts.push(!assignee || assignee.toLowerCase() === "me" ? "assignee = currentUser()" : `assignee = "${assignee}"`);
  parts.push(`labels = "agent"`);
  return parts.join(" AND ");
}

async function main() {
  console.log("=== JiraClient.searchIssues (custom JQL) ===");
  console.log("JQL:", JQL);
  console.log();

  try {
    const issues = await client.searchIssues(JQL);
    console.log(`Found ${issues.length} issues:`);
    for (const issue of issues) {
      console.log(`  ${issue.identifier} - ${issue.title} [${issue.state}]`);
    }
  } catch (err) {
    console.error("searchIssues failed:", err);
  }

  console.log();
  console.log("=== JiraClient.fetchCandidateIssues ===");
  const candidateJql = showCandidateJql();
  console.log("Candidate JQL:", candidateJql);
  console.log();
  try {
    const candidates = await client.fetchCandidateIssues();
    console.log(`Found ${candidates.length} candidates:`);
    for (const issue of candidates) {
      console.log(`  ${issue.identifier} - ${issue.title} [${issue.state}]`);
    }
  } catch (err) {
    console.error("fetchCandidateIssues failed:", err);
  }
}

main();
