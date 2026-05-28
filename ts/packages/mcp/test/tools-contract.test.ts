import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, test } from "vitest";
import { executeTool, FsTrackerClient, parseConfig, toolSpecs } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

test("linear_graphql tool validates name, input, and API key before network", async () => {
  const settings = parseConfig({ tracker: { project_slug: "mono" } }, {});
  const calls: unknown[] = [];
  const fetchImpl = (async () => {
    calls.push("called");
    return jsonResponse({ data: {} });
  }) as typeof fetch;

  assert.deepEqual(await executeTool("unknown", {}, settings, fetchImpl), {
    success: false,
    error: "Unsupported tool.",
    result: {
      error: {
        message: "Unsupported tool.",
        supportedTools: ["linear_graphql"],
      },
    },
  });
  assert.deepEqual(await executeTool("linear_graphql", {}, settings, fetchImpl), {
    success: false,
    error: "`linear_graphql` requires a non-empty `query` string.",
    result: {
      error: {
        message: "`linear_graphql` requires a non-empty `query` string.",
      },
    },
  });
  assert.deepEqual(
    await executeTool("linear_graphql", "query { viewer { id } }", settings, fetchImpl),
    {
      success: false,
      error:
        "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
      result: {
        error: {
          message:
            "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
        },
      },
    },
  );
  assert.deepEqual(
    await executeTool("linear_graphql", { query: "query { viewer { id } }" }, settings, fetchImpl),
    {
      success: false,
      error:
        "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
      result: {
        error: {
          message:
            "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
        },
      },
    },
  );
  assert.equal(calls.length, 0);
});

test("linear_graphql tool rejects non-object variables instead of silently dropping them", async () => {
  assert.deepEqual(
    await executeTool(
      "linear_graphql",
      { query: "query { viewer { id } }", variables: [] },
      linearSettings(),
    ),
    {
      success: false,
      error: "`linear_graphql.variables` must be a JSON object when provided.",
      result: {
        error: {
          message: "`linear_graphql.variables` must be a JSON object when provided.",
        },
      },
    },
  );
});

test("linear_graphql tool accepts null variables and rejects blank queries", async () => {
  assert.deepEqual(
    await executeTool("linear_graphql", { query: "   ", variables: null }, linearSettings()),
    {
      success: false,
      error: "`linear_graphql` requires a non-empty `query` string.",
      result: {
        error: {
          message: "`linear_graphql` requires a non-empty `query` string.",
        },
      },
    },
  );

  const calls: Array<Record<string, unknown>> = [];
  const result = await executeTool(
    "linear_graphql",
    { query: "query { viewer { id } }", variables: null },
    linearSettings(),
    (async (_input, init) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({ data: { viewer: { id: "viewer-1" } } });
    }) as typeof fetch,
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls[0]?.variables, {});
});

test("linear_graphql tool treats GraphQL errors as failed operations on 200 and 400", async () => {
  const settings = linearSettings();

  assert.deepEqual(
    await executeTool(
      "linear_graphql",
      { query: "query Bad { nope }" },
      settings,
      fetchSequence(jsonResponse({ errors: [{ message: "bad query" }] })),
    ),
    {
      success: false,
      result: { errors: [{ message: "bad query" }] },
    },
  );
  assert.deepEqual(
    await executeTool(
      "linear_graphql",
      { query: "query Bad { nope }" },
      settings,
      fetchSequence(jsonResponse({ errors: [{ message: "bad query" }] }, 400)),
    ),
    {
      success: false,
      result: { errors: [{ message: "bad query" }] },
    },
  );
});

