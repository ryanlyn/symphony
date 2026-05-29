import type { SlackMessage, SlackTransport } from "./transport.js";

interface SeedMessage {
  ts: string;
  text: string;
  reactions?: string[];
}

export class InMemorySlackTransport implements SlackTransport {
  readonly replies: Array<{ channel: string; threadTs: string; body: string }> = [];
  private readonly messages: Map<string, SlackMessage[]> = new Map();

  constructor(seed: Record<string, SeedMessage[]> = {}) {
    for (const [channel, msgs] of Object.entries(seed)) {
      this.messages.set(
        channel,
        msgs.map((m) => ({ channel, ts: m.ts, text: m.text, reactions: [...(m.reactions ?? [])] })),
      );
    }
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for (const channel of channels) {
      for (const m of this.messages.get(channel) ?? []) {
        if (/<@[A-Z0-9_]+(\|[^>]*)?>/.test(m.text)) out.push({ ...m, reactions: [...m.reactions] });
      }
    }
    return Promise.resolve(out);
  }

  async getMessage(channel: string, ts: string): Promise<SlackMessage | null> {
    const found = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    return Promise.resolve(found ? { ...found, reactions: [...found.reactions] } : null);
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    const msg = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    if (msg && !msg.reactions.includes(name)) msg.reactions.push(name);
    return Promise.resolve();
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    const msg = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    if (msg) msg.reactions = msg.reactions.filter((r) => r !== name);
    return Promise.resolve();
  }

  async postReply(channel: string, threadTs: string, body: string): Promise<void> {
    this.replies.push({ channel, threadTs, body });
    return Promise.resolve();
  }
}
