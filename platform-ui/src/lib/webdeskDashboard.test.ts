import { describe, it, expect, vi, beforeEach } from "vitest";

// The writer dashboard's wire validation (webdeskDashboard.ts): every 2xx body is validated, a figure is a value or an explained absence,
// the small-cell rule is the BFF's and a breach is drift, and a refusal is a typed result and never an empty list.

vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn() };
});

import { platformFetch, PlatformError } from "./platform";
import { getWritersDashboard, parseDashboard } from "./webdeskDashboard";

const fetchMock = vi.mocked(platformFetch);
const BASE = "/api/co-1/modules/webdev/content/sites/gaiada/site-1/writers/dashboard";

const reason = (code = "umami_unreachable") => ({ code, text: "Website analytics could not be reached." });
const ok = (value: unknown) => ({ value, reason: null });
const na = (code?: string) => ({ value: null, reason: reason(code) });
const item = (over: Record<string, unknown> = {}, metrics: Record<string, unknown> = {}) => ({
  itemId: "i1", collectionKey: "post", locale: "en", slug: "hello", title: "Hello", publishedVersion: 2, mine: true, pagePath: "/blog/hello/", pagePathReason: null,
  metrics: {
    views: ok({ current: 120, previous: 60, trend: "up" }), avgSeconds: ok({ seconds: 210 }), clicks: ok({ current: 30, previous: 20, trend: "up" }),
    impressions: ok({ current: 900, previous: 800, trend: "up" }), topQueries: ok([{ query: "villa bali", clicks: 20, impressions: 400 }]),
    leads: ok({ current: 2, previous: 1, trend: "up" }), ...metrics,
  },
  decay: ok("none"), ...over,
});
const body = (items: unknown[] = [item()], over: Record<string, unknown> = {}) => ({
  tenantSlug: "gaiada", siteId: "site-1", period: { key: "28d", days: 28 },
  windows: { traffic: { current: { from: "2026-09-15", to: "2026-10-12" }, previous: { from: "2026-08-18", to: "2026-09-14" } }, search: { current: { from: "2026-09-12", to: "2026-10-09" }, previous: { from: "2026-08-15", to: "2026-09-11" } } },
  scope: "scoped", sources: { umami: { state: "ok" }, search: { state: "ok" }, leads: { state: "ok" }, decay: { state: "ok" } },
  items, page: { cursor: null, hasMore: false, limit: 25 }, ...over,
});

beforeEach(() => fetchMock.mockReset());

