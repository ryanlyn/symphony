import { test } from "vitest";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

import { SlackWebTransport } from "@symphony/slack-tracker";

function settings() {
  return parseConfig(
    { tracker: { kind: "slack", channels: ["C1"] } },
    { SLACK_BOT_TOKEN: "xoxb-abc" },
  );
}

test("listMentions calls conversations.history with auth and parses messages", async () => {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "1.1", text: "<@U1> hi", reactions: [{ name: "eyes", count: 1 }] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl);
  const messages = await transport.listMentions(["C1"]);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]!.reactions, ["eyes"]);
  assert.equal(messages[0]!.channel, "C1");
  assert.match(calls[0]!.url, /\/conversations\.history\?/);
  assert.match(calls[0]!.url, /channel=C1/);
  assert.equal(calls[0]!.auth, "Bearer xoxb-abc");
});

test("listMentions filters to the configured bot user when botUserId is set", async () => {
  const fetchImpl = (async () => {
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [
          { ts: "1.1", text: "<@U_OTHER> human chatter", reactions: [] },
          { ts: "1.2", text: "<@U_BOT> do it", reactions: [] },
          { ts: "1.3", text: "<@U_BOT|worker> and this", reactions: [] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const settingsWithBot = parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U_BOT" } },
    { SLACK_BOT_TOKEN: "xoxb-abc" },
  );
  const transport = new SlackWebTransport(settingsWithBot, fetchImpl);
  const messages = await transport.listMentions(["C1"]);

  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.2", "1.3"],
  );
});

test("listMentions follows response_metadata.next_cursor across pages", async () => {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push({ url: String(url) });
    const parsed = new URL(String(url));
    const cursor = parsed.searchParams.get("cursor");
    if (!cursor) {
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [{ ts: "1.1", text: "<@U1> first page", reactions: [] }],
          response_metadata: { next_cursor: "CURSOR_2" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "2.2", text: "<@U1> second page", reactions: [] }],
        response_metadata: { next_cursor: "" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl);
  const messages = await transport.listMentions(["C1"]);

  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.1", "2.2"],
  );
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]!.url).searchParams.get("cursor"), null);
  assert.equal(new URL(calls[1]!.url).searchParams.get("cursor"), "CURSOR_2");
});

test("listMentions stops paging when next_cursor is empty", async () => {
  let pages = 0;
  const fetchImpl = (async () => {
    pages += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: `${pages}.0`, text: "<@U1> only page", reactions: [] }],
        response_metadata: { next_cursor: "" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl);
  const messages = await transport.listMentions(["C1"]);

  assert.equal(pages, 1);
  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.0"],
  );
});

test("addReaction posts to reactions.add", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await new SlackWebTransport(settings(), fetchImpl).addReaction("C1", "1.1", "eyes");
  assert.match(calls[0]!, /\/reactions\.add/);
});

test("get retries once on HTTP 429 honoring Retry-After then succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "1.1", text: "<@U1> hi", reactions: [] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  const messages = await transport.listMentions(["C1"]);

  assert.equal(calls, 2);
  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.1"],
  );
});

test("get gives up after the retry cap on a persistent 429 with a clear error", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "0" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await assert.rejects(() => transport.listMentions(["C1"]), /conversations\.history.*429/);
  assert.equal(calls, 5);
});

test("post retries on HTTP 5xx with backoff then succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("server error", { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await transport.addReaction("C1", "1.1", "eyes");

  assert.equal(calls, 2);
});

test("listMentions rejects with a method+status message on a non-JSON error body", async () => {
  const fetchImpl = (async () => {
    return new Response("<html><body>Bad Gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await assert.rejects(() => transport.listMentions(["C1"]), /conversations\.history.*502/);
});

test("get surfaces a clear non-JSON error instead of a SyntaxError", async () => {
  const fetchImpl = (async () => {
    return new Response("<html>nope</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  let caught: unknown;
  try {
    await transport.listMentions(["C1"]);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "expected an Error");
  assert.ok(!((caught as Error) instanceof SyntaxError), "should not leak a SyntaxError");
  assert.match((caught as Error).message, /conversations\.history/);
  assert.match((caught as Error).message, /non-JSON/);
  assert.match((caught as Error).message, /200/);
});

test("post rejects with a method+status message on a non-JSON 4xx body", async () => {
  const fetchImpl = (async () => {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await assert.rejects(() => transport.addReaction("C1", "1.1", "eyes"), /reactions\.add.*401/);
});

test("request-path failures (abort/timeout) are annotated with the slack method", async () => {
  const fetchImpl = (async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await assert.rejects(() => transport.listMentions(["C1"]), /conversations\.history.*timed out/);
});
