// Reply budget (ban protection). Before this, the plain REPLY path had no rate limit at all —
// only mutating /actions did — so a mention flood or a bot<->bot ping-pong could fire unbounded
// outbound replies from the one real WhatsApp number.
//
// The risk of the FIX is the mirror image: throttling too eagerly means ignoring a real employee.
// These tests pin both directions, and the isolation property (per chat+sender) that makes a busy
// multi-person group safe.
import { describe, it, expect, beforeEach } from "vitest";
import { config } from "../config";
import { resetRateLimiter } from "./rate-limit";
import { checkReplyBudget, replyBudgetKey } from "./reply-budget";

const CHAT = "111@g.us";
const ALICE = "62811@c.us";
const BOB = "62822@c.us";

describe("reply budget", () => {
  beforeEach(() => {
    resetRateLimiter();
    config.replyBudgetCapacity = 8;
    config.replyBudgetRefillPerSec = 0.1; // 1 token / 10s
  });

  it("lets a normal conversation through (no false throttling)", () => {
    const t0 = 1_000_000;
    // Eight exchanges with the bot in a row is well within a normal working conversation.
    for (let i = 0; i < 8; i++) {
      expect(checkReplyBudget(CHAT, ALICE, t0 + i * 1000)).toBe(true);
    }
  });

  it("throttles ONE sender hammering the bot, past the burst capacity", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 8; i++) checkReplyBudget(CHAT, ALICE, t0 + i);
    // 9th within the same instant: budget exhausted -> caller must stay silent.
    expect(checkReplyBudget(CHAT, ALICE, t0 + 9)).toBe(false);
  });

  it("gives every sender in the same chat an INDEPENDENT bucket", () => {
    // This is the property that keeps a busy group usable: several different people mentioning
    // the bot in the same minute must not starve each other.
    const t0 = 3_000_000;
    for (let i = 0; i < 8; i++) checkReplyBudget(CHAT, ALICE, t0 + i);
    expect(checkReplyBudget(CHAT, ALICE, t0 + 9)).toBe(false); // Alice exhausted
    expect(checkReplyBudget(CHAT, BOB, t0 + 9)).toBe(true); // Bob unaffected
  });

  it("keeps the same sender's buckets separate ACROSS chats", () => {
    const t0 = 4_000_000;
    for (let i = 0; i < 8; i++) checkReplyBudget(CHAT, ALICE, t0 + i);
    expect(checkReplyBudget(CHAT, ALICE, t0 + 9)).toBe(false);
    expect(checkReplyBudget("999@g.us", ALICE, t0 + 9)).toBe(true);
  });

  it("refills over time so a throttled sender recovers", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 8; i++) checkReplyBudget(CHAT, ALICE, t0 + i);
    expect(checkReplyBudget(CHAT, ALICE, t0 + 10)).toBe(false);
    // 0.1 tokens/sec -> one token back after ~10s.
    expect(checkReplyBudget(CHAT, ALICE, t0 + 10_500)).toBe(true);
  });

  it("namespaces its keys so it cannot collide with the /actions limiter", () => {
    expect(replyBudgetKey(CHAT, ALICE)).toBe(`reply-budget:${CHAT}|${ALICE}`);
    expect(replyBudgetKey(CHAT, ALICE)).not.toBe(`${CHAT}|${ALICE}`);
  });
});
