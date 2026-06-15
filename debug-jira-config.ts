/**
 * Debug: parse the workflow file, create a real JiraClient, and call fetchCandidateIssues.
 *
 * Usage:
 *   JIRA_API_KEY=xxx npx tsx debug-jira-config.ts /home/coder/WORKFLOW_jira.md
 */

import { loadWorkflow } from "./packages/workflow/src/index.js";
import { registerJiraTrackers } from "./extensions/jira-tracker/src/register.js";
import { JiraClient } from "./extensions/jira-tracker/src/client.js";

registerJiraTrackers();

const workflowPath = process.argv[2] ?? "/home/coder/WORKFLOW_jira.md";

async function main() {
  const workflow = await loadWorkflow(workflowPath);
  const { tracker } = workflow.settings;

  console.log("=== Resolved tracker settings ===");
  console.log("kind:", tracker.kind);
  console.log("assignee:", tracker.assignee);
  console.log("apiKey (resolved):", tracker.apiKey ? `${tracker.apiKey.slice(0, 6)}...${tracker.apiKey.slice(-4)} (${tracker.apiKey.length} chars)` : "UNDEFINED");
  console.log("apiKey starts with op://:", tracker.apiKey?.startsWith("op://") ?? "N/A");
  console.log("JIRA_API_KEY env raw:", process.env.JIRA_API_KEY ? `${process.env.JIRA_API_KEY.slice(0, 10)}... (${process.env.JIRA_API_KEY.length} chars)` : "NOT SET");
  console.log("JIRA_API_TOKEN env:", process.env.JIRA_API_TOKEN ? `${process.env.JIRA_API_TOKEN.slice(0, 6)}...${process.env.JIRA_API_TOKEN.slice(-4)} (${process.env.JIRA_API_TOKEN.length} chars)` : "NOT SET");
  console.log("apiKey === JIRA_API_TOKEN:", tracker.apiKey === process.env.JIRA_API_TOKEN);
  console.log("activeStates:", tracker.activeStates);
  console.log("terminalStates:", tracker.terminalStates);
  console.log("options:", JSON.stringify(tracker.options, null, 2));

  // Replicate candidateJql
  const parts: string[] = [];
  const jql = (tracker.options as any).jql?.trim();
  const projectKeys = (tracker.options as any).projectKeys ?? [];
  if (jql) {
    parts.push(`(${jql})`);
  } else if (projectKeys.length > 0) {
    parts.push(`project in (${projectKeys.map((k: string) => `"${k}"`).join(", ")})`);
  }
  if (tracker.activeStates.length > 0) {
    parts.push(`status in (${tracker.activeStates.map((s: string) => `"${s}"`).join(", ")})`);
  }
  const assignee = tracker.assignee?.trim();
  parts.push(!assignee || assignee.toLowerCase() === "me" ? "assignee = currentUser()" : `assignee = "${assignee}"`);
  parts.push(`labels = "agent"`);
  const candidateJql = parts.join(" AND ");

  console.log("\n=== Candidate JQL ===");
  console.log(candidateJql);

  // Actually run it against Jira
  console.log("\n=== Running fetchCandidateIssues with real client ===");
  const client = new JiraClient(workflow.settings);
  try {
    const issues = await client.fetchCandidateIssues();
    console.log(`Found ${issues.length} candidates:`);
    for (const issue of issues) {
      console.log(`  ${issue.identifier} - ${issue.title} [${issue.state}]`);
    }
  } catch (err) {
    console.error("fetchCandidateIssues failed:", err);
  }

  // Also try the raw JQL directly
  console.log("\n=== Running searchIssues with candidate JQL directly ===");
  try {
    const issues = await client.searchIssues(candidateJql);
    console.log(`Found ${issues.length} issues:`);
    for (const issue of issues) {
      console.log(`  ${issue.identifier} - ${issue.title} [${issue.state}]`);
    }
  } catch (err) {
    console.error("searchIssues failed:", err);
  }

  // Progressive narrowing: which clause kills it?
  const narrowing = [
    { label: "base jql only", jql: `project = MARAU AND labels = "acai" AND labels = "agent" AND assignee = currentUser()` },
    { label: "+ status in (Ready)", jql: `project = MARAU AND labels = "acai" AND labels = "agent" AND assignee = currentUser() AND status = "Ready"` },
    { label: "+ status in (full list)", jql: `project = MARAU AND labels = "acai" AND labels = "agent" AND assignee = currentUser() AND status in ("In Progress", "Testing", "Review", "Ready", "Ready to Ship", "Shaping", "Rollout", "Refining")` },
    { label: "base + labels=agent (no acai)", jql: `project = MARAU AND labels = "agent" AND assignee = currentUser()` },
    { label: "just issue key", jql: `key = MARAU-483` },
  ];

  console.log("\n=== Progressive narrowing ===");
  for (const { label, jql: testJql } of narrowing) {
    try {
      const issues = await client.searchIssues(testJql);
      console.log(`[${label}] → ${issues.length} issues${issues.length > 0 ? `: ${issues.map(i => `${i.identifier} [${i.state}]`).join(", ")}` : ""}`);
    } catch (err: any) {
      console.log(`[${label}] → ERROR: ${err.message?.slice(0, 200)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
