// M5-V4 — the pure decay detector, on synthetic series. No services needed.
import { describe, it, expect } from "vitest";
import {
  DECAY_THRESHOLDS as T, DECAY_WINDOW_DAYS, composePage, decayWindows, detectDecay, gscToStat, normalizePagePath,
  type PageWindows, type WindowStat,
} from "./content-decay";

const w = (o: Partial<WindowStat>): WindowStat => ({ clicks: null, impressions: null, position: null, views: null, ...o });
const page = (recent: Partial<WindowStat> | null, baseline: Partial<WindowStat> | null, yearAgo: Partial<WindowStat> | null = null): PageWindows => ({
  recent: recent && w(recent), baseline: baseline && w(baseline), yearAgo: yearAgo && w(yearAgo),
});

describe("detectDecay", () => {
  it("flat traffic is not flagged", () => {
    const r = detectDecay(page({ clicks: 300, impressions: 9000, position: 6, views: 800 }, { clicks: 305, impressions: 9100, position: 6.2, views: 790 }));
    expect(r.flagged).toBe(false);
    expect(r.reason).toBe("");
  });

  it("a real drop is flagged, with the reason in words and the numbers", () => {
    const r = detectDecay(page({ clicks: 156, impressions: 8000, views: 420 }, { clicks: 410, impressions: 8200, views: 900 }));
    expect(r.flagged).toBe(true);
    const clicks = r.reasons.find((x) => x.metric === "clicks")!;
    expect(clicks.basis).toBe("prior_period");
    expect(clicks.dropPct).toBeCloseTo(0.62, 2);
    expect(r.reason).toContain("Search clicks fell 62% (410 to 156)");
    expect(r.reason).toContain(`last ${DECAY_WINDOW_DAYS} days`);
    expect(r.reasons.find((x) => x.metric === "views")).toBeDefined();
    expect(r.reasons.find((x) => x.metric === "impressions")).toBeUndefined(); // flat
  });

  it("a seasonal dip (down on the last window, flat on last year) is not flagged", () => {
    const r = detectDecay(page({ clicks: 150, views: 400 }, { clicks: 400, views: 900 }, { clicks: 160, views: 410 }));
    expect(r.flagged).toBe(false);
  });

  it("a drop that is also below last year is flagged and says so", () => {
    const r = detectDecay(page({ clicks: 150 }, { clicks: 400 }, { clicks: 420 }));
    expect(r.flagged).toBe(true);
    expect(r.reason).toContain("below the same period last year (420)");
  });

  it("a tiny page is never flagged, even at -100%", () => {
    const r = detectDecay(page({ clicks: 0, impressions: 0, views: 0 }, { clicks: T.minBaselineClicks - 1, impressions: T.minBaselineImpressions - 1, views: T.minBaselineViews - 1 }));
    expect(r.flagged).toBe(false);
  });

  it("noise: a big relative drop with a small absolute drop, or the reverse, is not flagged", () => {
    // 40 -> 26 clicks: -35% but only 14 clicks (below the absolute floor of 15).
    expect(detectDecay(page({ clicks: 26 }, { clicks: 40 })).flagged).toBe(false);
    // 2000 -> 1700 clicks: 300 clicks but only -15%.
    expect(detectDecay(page({ clicks: 1700 }, { clicks: 2000 })).flagged).toBe(false);
  });

  it("exactly at the thresholds is flagged (>=), one unit under is not", () => {
    // baseline 100, drop 30 = 30% and >= 15
    expect(detectDecay(page({ clicks: 70 }, { clicks: 100 })).flagged).toBe(true);
    expect(detectDecay(page({ clicks: 71 }, { clicks: 100 })).flagged).toBe(false);
  });

  it("missing data never alerts: null windows are not zeros", () => {
    expect(detectDecay({ recent: null, baseline: w({ clicks: 500, views: 900 }), yearAgo: null }).flagged).toBe(false);
    expect(detectDecay({ recent: w({ clicks: 10 }), baseline: null, yearAgo: null }).flagged).toBe(false);
    expect(detectDecay({ recent: null, baseline: null, yearAgo: null }).flagged).toBe(false);
    // a metric that is null in the recent window while the baseline had volume: skipped, not read as 0
    expect(detectDecay(page({ clicks: null, impressions: null, views: null }, { clicks: 500, impressions: 9000, views: 900 })).flagged).toBe(false);
    // null baseline member
    expect(detectDecay(page({ clicks: 0 }, { clicks: null })).flagged).toBe(false);
  });

  it("a page that dropped out of search entirely in a measured window IS flagged (true zero)", () => {
    const r = detectDecay(page({ clicks: 0, impressions: 0, position: null }, { clicks: 200, impressions: 5000, position: 8 }));
    expect(r.flagged).toBe(true);
  });

  it("slow decay: only the year-ago comparison sees it", () => {
    const r = detectDecay(page({ clicks: 200, views: 500 }, { clicks: 220, views: 540 }, { clicks: 500, views: 900 }));
    expect(r.flagged).toBe(true);
    expect(r.reasons.every((x) => x.basis === "year_ago")).toBe(true);
    expect(r.reason).toContain("below the same 28 days last year");
  });

  it("slow decay needs the volume floor on the year-ago window too", () => {
    expect(detectDecay(page({ clicks: 3 }, { clicks: 3 }, { clicks: T.minBaselineClicks - 1 })).flagged).toBe(false);
  });

  it("a position slide flags a page that ranked and had impressions", () => {
    const r = detectDecay(page({ clicks: 100, impressions: 5000, position: 14 }, { clicks: 105, impressions: 5100, position: 7 }));
    expect(r.flagged).toBe(true);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]!.metric).toBe("position");
    expect(r.reason).toContain("7.0 to 14.0");
  });

  it("position is ignored for a page that was never ranking well or had few impressions", () => {
    expect(detectDecay(page({ impressions: 5000, position: 70 }, { impressions: 5000, position: 50 })).flagged).toBe(false);
    expect(detectDecay(page({ impressions: 100, position: 20 }, { impressions: 100, position: 5 })).flagged).toBe(false);
    // improving position is never a decay
    expect(detectDecay(page({ impressions: 5000, position: 3 }, { impressions: 5000, position: 12 })).flagged).toBe(false);
  });
});

