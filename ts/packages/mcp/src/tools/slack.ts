import {
  emojiForState,
  SlackWebTransport,
  splitIssueId,
  statusEmojiMap,
  type SlackTransport,
} from "@symphony/slack-tracker";
import type { Settings } from "@symphony/domain";

import type { ToolResult, ToolSpec } from "../tools.js";

const TOOL_NAMES = ["slack_update_status", "slack_comment"] as const;

export function slackToolSpecs(): ToolSpec[] {
  return [
    {
      name: "slack_update_status",
      description:
        "Set a Slack issue's status by swapping its status emoji reaction. Args: issueId, status.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, status: { type: "string" } },
        required: ["issueId", "status"],
      },
    },
    {
      name: "slack_comment",
      description: "Reply in the Slack issue's thread. Args: issueId, body.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
      },
    },
  ];
}

export async function executeSlackTool(
  name: string,
  input: unknown,
  settings: Settings,
  transport: SlackTransport,
): Promise<ToolResult> {
  const args = isRecord(input) ? input : {};
  try {
    const parts = splitIssueId(requireStr(args, "issueId"));
    if (!parts) throw new Error("issueId must be in '<channel>:<ts>' form");
    const [channel, ts] = parts;
    switch (name) {
      case "slack_update_status": {
        const status = requireStr(args, "status");
        const map = statusEmojiMap(settings);
        const target = emojiForState(status, map);
        if (!target) {
          return failure(`No emoji configured for status '${status}'.`);
        }
        const message = await transport.getMessage(channel, ts);
        const present = (message?.reactions ?? []).filter((r) => map[r]);
        // Add-before-remove so the message is never left without a managed status reaction.
        // The read path maps a missing managed reaction to "Todo", so an add failure must
        // never erase the existing status, and a cleanup failure must leave the target intact.
        if (!present.includes(target)) {
          try {
            await transport.addReaction(channel, ts, target);
          } catch (error) {
            // Adding the new status failed; leave every existing reaction untouched so the
            // prior status is preserved rather than erased.
            return failure((error as Error).message);
          }
        }
        const stale = present.filter((r) => r !== target);
        for (const reaction of stale) {
          try {
            await transport.removeReaction(channel, ts, reaction);
          } catch (error) {
            // The target is already present, so the intended status holds. Surface the
            // cleanup failure but never remove the target while a stale reaction lingers.
            return failure((error as Error).message);
          }
        }
        return { success: true, result: { ok: true, status } };
      }
      case "slack_comment": {
        await transport.postReply(channel, ts, requireStr(args, "body"));
        return { success: true, result: { ok: true } };
      }
      default:
        return {
          success: false,
          error: "Unsupported tool.",
          result: { error: { message: "Unsupported tool.", supportedTools: [...TOOL_NAMES] } },
        };
    }
  } catch (error) {
    return failure((error as Error).message);
  }
}

export function slackTransportFor(
  settings: Settings,
  fetchImpl: typeof fetch,
  injected?: SlackTransport,
): SlackTransport {
  return injected ?? new SlackWebTransport(settings, fetchImpl);
}

function failure(message: string): ToolResult {
  return { success: false, error: message, result: { error: { message } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}
