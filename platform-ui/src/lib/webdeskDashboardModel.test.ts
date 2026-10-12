import { describe, it, expect } from "vitest";
import {
  decayStatusWords, filterOptions, filterQuery, formatCount, formatDay, formatSeconds, formatWindow, isPeriodKey, trendInfo, unavailableSources,
  type WritersDashboard,
} from "./webdeskDashboardModel";

describe("webdeskDashboardModel: the words", () => {
  it("a small cell is words, a number is a number", () => {
    expect(formatCount("<5")).toBe("fewer than 5");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(0)).toBe("0");
  });
  it("a trend is an arrow AND a sentence, and null (nothing to compare) draws nothing", () => {
    expect(trendInfo("up")).toEqual({ glyph: "▲", word: "up on the period before" });
    expect(trendInfo("down")?.word).toBe("down on the period before");
    expect(trendInfo("flat")?.word).toMatch(/about the same/);
    expect(trendInfo(null)).toBeNull();
    const glyphs = new Set([trendInfo("up")!.glyph, trendInfo("down")!.glyph, trendInfo("flat")!.glyph]);
    expect(glyphs.size).toBe(3);
  });
  it("seconds as a person says them", () => {
    expect([formatSeconds(45), formatSeconds(60), formatSeconds(210), formatSeconds(3601)]).toEqual(["45 s", "1 min", "3 min 30 s", "60 min 1 s"]);
  });
  it("days and windows", () => {
    expect(formatDay("2026-10-12")).toBe("12 Oct 2026");
    expect(formatDay("junk")).toBe("junk");
    expect(formatWindow({ from: "2026-09-15", to: "2026-10-12" })).toBe("15 Sep 2026 to 12 Oct 2026");
  });
  it("decay statuses in words; an unknown one is its own words, never hidden", () => {
    expect(decayStatusWords("open")).toMatch(/nobody has looked/);
    expect(decayStatusWords("acknowledged")).toMatch(/someone has seen/);
    expect(decayStatusWords("refresh_brief_filed")).toMatch(/refresh brief/);
    expect(decayStatusWords("something_new")).toBe("something new");
  });
});

describe("webdeskDashboardModel: filters", () => {
  it("writes only what differs from the default", () => {
    expect(filterQuery({})).toBe("");
    expect(filterQuery({ period: "28d" })).toBe("");
    expect(filterQuery({ period: "7d", collection: "post", locale: "id", mine: true, cursor: "abc" })).toBe("?period=7d&collection=post&locale=id&mine=true&cursor=abc");
    expect(filterQuery({ period: "1y" })).toBe("");
    expect(isPeriodKey("90d")).toBe(true);
    expect(isPeriodKey("x")).toBe(false);
    expect(isPeriodKey(undefined)).toBe(false);
  });
  it("filter options: the site's, the rows on screen and the current choice, once each, sorted", () => {
    expect(filterOptions(["post", "page"], ["guide", "post"], "banner")).toEqual(["banner", "guide", "page", "post"]);
    expect(filterOptions([], [], undefined)).toEqual([]);
  });
  it("lists the sources that did not answer, each with its own reason", () => {
    const r = { code: "umami_unreachable", text: "Website analytics could not be reached." };
    const s: WritersDashboard["sources"] = { umami: { state: "unavailable", reason: r }, search: { state: "ok" }, leads: { state: "not_asked" }, decay: { state: "ok" } };
    expect(unavailableSources(s)).toEqual([{ label: "Website analytics", reason: r }]);
    expect(unavailableSources({ umami: { state: "ok" }, search: { state: "ok" }, leads: { state: "ok" }, decay: { state: "ok" } })).toEqual([]);
  });
});