test("linear_graphql tool reports HTTP, invalid JSON, and network failures", async () => {
  const settings = linearSettings();

  assert.deepEqual(
    await executeTool(
      "linear_graphql",
      { query: "query { viewer { id } }" },
      settings,
      fetchSequence(
        jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" }),
        jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" }),
        jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" }),
        jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" }),
        jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" }),
      ),
    ),
    {
      success: false,
      error: "Linear GraphQL request failed with HTTP 429.",
      result: {
        error: {
          message: "Linear GraphQL request failed with HTTP 429.",
          status: 429,
        },
      },
    },
  );
  assert.match(
    (
      await executeTool(
        "linear_graphql",
        { query: "query { viewer { id } }" },
        settings,
        fetchSequence(new Response("not json", { status: 200 })),
      )
    ).error ?? "",
    /linear_invalid_json/,
  );
  assert.match(
    (
      await executeTool(
        "linear_graphql",
        { query: "query { viewer { id } }" },
        settings,
        (async () => {
          throw new Error("socket closed");
        }) as typeof fetch,
      )
    ).error ?? "",
    /Linear GraphQL request failed before receiving a successful response/,
  );
});

test("linear_graphql tool retries 429 responses like the Linear client", async () => {
  const calls: number[] = [];
  const result = await executeTool(
    "linear_graphql",
    { query: "query { viewer { id } }" },
    linearSettings(),
    (async () => {
      calls.push(Date.now());
      return calls.length === 1
        ? jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" })
        : jsonResponse({ data: { viewer: { id: "viewer-1" } } });
    }) as typeof fetch,
  );

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
});

test("linear_graphql tool bounds HTTP requests with the Linear connect timeout", async () => {
  const signals: Array<boolean> = [];
  const result = await executeTool(
    "linear_graphql",
    { query: "query { viewer { id } }" },
    linearSettings(),
    (async (_input, init) => {
      signals.push(init?.signal instanceof AbortSignal);
      return jsonResponse({ data: { viewer: { id: "viewer-1" } } });
    }) as typeof fetch,
  );

  assert.equal(result.success, true);
  assert.deepEqual(signals, [true]);
});

test("linear_graphql tool sends variables through unchanged", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await executeTool(
    "linear_graphql",
    { query: "query Viewer($id: String!) { viewer { id } }", variables: { id: "viewer-1" } },
    linearSettings(),
    (async (_input, init) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({ data: { viewer: { id: "viewer-1" } } });
    }) as typeof fetch,
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls[0], {
    query: "query Viewer($id: String!) { viewer { id } }",
    variables: { id: "viewer-1" },
  });
});

function linearSettings() {
  return parseConfig({ tracker: { api_key: "linear-token", project_slug: "mono" } }, {});
}

let boardDir: string;

beforeEach(async () => {
  boardDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fs-tools-"));
});

afterEach(async () => {
  await fs.rm(boardDir, { recursive: true, force: true });
});

function fsSettings() {
  return parseConfig({ tracker: { kind: "fs", board_dir: boardDir } }, {});
}

