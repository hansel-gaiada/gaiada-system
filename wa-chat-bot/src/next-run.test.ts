import { describe, it, expect } from "vitest";
import { nextSlotRun, nextRuns } from "./next-run";

const TZ = "Asia/Singapore"; // UTC+8, no DST — the config default, and the easiest to hand-verify

describe("next-run (1b: GET /admin/digests nextRun)", () => {
  it("both slots are still ahead today", () => {
    // 2026-07-28T10:00:00+08:00 == 2026-07-28T02:00:00Z
    const now = Date.UTC(2026, 6, 28, 2, 0, 0);
    expect(nextSlotRun("noon", now, TZ)).toBe(Date.UTC(2026, 6, 28, 4, 0, 0)); // 12:00+08
    expect(nextSlotRun("evening", now, TZ)).toBe(Date.UTC(2026, 6, 28, 10, 0, 0)); // 18:00+08
  });

  it("both slots have already passed today -> roll to tomorrow", () => {
    // 2026-07-28T20:00:00+08:00 == 2026-07-28T12:00:00Z (after both 12:00 and 18:00 local)
    const now = Date.UTC(2026, 6, 28, 12, 0, 0);
    expect(nextSlotRun("noon", now, TZ)).toBe(Date.UTC(2026, 6, 29, 4, 0, 0));
    expect(nextSlotRun("evening", now, TZ)).toBe(Date.UTC(2026, 6, 29, 10, 0, 0));
  });

  it("exactly at the slot instant counts as already-passed (strictly after `now`)", () => {
    const noonInstant = Date.UTC(2026, 6, 28, 4, 0, 0); // 12:00+08 on the 28th
    expect(nextSlotRun("noon", noonInstant, TZ)).toBe(Date.UTC(2026, 6, 29, 4, 0, 0));
  });

  it("rolls correctly across a month boundary", () => {
    // 2026-07-31T20:00:00+08:00 -> next noon is 2026-08-01
    const now = Date.UTC(2026, 6, 31, 12, 0, 0);
    expect(nextSlotRun("noon", now, TZ)).toBe(Date.UTC(2026, 7, 1, 4, 0, 0));
  });

  it("returns null on an invalid IANA timezone (fail-soft, never throws)", () => {
    expect(nextSlotRun("noon", Date.now(), "Not/AZone")).toBeNull();
  });

  it("nextRuns() bundles both slots", () => {
    const now = Date.UTC(2026, 6, 28, 2, 0, 0);
    expect(nextRuns(now, TZ)).toEqual({
      noon: Date.UTC(2026, 6, 28, 4, 0, 0),
      evening: Date.UTC(2026, 6, 28, 10, 0, 0),
    });
  });

  it("a DST-observing zone still resolves to the correct wall-clock hour", () => {
    // America/New_York, mid-July (EDT, UTC-4): 12:00 local == 16:00Z.
    const now = Date.UTC(2026, 6, 28, 10, 0, 0); // 06:00 EDT — before noon local
    expect(nextSlotRun("noon", now, "America/New_York")).toBe(Date.UTC(2026, 6, 28, 16, 0, 0));
  });
});
