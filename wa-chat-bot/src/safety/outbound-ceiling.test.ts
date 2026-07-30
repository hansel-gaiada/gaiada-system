// Global outbound ceiling + halt (ban protection, last-resort brake). No single incident should be
// able to produce a burst of sends from the business's real WhatsApp number.
//
// The ceiling is GLOBAL (all chats), unlike the per-(chat,sender) reply budget — so these tests
// also pin the interaction that matters operationally: a digest sweep must fit under it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { config } from "../config";
import { resetRateLimiter } from "./rate-limit";
import {
  checkOutboundCeiling,
  getOutboundCeilingStatus,
  resetOutboundCeilingCounters,
  OUTBOUND_CEILING_ERROR,
} from "./outbound-ceiling";
import { outboundHaltEnabled, setOutboundHalt, resetOutboundHalt } from "./outbound-halt";

describe("global outbound ceiling", () => {
  beforeEach(() => {
    resetRateLimiter();
    resetOutboundCeilingCounters();
    config.outboundCeilingPerMinCapacity = 30;
    config.outboundCeilingPerHourCapacity = 300;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("allows a normal digest sweep (11 groups + management) well under the cap", () => {
    const t = 1_000_000;
    for (let i = 0; i < 12; i++) {
      expect(checkOutboundCeiling(t + i).allowed).toBe(true);
    }
  });

  it("blocks once the per-minute burst capacity is spent, and reports a retry hint", () => {
    const t = 2_000_000;
    for (let i = 0; i < 30; i++) checkOutboundCeiling(t + i);
    const blocked = checkOutboundCeiling(t + 31);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("recovers as the bucket refills (a block is temporary, not sticky)", () => {
    const t = 3_000_000;
    for (let i = 0; i < 30; i++) checkOutboundCeiling(t + i);
    expect(checkOutboundCeiling(t + 100).allowed).toBe(false);
    // 30/min -> 0.5 tokens/sec, so ~2s buys one send back.
    expect(checkOutboundCeiling(t + 2_500).allowed).toBe(true);
  });

  it("counts sends and blocks so exhaustion is VISIBLE, not silent", () => {
    const t = 4_000_000;
    for (let i = 0; i < 30; i++) checkOutboundCeiling(t + i);
    checkOutboundCeiling(t + 40);
    const status = getOutboundCeilingStatus();
    expect(status.sent).toBe(30);
    expect(status.blocked).toBeGreaterThanOrEqual(1);
    expect(status.lastBlockedAt).not.toBeNull();
  });

  it("warns when it blocks (an operator must be able to see the brake engage)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = 5_000_000;
    for (let i = 0; i < 30; i++) checkOutboundCeiling(t + i);
    checkOutboundCeiling(t + 40);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => c.join(" ").includes("ceiling"))).toBe(true);
  });

  it("exposes a distinguishable error string so retries don't burn attempts on a policy block", () => {
    // sendWithRetry must be able to tell "WhatsApp is flaky, retry" from "we deliberately blocked".
    expect(OUTBOUND_CEILING_ERROR).toBe("outbound_ceiling_exceeded");
  });

  it("the per-HOUR cap still bites after many minutes of steady sending", () => {
    config.outboundCeilingPerMinCapacity = 1000; // take the per-minute bucket out of the picture
    config.outboundCeilingPerHourCapacity = 50;
    resetRateLimiter();
    const t = 6_000_000;
    for (let i = 0; i < 50; i++) expect(checkOutboundCeiling(t + i).allowed).toBe(true);
    expect(checkOutboundCeiling(t + 60).allowed).toBe(false);
  });
});

describe("outbound halt (manual brake)", () => {
  beforeEach(() => resetOutboundHalt());

  it("defaults to off and toggles both ways", () => {
    expect(outboundHaltEnabled()).toBe(false);
    setOutboundHalt(true);
    expect(outboundHaltEnabled()).toBe(true);
    setOutboundHalt(false);
    expect(outboundHaltEnabled()).toBe(false);
  });
});
