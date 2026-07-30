// Bot<->bot / echo loop guard. Before this, the ONLY protection against replying inside a
// loop was `fromMe` (bot.ts) — which only catches OUR OWN outbound events being redelivered
// to us as inbound, not (a) another automated sender in the same chat volleying near-identical
// text, or (b) our own reply text coming back to us through some relay/mirror under a
// DIFFERENT sender id (so `fromMe` is false). Both are real ban vectors: a loop means
// unbounded rapid-fire outbound traffic.
//
// Two independent heuristics, both scoped to short text-only content to avoid PII exposure —
// only a normalized (lowercased/whitespace-collapsed) form of the ALREADY-SCRUBBED text is ever
// held in memory, never chat ids or sender ids in logs (those are hashed).
//
//  1. BURST: N-or-more inbound messages in the same chat, regardless of sender, with the same
//     normalized text within a short window. Real automated loops repeat a full message
//     verbatim, fast (sub-10s cadence) — genuine humans saying the same short thing ("ok",
//     "yes", "haha") is common and must NOT trip this, so a minimum text length gates it.
//  2. ECHO: inbound text matches one of the bot's OWN recent outbound replies for that chat
//     within a longer window — a strong, low-false-positive signal (a human retyping a whole
//     multi-word bot reply verbatim within minutes is implausible) again gated by min length.
//
// False-positive profile: short common phrases NEVER trigger either heuristic (length gate),
// and BURST requires several *repeats* of the exact same long text in a tight window, which
// normal group chatter essentially never produces — the cost of a false positive is a real
// employee's message being silently un-replied-to, so both thresholds are deliberately loose
// (favor missing a slow-forming loop over silencing a real person).
import { createHash } from "node:crypto";
import { config } from "../config";

interface Seen {
  norm: string;
  ts: number;
}

const MAX_PER_CHAT = 10; // small ring buffer; loops are detected within seconds, not the full history

const inboundByChat = new Map<string, Seen[]>();
const outboundByChat = new Map<string, Seen[]>();
const lastSuppressLogByChat = new Map<string, number>();
const SUPPRESS_LOG_COOLDOWN_MS = 5 * 60 * 1000; // log once per chat per 5min, not once per message

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function chatHash(chatId: string): string {
  return createHash("sha256").update(chatId).digest("hex").slice(0, 12);
}

function push(map: Map<string, Seen[]>, chatId: string, norm: string, now: number): void {
  const list = map.get(chatId) ?? [];
  list.push({ norm, ts: now });
  while (list.length > MAX_PER_CHAT) list.shift();
  map.set(chatId, list);
  // Opportunistic bound on total memory: a chat that never sends again should not linger
  // forever. Cheap sweep, mirrors safety/dedup.ts's pattern.
  if (map.size > 5000) {
    for (const [k, v] of map) {
      const newest = v[v.length - 1]?.ts ?? 0;
      if (now - newest > 24 * 60 * 60 * 1000) map.delete(k);
    }
  }
}

/** Record one of OUR OWN outbound reply texts for this chat (echo detection compares future
 *  inbound against this). Call on every successful send, regardless of which pipeline sent it. */
export function recordOutboundText(chatId: string, text: string, now: number = Date.now()): void {
  const norm = normalize(text);
  if (norm.length < config.loopGuardMinTextLen) return; // too short to be a meaningful echo signal
  push(outboundByChat, chatId, norm, now);
}

function isBurstLoop(chatId: string, norm: string, now: number): boolean {
  const list = inboundByChat.get(chatId) ?? [];
  const windowStart = now - config.loopGuardBurstWindowMs;
  const matches = list.filter((s) => s.norm === norm && s.ts >= windowStart);
  // +1 for the current message, which is pushed by the caller before or after this check —
  // count it explicitly so the threshold means "this many total, including the current one".
  return matches.length + 1 >= config.loopGuardBurstCount;
}

function isEcho(chatId: string, norm: string, now: number): boolean {
  const list = outboundByChat.get(chatId) ?? [];
  const windowStart = now - config.loopGuardEchoWindowMs;
  return list.some((s) => s.norm === norm && s.ts >= windowStart);
}

/**
 * True if this inbound message looks like part of a bot<->bot/echo loop and the bot should
 * refuse to engage (no reply) — the message may still be stored for chat history/digests;
 * only the REPLY is suppressed. Also records the message into the burst-detection history.
 * Logs once per chat per cooldown window (never the message text or sender id).
 */
export function isLoopSuppressed(chatId: string, text: string, now: number = Date.now()): boolean {
  const norm = normalize(text);
  let suppressed = false;
  let reason: "burst" | "echo" | null = null;
  if (norm.length >= config.loopGuardMinTextLen) {
    if (isEcho(chatId, norm, now)) {
      suppressed = true;
      reason = "echo";
    } else if (isBurstLoop(chatId, norm, now)) {
      suppressed = true;
      reason = "burst";
    }
    push(inboundByChat, chatId, norm, now);
  }
  if (suppressed) {
    const lastLog = lastSuppressLogByChat.get(chatId) ?? 0;
    if (now - lastLog >= SUPPRESS_LOG_COOLDOWN_MS) {
      lastSuppressLogByChat.set(chatId, now);
      console.warn(`[safety] loop suppressed (reason=${reason}) chat=${chatHash(chatId)}`);
    }
  }
  return suppressed;
}

/** Test-only: clear all in-memory loop-guard state. */
export function resetLoopGuard(): void {
  inboundByChat.clear();
  outboundByChat.clear();
  lastSuppressLogByChat.clear();
}
