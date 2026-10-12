import { describe, it, expect } from "vitest";
import {
  AiVisibilityShapeError, bySeries, groupStatus, parseCrawlerSummary, parseVisibilitySummary,
} from "./aiVisibilityModel";

const range = { from: "2026-10-10", to: "2026-10-12" };
const cov = { firstDay: "2026-10-10", lastDay: "2026-10-11" };
const okBody = () => ({
  state: "ok", range, coverage: cov, totalHits: 7,
  byDay: [{ day: "2026-10-10", bot: "GPTBot", hits: 4 }, { day: "2026-10-12", bot: "ClaudeBot", hits: 3 }],
  byBot: [{ bot: "GPTBot", hits: 4, verified: 0, unverified: 0, claimed: 4 }, { bot: "ClaudeBot", hits: 3, verified: 0, unverified: 0, claimed: 3 }],
  topPaths: [{ path: "/a/", hits: 5 }], statusMix: [{ status: 200, hits: 5 }, { status: 403, hits: 2 }],
});

describe("parseCrawlerSummary", () => {
  it("accepts an ok body and the two no-data states (words, no numbers)", () => {
    expect(parseCrawlerSummary(okBody()).state).toBe("ok");
    const nd = parseCrawlerSummary({ state: "no_data", message: "none yet", range, coverage: { firstDay: null, lastDay: null } });
    expect(nd).toMatchObject({ state: "no_data", message: "none yet" });
    expect("totalHits" in nd).toBe(false);
    expect(parseCrawlerSummary({ state: "no_data_in_range", message: "m", range, coverage: cov }).state).toBe("no_data_in_range");
  });
  it("refuses anything off-contract instead of drawing it", () => {
    expect(() => parseCrawlerSummary({ ...okBody(), totalHits: "7" })).toThrow(AiVisibilityShapeError);
    expect(() => parseCrawlerSummary({ ...okBody(), byDay: [{ day: "x", bot: "b", hits: -1 }] })).toThrow(AiVisibilityShapeError);
    expect(() => parseCrawlerSummary({ ...okBody(), state: "weird" })).toThrow(AiVisibilityShapeError);
    expect(() => parseCrawlerSummary({ state: "ok" })).toThrow(AiVisibilityShapeError);
    expect(() => parseCrawlerSummary([])).toThrow(AiVisibilityShapeError);
  });
});

describe("parseVisibilitySummary", () => {
  const row = { engine: "chatgpt", query: "q", brandMentioned: true, cited: false, citedUrl: null, prominence: null, capturedAt: "2026-10-08T00:00:00.000Z", simulated: false, changed: true };
  it("accepts ok and no_data, refuses a row with a wrong type", () => {
    const ok = parseVisibilitySummary({ state: "ok", lastCapturedAt: row.capturedAt, anySimulated: false, engines: [{ engine: "chatgpt", queries: 1, mentioned: 1, cited: 0, changed: 1 }], latest: [row] });
    expect(ok.state).toBe("ok");
    expect(parseVisibilitySummary({ state: "no_data", message: "none" })).toEqual({ state: "no_data", message: "none" });
    expect(() => parseVisibilitySummary({ state: "ok", lastCapturedAt: "x", anySimulated: false, engines: [], latest: [{ ...row, cited: "no" }] })).toThrow(AiVisibilityShapeError);
  });
});

describe("groupStatus", () => {
  it("separates blocked (401/403/429) from other 4xx and groups 5xx; empty groups are left out", () => {
    const g = groupStatus([{ status: 200, hits: 5 }, { status: 301, hits: 1 }, { status: 403, hits: 2 }, { status: 429, hits: 1 }, { status: 404, hits: 4 }, { status: 503, hits: 3 }]);
    expect(g.map((x) => [x.key, x.hits])).toEqual([["ok", 5], ["redirect", 1], ["blocked", 3], ["client_error", 4], ["server_error", 3]]);
    expect(groupStatus([{ status: 200, hits: 1 }]).map((x) => x.key)).toEqual(["ok"]);
    expect(groupStatus([])).toEqual([]);
  });
});

describe("bySeries", () => {
  it("lists every day of the range (a measured gap shows as no cell) and orders bots by total hits", () => {
    const s = bySeries(okBody().byDay, range.from, range.to);
    expect(s.days).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(s.bots).toEqual(["GPTBot", "ClaudeBot"]);
    expect(s.cells["2026-10-11"]).toBeUndefined();
    expect(s.max).toBe(4);
  });
});
