import type { Settings } from "@symphony/domain";
import { defaultStateType } from "@symphony/issue";

export const DEFAULT_EMOJI_STATES: Record<string, string> = {
  eyes: "In Progress",
  white_check_mark: "Done",
  x: "Cancelled",
};

export function statusEmojiMap(settings: Settings): Record<string, string> {
  return { ...DEFAULT_EMOJI_STATES, ...(settings.tracker.emojiStates ?? {}) };
}

/** Rank a status by category so a more-advanced state wins over a less-advanced one. */
function stateRank(state: string): number {
  switch (defaultStateType(state)) {
    case "canceled":
    case "completed":
      return 3;
    case "started":
      return 2;
    case "backlog":
    case "unstarted":
    case "triage":
      return 1;
    default:
      return 0;
  }
}

/**
 * Derive state from the reactions present; the most-advanced mapped status wins (ties
 * broken by reaction order), else "Todo".
 */
export function stateFromReactions(reactions: string[], map: Record<string, string>): string {
  let best: string | null = null;
  let bestRank = -1;
  for (const reaction of reactions) {
    const state = map[reaction];
    if (!state) continue;
    const rank = stateRank(state);
    if (rank > bestRank) {
      best = state;
      bestRank = rank;
    }
  }
  return best ?? "Todo";
}

/** Reverse lookup: the emoji name whose mapped state equals `state` (case-insensitive). */
export function emojiForState(state: string, map: Record<string, string>): string | null {
  const target = state.trim().toLowerCase();
  for (const [emoji, mapped] of Object.entries(map)) {
    if (mapped.trim().toLowerCase() === target) return emoji;
  }
  return null;
}