describe("windows, aggregation and path helpers", () => {
  it("decayWindows: 28-day windows, recent ends 3 days back, baseline directly before, year-ago 52 weeks back", () => {
    const d = decayWindows(new Date("2026-10-12T05:00:00Z"));
    expect(d.recent).toEqual({ from: "2026-09-12", to: "2026-10-09" });
    expect(d.baseline).toEqual({ from: "2026-08-15", to: "2026-09-11" });
    expect(d.yearAgo).toEqual({ from: "2025-09-13", to: "2025-10-10" });
  });

  it("gscToStat: an uncovered window is null, a covered window with no rows is a true zero", () => {
    expect(gscToStat(undefined, false)).toEqual({ clicks: null, impressions: null, position: null });
    expect(gscToStat(undefined, true)).toEqual({ clicks: 0, impressions: 0, position: null });
    expect(gscToStat({ clicks: 10, impressions: 100, positionWeighted: 500 }, true).position).toBe(5);
  });

  it("composePage: no source covers the window -> null window; one source covers -> the other stays null", () => {
    const none = { covered: { recent: false, baseline: false, yearAgo: false } };
    expect(composePage(none, none)).toEqual({ recent: null, baseline: null, yearAgo: null });
    const p = composePage(
      { ...none },
      { recent: 10, baseline: 50, covered: { recent: true, baseline: true, yearAgo: false } },
    );
    expect(p.recent).toEqual({ clicks: null, impressions: null, position: null, views: 10 });
    expect(p.yearAgo).toBeNull();
  });

  it("normalizePagePath: strips host, query and fragment; keeps no personal data", () => {
    expect(normalizePagePath("https://www.example.com/blog/post/?email=a@b.c&utm=x#top")).toBe("/blog/post");
    expect(normalizePagePath("/")).toBe("/");
    expect(normalizePagePath("/services/web/")).toBe("/services/web");
    expect(normalizePagePath("")).toBeNull();
    expect(normalizePagePath("not-a-path")).toBeNull();
    expect(normalizePagePath(`/${"a".repeat(600)}`)).toBeNull();
  });
});
