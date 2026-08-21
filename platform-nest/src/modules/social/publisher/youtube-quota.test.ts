// SMM-38 phase 38d — YouTube's quota ACCOUNTING module, tested in isolation from `direct.ts` so the
// three-bucket model (and the "never invent a used value, never fabricate an increment" discipline)
// is pinned independently of the driver wiring `direct.test.ts` covers.
import { describe, it, expect, beforeEach } from "vitest";
import {
  YOUTUBE_QUOTA_CAPS, recordYouTubeQuotaUsage, getYouTubeQuotaSnapshot, resetYouTubeQuotaUsage,
} from "./youtube-quota";

beforeEach(() => {
  resetYouTubeQuotaUsage();
});

describe("SMM-38d · getYouTubeQuotaSnapshot — a fresh day starts every bucket at used:0, a TRUE fact", () => {
  it("returns the three cited caps with zero usage before anything is recorded", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    expect(getYouTubeQuotaSnapshot(now)).toEqual({
      searchListCallsToday: { used: 0, cap: YOUTUBE_QUOTA_CAPS.searchListCallsPerDay },
      videosInsertCallsToday: { used: 0, cap: YOUTUBE_QUOTA_CAPS.videosInsertCallsPerDay },
      otherUnitsToday: { used: 0, cap: YOUTUBE_QUOTA_CAPS.otherUnitsPerDay },
    });
  });

  it("caps match the dossier's own documented regime exactly — 100 / 100 / 10,000", () => {
    expect(YOUTUBE_QUOTA_CAPS).toEqual({
      searchListCallsPerDay: 100, videosInsertCallsPerDay: 100, otherUnitsPerDay: 10000,
    });
  });
});

describe("SMM-38d · recordYouTubeQuotaUsage — the three buckets are INDEPENDENT, never one pool", () => {
  it("recording videosInsertCallsToday never moves searchListCallsToday or otherUnitsToday", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    recordYouTubeQuotaUsage("videosInsertCallsToday", 1, now);
    const snap = getYouTubeQuotaSnapshot(now);
    expect(snap.videosInsertCallsToday).toEqual({ used: 1, cap: 100 });
    expect(snap.searchListCallsToday).toEqual({ used: 0, cap: 100 });
    expect(snap.otherUnitsToday).toEqual({ used: 0, cap: 10000 });
  });

  it("otherUnitsToday accumulates by the actual unit cost passed, not a flat +1 — a comments.insert " +
     "(50 units) and a commentThreads.list (1 unit) must NOT read the same", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    recordYouTubeQuotaUsage("otherUnitsToday", 1, now);
    recordYouTubeQuotaUsage("otherUnitsToday", 50, now);
    expect(getYouTubeQuotaSnapshot(now).otherUnitsToday).toEqual({ used: 51, cap: 10000 });
  });

  it("a NEW UTC day starts a fresh counter — yesterday's usage does not carry over", () => {
    const day1 = new Date("2026-08-21T23:59:00Z");
    const day2 = new Date("2026-08-22T00:01:00Z");
    recordYouTubeQuotaUsage("videosInsertCallsToday", 1, day1);
    expect(getYouTubeQuotaSnapshot(day1).videosInsertCallsToday!.used).toBe(1);
    expect(getYouTubeQuotaSnapshot(day2).videosInsertCallsToday!.used).toBe(0);
  });
});

describe("SMM-38d · resetYouTubeQuotaUsage — the test seam", () => {
  it("clears every day's accounted usage so one test's calls never leak into another's", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    recordYouTubeQuotaUsage("videosInsertCallsToday", 1, now);
    resetYouTubeQuotaUsage();
    expect(getYouTubeQuotaSnapshot(now).videosInsertCallsToday!.used).toBe(0);
  });
});
