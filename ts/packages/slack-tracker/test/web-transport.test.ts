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
