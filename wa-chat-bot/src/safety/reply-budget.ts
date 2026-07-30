// Per-(chatId, senderId) reply budget. `checkRate` (rate-limit.ts) already guards mutating
// /actions (executor.ts); the plain REPLY path (mention/command engagement -> Q&A/skills) had
// no protection at all before this — a mention flood, a fat-fingered burst, or a genuine
// bot<->bot ping-pong on the same sender could otherwise fire unbounded outbound replies, which
// is a ban vector on the one real WhatsApp number this bot runs on.
//
// Scope is deliberately per-(chat, sender), NOT per-chat: in a busy group where several
// DIFFERENT people mention the bot inside the same minute, each person gets their own
// independent bucket, so normal multi-person traffic is never affected — only a single
// sender hammering the bot in one chat gets throttled. When the budget is exhausted the
// caller MUST stay silent (see bot.ts) rather than reply with a "slow down" message, because
// that reply would itself be outbound traffic and could itself become the flood.
import { checkRate } from "./rate-limit";
import { config } from "../config";

const KEY_PREFIX = "reply-budget:";

export function replyBudgetKey(chatId: string, senderId: string): string {
  return `${KEY_PREFIX}${chatId}|${senderId}`;
}

/** True if this (chat, sender) may receive another bot reply right now; consumes a token if so. */
export function checkReplyBudget(chatId: string, senderId: string, now?: number): boolean {
  const { allowed } = checkRate(replyBudgetKey(chatId, senderId), {
    capacity: config.replyBudgetCapacity,
    refillPerSec: config.replyBudgetRefillPerSec,
    now,
  });
  return allowed;
}
