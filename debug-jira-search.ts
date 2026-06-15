/**
 * Debug script: test Jira search/jql endpoint directly.
 *
 * Usage:
 */

const BASE_URL = process.env.JIRA_BASE_URL?.replace(/\/+$/, "");
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

if (!BASE_URL || !EMAIL || !TOKEN) {
  console.error("Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;
const JQL = process.argv[2] ??
  '(project = MARAU AND labels = "acai" AND labels = "agent") AND status in ("In Progress", "Testing", "Review", "Ready to Ship", "Testing", "Shaping", "Rollout", "Refining") AND assignee = currentUser() AND labels = "agent"';
const MAX_RESULTS = 50;
const FIELDS = ["summary", "description", "status", "labels", "issuelinks", "assignee", "priority", "created", "updated"];

async function tryPost() {
  console.log("\n=== POST /rest/api/3/search/jql ===");
  const url = `${BASE_URL}/rest/api/3/search/jql`;
  const body = JSON.stringify({ jql: JQL, maxResults: MAX_RESULTS, fields: FIELDS });
  console.log("URL:", url);
  console.log("Body:", body);
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: AUTH },
    body,
  });
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text.slice(0, 2000));
  return { status: res.status, text };
}

async function tryGet() {
  console.log("\n=== GET /rest/api/3/search/jql ===");
  const params = new URLSearchParams({ jql: JQL, maxResults: String(MAX_RESULTS), fields: FIELDS.join(",") });
  const url = `${BASE_URL}/rest/api/3/search/jql?${params}`;
  console.log("URL:", url);
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", authorization: AUTH },
  });
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text.slice(0, 2000));
  return { status: res.status, text };
}

async function tryLegacyPost() {
  console.log("\n=== POST /rest/api/3/search (legacy) ===");
  const url = `${BASE_URL}/rest/api/3/search`;
  const body = JSON.stringify({ jql: JQL, maxResults: MAX_RESULTS, fields: FIELDS, startAt: 0 });
  console.log("URL:", url);
  console.log("Body:", body);
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: AUTH },
    body,
  });
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text.slice(0, 2000));
  return { status: res.status, text };
}

async function tryLegacyGet() {
  console.log("\n=== GET /rest/api/3/search (legacy) ===");
  const params = new URLSearchParams({ jql: JQL, maxResults: String(MAX_RESULTS), fields: FIELDS.join(",") });
  const url = `${BASE_URL}/rest/api/3/search?${params}`;
  console.log("URL:", url);
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", authorization: AUTH },
  });
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text.slice(0, 2000));
  return { status: res.status, text };
}

async function tryCurrentUser() {
  console.log("\n=== GET /rest/api/3/myself ===");
  const url = `${BASE_URL}/rest/api/3/myself`;
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", authorization: AUTH },
  });
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text.slice(0, 1000));
  return { status: res.status, text };
}

async function trySimpleSearch() {
  console.log("\n=== Simple search: project = MARAU ===");
  const simpleJql = 'project = MARAU AND labels = "acai" AND labels = "agent" AND assignee = currentUser() ORDER BY created DESC';
  const params = new URLSearchParams({ jql: simpleJql, maxResults: "5", fields: FIELDS.join(",") });

  // Try GET on new endpoint
  const url = `${BASE_URL}/rest/api/3/search/jql?${params}`;
  console.log("GET", url);
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", authorization: AUTH },
  });
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text.slice(0, 2000));
}

(async () => {

  // Try a simple search to rule out JQL issues
  await trySimpleSearch();

})();