describe("parseDashboard", () => {
  it("accepts a full body and keeps the figures as sent", () => {
    const d = parseDashboard(body());
    expect(d.items[0].metrics.views).toEqual(ok({ current: 120, previous: 60, trend: "up" }));
    expect(d.items[0].decay).toEqual(ok("none"));
    expect(d.scope).toBe("scoped");
  });
  it("a figure is a value or an explained absence: both null, or both set, is drift", () => {
    expect(() => parseDashboard(body([item({}, { clicks: { value: null, reason: null } })]))).toThrow(/a value or a reason/);
    expect(() => parseDashboard(body([item({}, { clicks: { value: { current: 1, previous: null, trend: null }, reason: reason() } })]))).toThrow(/not both/);
    expect(parseDashboard(body([item({}, { clicks: na("gsc_no_data") })])).items[0].metrics.clicks).toEqual(na("gsc_no_data"));
  });
  it("an empty reason text is drift (an absence must be explained in words)", () => {
    expect(() => parseDashboard(body([item({}, { views: { value: null, reason: { code: "x", text: "  " } } })]))).toThrow(/words/);
  });
  it("THE SMALL-CELL RULE: a view count is '<5' or at least 5; a raw 3 is drift, and so is a trend computed from a small cell", () => {
    expect(parseDashboard(body([item({}, { views: ok({ current: "<5", previous: 40, trend: null }) })])).items[0].metrics.views.value).toMatchObject({ current: "<5" });
    expect(() => parseDashboard(body([item({}, { views: ok({ current: 3, previous: 40, trend: null }) })]))).toThrow(/at least 5/);
    expect(() => parseDashboard(body([item({}, { views: ok({ current: "<5", previous: 40, trend: "up" }) })]))).toThrow(/trend/);
    // Search clicks are not visitor cells: a small exact number is fine
    expect(parseDashboard(body([item({}, { clicks: ok({ current: 2, previous: 1, trend: "up" }) })])).items).toHaveLength(1);
  });
  it("a page path and its missing reason are two halves of one fact", () => {
    expect(() => parseDashboard(body([item({ pagePath: null, pagePathReason: null })]))).toThrow(/pagePath/);
    expect(() => parseDashboard(body([item({ pagePath: "/x/", pagePathReason: reason() })]))).toThrow(/pagePath/);
    const d = parseDashboard(body([item({ pagePath: null, pagePathReason: reason("no_route_pattern") })]));
    expect(d.items[0].pagePath).toBeNull();
  });
  it("a decay finding, 'none', and nothing else", () => {
    const f = { findingId: "f1", status: "open", reason: "Clicks fell.", detectedAt: "2026-10-10T00:00:00.000Z", briefId: null };
    expect(parseDashboard(body([item({ decay: ok(f) })])).items[0].decay).toEqual(ok(f));
    expect(() => parseDashboard(body([item({ decay: ok({ findingId: "f1" }) })]))).toThrow();
  });
  it("refuses a bad scope, a bad source state, a negative count, an unknown trend and missing members", () => {
    expect(() => parseDashboard(body([], { scope: "everyone" }))).toThrow(/all_site/);
    expect(() => parseDashboard(body([], { sources: { umami: { state: "maybe" }, search: { state: "ok" }, leads: { state: "ok" }, decay: { state: "ok" } } }))).toThrow(/state/);
    expect(() => parseDashboard(body([item({}, { clicks: ok({ current: -1, previous: null, trend: null }) })]))).toThrow(/count/);
    expect(() => parseDashboard(body([item({}, { clicks: ok({ current: 1, previous: 1, trend: "sideways" }) })]))).toThrow(/up \| down/);
    expect(() => parseDashboard({ ...body(), items: undefined })).toThrow();
    expect(() => parseDashboard("nope")).toThrow();
  });
  it("an unavailable source carries its reason", () => {
    const d = parseDashboard(body([], { sources: { umami: { state: "unavailable", reason: reason() }, search: { state: "ok" }, leads: { state: "not_asked" }, decay: { state: "ok" } } }));
    expect(d.sources.umami).toEqual({ state: "unavailable", reason: reason() });
    expect(() => parseDashboard(body([], { sources: { umami: { state: "unavailable" }, search: { state: "ok" }, leads: { state: "ok" }, decay: { state: "ok" } } }))).toThrow();
  });
});

describe("getWritersDashboard", () => {
  it("asks the BFF for the site's dashboard with the filters, 25 at a time", async () => {
    fetchMock.mockResolvedValue(body() as never);
    const r = await getWritersDashboard("u1", "co-1", "gaiada", "site-1", { period: "7d", collection: "post", locale: "id", mine: true, cursor: "abc" });
    expect(r.kind).toBe("ok");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith(`${BASE}?`)).toBe(true);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(Object.fromEntries(q)).toEqual({ period: "7d", collection: "post", locale: "id", mine: "true", cursor: "abc", limit: "25" });
    expect(fetchMock.mock.calls[0][1]).toBe("u1");
  });
  it("an unknown period is not sent; no filters is just the limit", async () => {
    fetchMock.mockResolvedValue(body() as never);
    await getWritersDashboard("u1", "co-1", "gaiada", "site-1", { period: "1y" });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}?limit=25`);
  });
  it("a 403 is 'forbidden', a 503 is 'unavailable', a drifted body is contract_drift: never an empty dashboard", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await getWritersDashboard("u1", "co-1", "gaiada", "site-1")).kind).toBe("forbidden");
    fetchMock.mockRejectedValueOnce(new PlatformError(503, "editorial_unavailable"));
    expect((await getWritersDashboard("u1", "co-1", "gaiada", "site-1")).kind).toBe("unavailable");
    fetchMock.mockResolvedValueOnce({ ...body(), items: [item({}, { clicks: { value: null, reason: null } })] } as never);
    const r = await getWritersDashboard("u1", "co-1", "gaiada", "site-1");
    expect(r).toMatchObject({ kind: "unavailable", code: "contract_drift" });
  });
});
