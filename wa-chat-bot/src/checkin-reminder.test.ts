import { describe, it, expect, beforeEach } from "vitest";
import { putPendingCheckin, getPendingCheckin, consumePendingCheckin, resetPendingCheckins, isConfirmReply } from "./checkin-reminder";

describe("checkin-reminder pending state (TR-11)", () => {
  beforeEach(() => resetPendingCheckins());

  it("put -> get returns the stored payload", () => {
    putPendingCheckin("628@c.us", { tenantId: "t1", prefillSummary: "Logged 2h.", date: "2026-07-31" }, 60_000, 1_000);
    const p = getPendingCheckin("628@c.us", 1_500);
    expect(p).toEqual({ tenantId: "t1", prefillSummary: "Logged 2h.", date: "2026-07-31" });
  });

  it("get returns null once expired, and removes the row (no leak)", () => {
    putPendingCheckin("628@c.us", { tenantId: "t1", prefillSummary: "x", date: "2026-07-31" }, 1_000, 1_000);
    expect(getPendingCheckin("628@c.us", 2_500)).toBeNull();
    // a second read after expiry still returns null (already swept), never resurrects it.
    expect(getPendingCheckin("628@c.us", 2_600)).toBeNull();
  });

  it("consume is single-use: the second consume returns null", () => {
    putPendingCheckin("628@c.us", { tenantId: "t1", prefillSummary: "x", date: "2026-07-31" }, 60_000, 1_000);
    const first = consumePendingCheckin("628@c.us", 1_500);
    expect(first?.tenantId).toBe("t1");
    expect(consumePendingCheckin("628@c.us", 1_600)).toBeNull();
  });

  it("an unrelated chatId never sees another chat's pending reminder", () => {
    putPendingCheckin("628-a@c.us", { tenantId: "t1", prefillSummary: "a", date: "2026-07-31" }, 60_000, 1_000);
    expect(getPendingCheckin("628-b@c.us", 1_500)).toBeNull();
  });

  describe("isConfirmReply", () => {
    it.each(["ok", "OK", "Ok!", "yes", "y", "confirm", "confirmed", "done", "sure", "👍", "✅", "  ok  "])(
      "%s is a confirm reply",
      (text) => {
        expect(isConfirmReply(text)).toBe(true);
      },
    );

    it.each(["Shipped the onboarding flow, blocked on design review.", "no", "not yet", ""])(
      "%s is NOT a confirm reply (it's edited/new content)",
      (text) => {
        expect(isConfirmReply(text)).toBe(false);
      },
    );
  });
});
