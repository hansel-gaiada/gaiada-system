// M5-P5a — the Bing Webmaster client and the simulated rows, without a database or a network: the parsers
// (dates, query rows, page rows, quota, sites), the typed errors (a key in the URL never reaches a message),
// the request shapes, simulate-by-default, and the deterministic synthetic rows.
import { describe, it, expect, vi } from "vitest";
import {
  BING_API_BASE, BingError, bingMode, getPageStats, getQueryStats, getUrlSubmissionQuota, getUserSites, parseBingDate, parsePageStats, parseQuota,
  parseQueryStats, parseUserSites, submitUrlBatch,
} from "./bing-client";
import { bingRowHash, simulateBingRows } from "./bing-service";

const KEY = "0123456789abcdef0123456789abcdef";
const json = (body: unknown, status = 200) => vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("mode", () => {
  it("is live only for the exact string live; everything else simulates", () => {
    expect(bingMode({ SEARCH_BING_MODE: "live" })).toBe("live");
    for (const v of [undefined, "", "simulate", "LIVE", "true", "1", " live"]) expect(bingMode({ SEARCH_BING_MODE: v })).toBe("simulate");
  });
});

describe("parsers", () => {
  it("parseBingDate reads /Date(ms)/ with or without an offset, as a UTC day", () => {
    expect(parseBingDate("/Date(1696118400000)/")).toBe("2023-10-01");
    expect(parseBingDate("/Date(1696118400000-0700)/")).toBe("2023-10-01");
    for (const bad of ["2023-10-01", "/Date(abc)/", "", null, 5, "/Date()/"]) expect(parseBingDate(bad)).toBeNull();
  });
  const wrap = (rows: unknown[]) => ({ d: rows });
  it("parseQueryStats keeps well-formed rows and skips the rest (never guesses)", () => {
    const rows = parseQueryStats(wrap([
      { Query: "gaiada", Date: "/Date(1696118400000)/", Clicks: 3, Impressions: 40, AvgClickPosition: 2.345, AvgImpressionPosition: 5 },
      { Query: "", Date: "/Date(1696118400000)/", Clicks: 1, Impressions: 1 },
      { Query: "no date", Clicks: 1, Impressions: 1 },
      { Query: "neg", Date: "/Date(1696118400000)/", Clicks: -1, Impressions: 1 },
      { Query: "str", Date: "/Date(1696118400000)/", Clicks: "3", Impressions: 1 },
      null, 7,
    ]));
    expect(rows).toEqual([{ date: "2023-10-01", kind: "query", key: "gaiada", clicks: 3, impressions: 40, avgClickPosition: 2.35, avgImpressionPosition: 5 }]);
  });
  it("parsePageStats tags rows as page, positions may be absent", () => {
    expect(parsePageStats(wrap([{ Query: "https://x.com/a/", Date: "/Date(1696118400000)/", Clicks: 0, Impressions: 2 }]))).toEqual([
      { date: "2023-10-01", kind: "page", key: "https://x.com/a/", clicks: 0, impressions: 2, avgClickPosition: null, avgImpressionPosition: null },
    ]);
  });
  it("a body that is not {d: [...]} parses to nothing", () => {
    for (const b of [null, {}, { d: null }, { d: "x" }, [], "x"]) expect(parseQueryStats(b)).toEqual([]);
  });
  it("parseQuota and parseUserSites", () => {
    expect(parseQuota({ d: { DailyQuota: 100, MonthlyQuota: 3000 } })).toEqual({ daily: 100, monthly: 3000 });
    expect(parseQuota({ d: { DailyQuota: 0 } })).toEqual({ daily: 0, monthly: 0 });
    expect(parseQuota({ d: {} })).toBeNull();
    expect(parseQuota({})).toBeNull();
    expect(parseUserSites({ d: [{ Url: "https://x.com/", IsVerified: true }, { Url: "https://y.com/", IsVerified: false }, { Nope: 1 }] })).toEqual([
      { url: "https://x.com/", verified: true }, { url: "https://y.com/", verified: false },
    ]);
  });
});