async function writeBoardIssue(state: string, identifier: string, title: string): Promise<void> {
  const dir = path.join(boardDir, state);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${identifier}.md`),
    `---\nid: ${identifier.toLowerCase()}\nidentifier: ${identifier}\ntitle: ${title}\n---\n`,
    "utf8",
  );
}

test("toolSpecs returns the fs board tool set when tracker.kind is fs", () => {
  const linear = toolSpecs(parseConfig({ tracker: { api_key: "x", project_slug: "p" } }, {}));
  assert.deepEqual(
    linear.map((spec) => spec.name),
    ["linear_graphql"],
  );

  const fsSet = toolSpecs(fsSettings());
  assert.deepEqual(
    fsSet.map((spec) => spec.name),
    ["board_get", "board_move", "board_comment", "board_update"],
  );

  const memory = toolSpecs(parseConfig({ tracker: { kind: "memory" } }, {}));
  assert.deepEqual(memory, []);
});

test("board_get reads an issue and rejects unknown identifiers", async () => {
  await writeBoardIssue("todo", "ENG-1", "Login page");

  const ok = await executeTool("board_get", { identifier: "ENG-1" }, fsSettings());
  assert.equal(ok.success, true);
  const issue = (ok.result as { issue: { title: string; state: string } }).issue;
  assert.equal(issue.title, "Login page");
  assert.equal(issue.state, "Todo");

  const missing = await executeTool("board_get", { identifier: "MISSING" }, fsSettings());
  assert.equal(missing.success, false);
  assert.match(String(missing.error), /board issue not found/);
});

test("board_move rewrites the file so the next adapter read reflects the new state", async () => {
  await writeBoardIssue("todo", "ENG-1", "Work");
  const client = new FsTrackerClient(boardDir, { activeStates: ["Todo"] });
  assert.equal((await client.fetchCandidateIssues()).length, 1);

  const result = await executeTool(
    "board_move",
    { identifier: "ENG-1", state: "In Progress" },
    fsSettings(),
  );
  assert.equal(result.success, true);
  assert.equal((result.result as { from: string; to: string }).to, "in-progress");

  assert.deepEqual(await client.fetchCandidateIssues(), []);
  const [issue] = await client.fetchIssuesByStates(["In Progress"]);
  assert.equal(issue!.identifier, "ENG-1");
  assert.equal(issue!.state, "In Progress");
  assert.notEqual(issue!.updatedAt, undefined);
});

test("board_move to a terminal state makes the runtime treat the issue as terminal", async () => {
  await writeBoardIssue("todo", "ENG-1", "Work");
  const client = new FsTrackerClient(boardDir, {
    activeStates: ["Todo", "In Progress"],
  });
  const [todo] = await client.fetchIssuesByIds(["eng-1"]);
  assert.equal(todo!.state, "Todo");

  await executeTool("board_move", { identifier: "ENG-1", state: "Done" }, fsSettings());

  assert.deepEqual(await client.fetchCandidateIssues(), []);
  const [done] = await client.fetchIssuesByIds(["eng-1"]);
  assert.equal(done!.state, "Done");
  assert.equal(done!.stateType, null);
});

test("board_comment appends a dated section that the adapter exposes as the description", async () => {
  await writeBoardIssue("in-progress", "ENG-1", "Work");

  const result = await executeTool(
    "board_comment",
    { identifier: "ENG-1", comment: "Halfway done.", author: "codex" },
    fsSettings(),
  );
  assert.equal(result.success, true);

  const client = new FsTrackerClient(boardDir);
  const [issue] = await client.fetchIssuesByIds(["eng-1"]);
  assert.match(String(issue!.description), /Halfway done\./);
  assert.match(String(issue!.description), /## Comment — .* \(codex\)/);
  assert.notEqual(issue!.updatedAt, undefined);
});

test("board_update patches frontmatter and the change is visible to the adapter", async () => {
  await writeBoardIssue("todo", "ENG-1", "Work");

  const result = await executeTool(
    "board_update",
    { identifier: "ENG-1", labels: ["urgent"], priority: 1 },
    fsSettings(),
  );
  assert.equal(result.success, true);

  const client = new FsTrackerClient(boardDir);
  const [issue] = await client.fetchIssuesByIds(["eng-1"]);
  assert.deepEqual(issue!.labels, ["urgent"]);
  assert.equal(issue!.priority, 1);
});

test("fs tools validate required inputs and reject when board_dir is missing", async () => {
  const missing = await executeTool("board_move", {}, fsSettings());
  assert.equal(missing.success, false);
  assert.match(String(missing.error), /identifier.*required/);

  const noBoard = parseConfig({ tracker: { kind: "fs" } }, {});
  noBoard.tracker.boardDir = undefined;
  const result = await executeTool(
    "board_move",
    { identifier: "ENG-1", state: "Done" },
    noBoard,
  );
  assert.equal(result.success, false);
  assert.match(String(result.error), /missing fs board_dir/);

  const unknown = await executeTool("board_unknown", { identifier: "ENG-1" }, fsSettings());
  assert.equal(unknown.success, false);
  assert.match(String(unknown.error), /Unsupported tool/);
});

function fetchSequence(...responses: Response[]): typeof fetch {
  return (async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
