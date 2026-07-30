// Loop guard (ban protection). The only prior protection against engaging another automation was
// `fromMe`, which does nothing for a bot<->bot ping-pong or a client that echoes our replies back.
//
// The false-positive risk is what these tests care most about: a human repeating themselves, or a
// short "ok"/"yes", must NEVER be mistaken for a loop.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { config } from "../config";
import { isLoopSuppressed, recordOutboundText, resetLoopGuard } from "./loop-guard";

const CHAT = "111@g.us";
const OTHER = "222@g.us";
// Long enough to clear loopGuardMinTextLen (24) — short text is deliberately never a loop signal.
const LONG = "here is the project status update for today";

describe("loop guard", () => {
  beforeEach(() => {
    resetLoopGuard();
    config.loopGuardMinTextLen = 24;
    config.loopGuardBurstWindowMs = 15_000;
    config.loopGuardBurstCount = 3;
    config.loopGuardEchoWindowMs = 120_000;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("does not suppress ordinary conversation", () => {
    const t = 1_000_000;
    expect(isLoopSuppressed(CHAT, "can you summarize today's work please", t)).toBe(false);
    expect(isLoopSuppressed(CHAT, "and what about the invoice for RS3 solutions", t + 2000)).toBe(false);
  });

  it("never suppresses SHORT messages, however often they repeat", () => {
    // "ok" / "yes" / "1" are how humans confirm things — and how the action FSM is answered.
    const t = 2_000_000;
    for (let i = 0; i < 10; i++) {
      expect(isLoopSuppressed(CHAT, "ok", t + i * 100)).toBe(false);
    }
  });

  it("suppresses an ECHO of our own reply coming back at us", () => {
    const t = 3_000_000;
    recordOutboundText(CHAT, LONG, t); // the bot said this
    // ...and it comes straight back (another bot relaying, or a client echo).
    expect(isLoopSuppressed(CHAT, LONG, t + 500)).toBe(true);
  });

  it("stops treating it as an echo once the echo window has passed", () => {
    const t = 4_000_000;
    recordOutboundText(CHAT, LONG, t);
    expect(isLoopSuppressed(CHAT, LONG, t + config.loopGuardEchoWindowMs + 1)).toBe(false);
  });

  it("suppresses a BURST of the identical long message in one chat", () => {
    const t = 5_000_000;
    expect(isLoopSuppressed(CHAT, LONG, t)).toBe(false); // 1st
    expect(isLoopSuppressed(CHAT, LONG, t + 1000)).toBe(false); // 2nd
    expect(isLoopSuppressed(CHAT, LONG, t + 2000)).toBe(true); // 3rd within 15s -> loop
  });

  it("does not count repeats that fall outside the burst window", () => {
    const t = 6_000_000;
    isLoopSuppressed(CHAT, LONG, t);
    isLoopSuppressed(CHAT, LONG, t + 1000);
    // Third repeat arrives after the window — a human saying the same thing twenty minutes later.
    expect(isLoopSuppressed(CHAT, LONG, t + config.loopGuardBurstWindowMs + 5000)).toBe(false);
  });

  it("keeps state per chat — a loop in one group cannot mute another", () => {
    const t = 7_000_000;
    recordOutboundText(CHAT, LONG, t);
    expect(isLoopSuppressed(CHAT, LONG, t + 100)).toBe(true);
    expect(isLoopSuppressed(OTHER, LONG, t + 100)).toBe(false);
  });

  it("logs at most once per chat per cooldown, and never the message text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = 8_000_000;
    recordOutboundText(CHAT, LONG, t);
    isLoopSuppressed(CHAT, LONG, t + 100);
    isLoopSuppressed(CHAT, LONG, t + 200);
    isLoopSuppressed(CHAT, LONG, t + 300);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.join(" ");
    expect(line).not.toContain(LONG); // no message content in logs
    expect(line).not.toContain(CHAT); // chat id is hashed, not raw
  });
});
