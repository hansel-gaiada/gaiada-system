// Every outbound path must honour the brakes. The audit finding was that only mutating /actions
// were rate-limited, so the fix has to hold at the ONE place every send converges (SurfaceRouter)
// — otherwise a future caller quietly bypasses it. These tests enumerate all five content-bearing
// methods rather than spot-checking sendText.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { config } from "./config";
import { SurfaceRouter } from "./surface";
import { resetRateLimiter } from "./safety/rate-limit";
import { resetOutboundCeilingCounters } from "./safety/outbound-ceiling";
import { setOutboundHalt, resetOutboundHalt } from "./safety/outbound-halt";
import { resetLoopGuard } from "./safety/loop-guard";
import type { ChatGateway } from "./gateway/contract";

const CHAT = "111@g.us";

/** Counts what actually reached the wire. Anything blocked must NEVER appear here. */
function spyGateway() {
  const calls: string[] = [];
  const ok = async () => ({ ok: true as const, ref: "1" });
  return {
    calls,
    gw: {
      sendText: async () => void calls.push("sendText"),
      reply: async () => (calls.push("reply"), ok()),
      sendMedia: async () => (calls.push("sendMedia"), ok()),
      react: async () => (calls.push("react"), ok()),
      sendButtons: async () => (calls.push("sendButtons"), ok()),
      typing: async () => ok(),
      addMember: async () => ok(),
      removeMember: async () => ok(),
      promote: async () => ok(),
      demote: async () => ok(),
      setSubject: async () => ok(),
      pin: async () => ok(),
      inviteLink: async () => ok(),
    } as unknown as ChatGateway,
  };
}

describe("SurfaceRouter enforces the outbound brakes on every content-bearing path", () => {
  beforeEach(() => {
    resetRateLimiter();
    resetOutboundCeilingCounters();
    resetOutboundHalt();
    resetLoopGuard();
    config.outboundCeilingPerMinCapacity = 30;
    config.outboundCeilingPerHourCapacity = 300;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("sends normally when nothing is engaged", async () => {
    const { calls, gw } = spyGateway();
    const r = new SurfaceRouter(gw, gw);
    await r.sendText(CHAT, "hello team");
    expect(calls).toEqual(["sendText"]);
  });

  it("HALT stops all five: sendText throws; the GatewayResult paths fail soft", async () => {
    const { calls, gw } = spyGateway();
    const r = new SurfaceRouter(gw, gw);
    setOutboundHalt(true);

    // sendText is the void-returning contract — it must throw rather than silently no-op.
    await expect(r.sendText(CHAT, "nope")).rejects.toThrow(/halt/i);
    // The result-returning verbs report the block instead of throwing (callers check .ok).
    expect((await r.reply(CHAT, "m1", "nope")).ok).toBe(false);
    expect((await r.sendMedia(CHAT, { kind: "image", mimetype: "image/png", url: "u" })).ok).toBe(false);
    expect((await r.react(CHAT, "m1", "👍")).ok).toBe(false);
    expect((await r.sendButtons(CHAT, "pick", [{ label: "A", token: "tok-a" }])).ok).toBe(false);

    // Nothing reached the wire — this is the assertion that matters for a ban brake.
    expect(calls).toEqual([]);
  });

  it("the global CEILING blocks every path once exhausted", async () => {
    const { calls, gw } = spyGateway();
    const r = new SurfaceRouter(gw, gw);
    config.outboundCeilingPerMinCapacity = 2;
    config.outboundCeilingPerHourCapacity = 2;
    resetRateLimiter();

    await r.sendText(CHAT, "one");
    await r.sendText(CHAT, "two");
    expect(calls).toEqual(["sendText", "sendText"]);

    await expect(r.sendText(CHAT, "three")).rejects.toThrow();
    expect((await r.reply(CHAT, "m", "three")).ok).toBe(false);
    expect((await r.react(CHAT, "m", "👍")).ok).toBe(false);
    expect(calls).toEqual(["sendText", "sendText"]); // still only the first two
  });

  it("records our own outbound text so the echo loop-guard can recognise it later", async () => {
    const { gw } = spyGateway();
    const r = new SurfaceRouter(gw, gw);
    const long = "here is the project status update for today";
    await r.sendText(CHAT, long);
    const { isLoopSuppressed } = await import("./safety/loop-guard");
    // The same text coming back in is an echo -> suppressed.
    expect(isLoopSuppressed(CHAT, long)).toBe(true);
  });

  it("group-admin verbs pass through (the action executor gates those, not the ceiling)", async () => {
    const { gw } = spyGateway();
    const r = new SurfaceRouter(gw, gw);
    setOutboundHalt(true);
    // Deliberate design choice: these are already behind the executor's kill-switch +
    // high-risk rate limit + confirm FSM, so the content brake does not double-gate them.
    expect((await r.typing(CHAT, true)).ok).toBe(true);
    expect((await r.addMember(CHAT, "62811@c.us")).ok).toBe(true);
  });
});
