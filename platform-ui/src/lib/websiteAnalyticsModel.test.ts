import { describe, it, expect } from "vitest";
import {
  AnalyticsShapeError, barPct, fmtCount, fmtDuration, fmtPct, matchProperty, maxCount, parseAnalyticsRead, resolveRange,
} from "./websiteAnalyticsModel";

describe("parseAnalyticsRead", () => {
  it("parses ok summary and keeps suppressed cells as <5", () => {
    const r = parseAnalyticsRead("summary", { state: "ok", data: { visitors: 40, visits: "<5", pageviews: 90, bounceRate: null, avgVisitSeconds: null } });
    expect(r).toEqual({ state: "ok", data: { visitors: 40, visits: "<5", pageviews: 90, bounceRate: null, avgVisitSeconds: null } });
  });
  it("refuses a raw small number (the UI must never show one)", () => {
    expect(() => parseAnalyticsRead("pages", { state: "ok", data: [{ label: "/", count: 3 }] })).toThrow(AnalyticsShapeError);
  });
  it("carries the plain-words message for each non-ok state", () => {
    for (const state of ["not_configured", "not_bound", "unreachable", "rejected"] as const) {
      expect(parseAnalyticsRead("pages", { state, message: "words" })).toEqual({ state, message: "words" });
    }
    expect(parseAnalyticsRead("pages", { state: "unreachable" })).toMatchObject({ state: "unreachable" });
  });
  it("rejects an unknown state and off-shape data as drift, never as empty", () => {
    expect(() => parseAnalyticsRead("pages", { state: "weird" })).toThrow(AnalyticsShapeError);
    expect(() => parseAnalyticsRead("pages", { state: "ok", data: "x" })).toThrow(AnalyticsShapeError);
    expect(() => parseAnalyticsRead("pages", null)).toThrow(AnalyticsShapeError);
  });
  it("parses sources, sections, forms and vitals", () => {
    expect(parseAnalyticsRead("sources", { state: "ok", data: { referrers: [{ label: "google.com", count: 9 }], aiSearch: { total: "<5", hosts: [] } } }).state).toBe("ok");
    expect(parseAnalyticsRead("sections", { state: "ok", data: [{ sectionId: "home.hero", views: 10, reachPct: 50 }] }).state).toBe("ok");
    expect(parseAnalyticsRead("forms", { state: "ok", data: [{ formId: "c", lead_form_start: 9, lead_form_step: "<5", lead_form_send: 5, generate_lead: "<5" }] }).state).toBe("ok");
    expect(parseAnalyticsRead("vitals", { state: "ok", data: { byMetric: [], byRating: [{ label: "good", count: 12 }] } }).state).toBe("ok");
  });
});

describe("matchProperty", () => {
  const props = [{ id: "p1", domain: "gaiada.com", umamiSiteId: "u" }, { id: "p2", domain: "https://other.example/", umamiSiteId: null }];
  it("matches on a site environment domain, ignoring scheme, www and case", () => {
    expect(matchProperty(props, [null, "WWW.Gaiada.com"])?.id).toBe("p1");
    expect(matchProperty(props, ["other.example"])?.id).toBe("p2");
  });
  it("returns null when nothing matches (said in words by the page, not guessed)", () => {
    expect(matchProperty(props, ["staging.gaiada.com", null])).toBeNull();
    expect(matchProperty(props, [])).toBeNull();
  });
});

describe("resolveRange", () => {
  const now = new Date("2026-10-11T08:00:00Z");
  it("defaults to the last 30 days", () => {
    expect(resolveRange(undefined, undefined, now)).toEqual({ from: "2026-09-12", to: "2026-10-11", error: null });
  });
  it("uses valid input and flags bad, reversed and over-long ranges while falling back", () => {
    expect(resolveRange("2026-10-01", "2026-10-05", now)).toEqual({ from: "2026-10-01", to: "2026-10-05", error: null });
    expect(resolveRange("nope", "2026-10-05", now).error).toMatch(/YYYY-MM-DD/);
    expect(resolveRange("2026-10-09", "2026-10-05", now).error).toMatch(/after/);
    expect(resolveRange("2024-01-01", "2026-10-05", now).error).toMatch(/400/);
  });
});

describe("formatting", () => {
  it("shows <5, never a number, for a suppressed cell", () => {
    expect(fmtCount("<5")).toBe("<5");
    expect(fmtCount(1234)).toBe("1,234");
    expect(barPct("<5", 100)).toBe(0);
    expect(barPct(50, 100)).toBe(50);
    expect(maxCount(["<5", 7, 3 as never])).toBe(7);
  });
  it("renders ratios and durations, n/a when withheld", () => {
    expect(fmtPct(0.3)).toBe("30.0%");
    expect(fmtPct(null)).toBe("n/a");
    expect(fmtDuration(185)).toBe("3m 5s");
    expect(fmtDuration(null)).toBe("n/a");
  });
});