describe("calls", () => {
  it("GET carries the key and siteUrl as query params and does not follow redirects", async () => {
    const f = json({ d: [] });
    await getQueryStats(KEY, "https://x.com/", { fetchImpl: f as never });
    const [url, init] = f.mock.calls[0]!;
    const u = new URL(String(url));
    expect(`${u.origin}${u.pathname}`).toBe(`${BING_API_BASE}/GetQueryStats`);
    expect(u.searchParams.get("apikey")).toBe(KEY);
    expect(u.searchParams.get("siteUrl")).toBe("https://x.com/");
    expect(init!.method).toBe("GET");
    expect(init!.redirect).toBe("manual");
  });
  it("each read hits its own method", async () => {
    const f = json({ d: [] });
    await getPageStats(KEY, "https://x.com/", { fetchImpl: f as never });
    await getUserSites(KEY, { fetchImpl: f as never });
    await getUrlSubmissionQuota(KEY, "https://x.com/", { fetchImpl: f as never });
    expect(f.mock.calls.map((c) => new URL(String(c[0])).pathname.split("/").pop())).toEqual(["GetPageStats", "GetUserSites", "GetUrlSubmissionQuota"]);
  });
  it("SubmitUrlBatch POSTs { siteUrl, urlList } as JSON", async () => {
    const f = json({ d: null });
    await submitUrlBatch(KEY, "https://x.com/", ["https://x.com/a/", "https://x.com/b/"], { fetchImpl: f as never });
    const [url, init] = f.mock.calls[0]!;
    expect(new URL(String(url)).pathname.endsWith("/SubmitUrlBatch")).toBe(true);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({ siteUrl: "https://x.com/", urlList: ["https://x.com/a/", "https://x.com/b/"] });
  });
  it("errors are typed tokens and never contain the key or the response body", async () => {
    const catchErr = async (f: unknown): Promise<BingError> => {
      try { await getQueryStats(KEY, "https://x.com/", { fetchImpl: f as never }); } catch (e) { return e as BingError; }
      throw new Error("expected a throw");
    };
    const e401 = await catchErr(json({ Message: `bad key ${KEY}` }, 401));
    expect(e401).toBeInstanceOf(BingError);
    expect([e401.kind, e401.httpStatus]).toEqual(["rejected", 401]);
    const e500 = await catchErr(json({}, 503));
    expect([e500.kind, e500.httpStatus]).toEqual(["unreachable", 503]);
    expect((await catchErr(json({}, 429))).kind).toBe("unreachable");
    expect((await catchErr(vi.fn(async () => { throw new Error(`connect ECONNREFUSED ?apikey=${KEY}`); }))).kind).toBe("unreachable");
    expect((await catchErr(vi.fn(async () => new Response("<html>", { status: 200 })))).kind).toBe("bad_response");
    for (const e of [e401, e500]) { expect(e.message).not.toContain(KEY); expect(JSON.stringify(e)).not.toContain(KEY); }
  });
});

describe("simulated rows", () => {
  it("are deterministic for a property and window, stamped per kind, within bounds", () => {
    const a = simulateBingRows("p-1", "https://www.example.com/", "2026-10-01", "2026-10-07");
    const b = simulateBingRows("p-1", "https://www.example.com/", "2026-10-01", "2026-10-07");
    expect(a).toEqual(b);
    expect(a).toHaveLength(7 * 6);
    expect(a.filter((r) => r.kind === "query")).toHaveLength(7 * 3);
    expect(a.filter((r) => r.kind === "page").every((r) => r.key.startsWith("https://www.example.com/"))).toBe(true);
    for (const r of a) {
      expect(r.clicks).toBeGreaterThanOrEqual(0);
      expect(r.impressions).toBeGreaterThanOrEqual(r.clicks);
      expect(r.avgClickPosition).toBeGreaterThanOrEqual(1);
    }
    expect(simulateBingRows("p-2", "https://www.example.com/", "2026-10-01", "2026-10-07")).not.toEqual(a);
  });
  it("row hashes are unique per (property, date, kind, key) and stable", () => {
    const rows = simulateBingRows("p-1", "https://www.example.com/", "2026-10-01", "2026-10-03");
    const hashes = rows.map((r) => bingRowHash("p-1", r.date, r.kind, r.key));
    expect(new Set(hashes).size).toBe(rows.length);
    expect(bingRowHash("p-1", "2026-10-01", "query", "x")).toBe(bingRowHash("p-1", "2026-10-01", "query", "x"));
    expect(bingRowHash("p-1", "2026-10-01", "query", "x")).not.toBe(bingRowHash("p-1", "2026-10-01", "page", "x"));
  });
});
