import type { Settings } from "@symphony/domain";

import type { SlackMessage, SlackTransport } from "./transport.js";

interface RawSlackMessage {
  ts?: string;
  text?: string;
  reactions?: Array<{ name?: string }>;
}

export class SlackWebTransport implements SlackTransport {
  private readonly endpoint: string;
  private readonly token: string;

  constructor(
    settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.endpoint = (settings.tracker.endpoint || "https://slack.com/api").replace(/\/+$/, "");
    this.token = settings.tracker.apiKey ?? "";
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for (const channel of channels) {
      const body = await this.get("conversations.history", { channel, limit: "200" });
      const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
      for (const m of messages) {
        if (typeof m.ts !== "string") continue;
        if (!/<@[A-Z0-9_]+>/.test(m.text ?? "")) continue;
        out.push(toMessage(channel, m));
      }
    }
    return out;
  }

  async getMessage(channel: string, ts: string): Promise<SlackMessage | null> {
    const body = await this.get("conversations.history", {
      channel,
      latest: ts,
      inclusive: "true",
      limit: "1",
    });
    const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
    const found = messages.find((m) => m.ts === ts);
    return found ? toMessage(channel, found) : null;
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    await this.post("reactions.add", { channel, timestamp: ts, name });
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    await this.post("reactions.remove", { channel, timestamp: ts, name });
  }

  async postReply(channel: string, threadTs: string, body: string): Promise<void> {
    await this.post("chat.postMessage", { channel, thread_ts: threadTs, text: body });
  }

  private async get(
    method: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = `${this.endpoint}/${method}?${new URLSearchParams(params).toString()}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    return this.parse(method, response);
  }

  private async post(
    method: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.endpoint}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });
    return this.parse(method, response);
  }

  private async parse(method: string, response: Response): Promise<Record<string, unknown>> {
    const body = (await response.json()) as Record<string, unknown>;
    if (body.ok !== true) {
      const reason = typeof body.error === "string" ? body.error : String(response.status);
      throw new Error(`slack ${method} failed: ${reason}`);
    }
    return body;
  }
}

function toMessage(channel: string, m: RawSlackMessage): SlackMessage {
  return {
    channel,
    ts: m.ts ?? "",
    text: m.text ?? "",
    reactions: (m.reactions ?? [])
      .map((r) => r.name)
      .filter((n): n is string => typeof n === "string"),
  };
}
