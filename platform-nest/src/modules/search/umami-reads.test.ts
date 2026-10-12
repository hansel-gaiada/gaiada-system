// M5-A4 — Umami client + reads, no DB. Response fixtures are shaped from the Umami 3.4.0 source
// (getWebsiteStats.ts, getPageviewMetrics.ts {x,y}, getEventDataValues.ts {value,total}); they are
// hand-recorded from the code, not captured from a live instance (none runs yet).
import { describe, it, expect, vi } from "vitest";
import {
  umamiGet, umamiSettings, UmamiAuthError, UmamiBadResponseError, UmamiNotConfiguredError, UmamiNotFoundError, UmamiUnreachableError,
  type UmamiSettings,
} from "./umami-client";
import {
  AnalyticsRangeError, mapFunnel, mapSections, mapSources, mapStats, readAnalytics, readSummary, resolveRange, suppress, summarize,
} from "./umami-reads";
import { buildAnalytics } from "./search-analytics.controller";
import { ANALYTICS_MCP_TOOLS } from "./umami-mcp-tools";

const SITE = "11111111-2222-4333-8444-555555555555";
const KEY = "umami_SECRETKEY123";
const S: UmamiSettings = { baseUrl: "http://10.88.0.2:18743", apiKey: KEY, timeoutMs: 200 };
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fx = (routes: Record<string, unknown>): typeof fetch =>
  (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    let key = u.pathname.replace(`/api/websites/${SITE}/`, "");
    if (u.searchParams.get("type")) key += `?type=${u.searchParams.get("type")}`;
    if (u.searchParams.get("eventName")) key += `?${u.searchParams.get("eventName")}:${u.searchParams.get("propertyName")}`;
    if (!(key in routes)) return jsonRes({ error: `no fixture ${key}` }, 500);
    return jsonRes(routes[key]);
  }) as unknown as typeof fetch;

const STATS = { pageviews: 1200, visitors: 400, visits: 500, bounces: 150, totaltime: 90000, comparison: { pageviews: 1, visitors: 1, visits: 1, bounces: 1, totaltime: 1 } };
const PATHS = [{ x: "/", y: 300 }, { x: "/services/web/", y: 120 }, { x: "/rare/", y: 2 }];
const REFS = [{ x: "www.google.com", y: 200 }, { x: "chatgpt.com", y: 12 }, { x: "perplexity.ai", y: 3 }, { x: "claude.ai", y: 1 }, { x: "m.chatgpt.com", y: 2 }, { x: "notchatgpt.com", y: 9 }];
const SECTIONS = [{ value: "home.hero", total: 1000 }, { value: "pricing.step3", total: 40 }, { value: "footer", total: 4 }];

describe("umami-client", () => {
  it("is not configured when either env var is unset", async () => {
    expect(umamiSettings({})).toBeNull();
    expect(umamiSettings({ UMAMI_BASE_URL: "http://x" })).toBeNull();
    expect(umamiSettings({ UMAMI_API_KEY: "k" })).toBeNull();
    expect(umamiSettings({ UMAMI_BASE_URL: "ftp://x", UMAMI_API_KEY: "k" })).toBeNull();
    expect(umamiSettings({ UMAMI_BASE_URL: "http://x/", UMAMI_API_KEY: "k" })).toMatchObject({ baseUrl: "http://x", timeoutMs: 10000 });
    await expect(umamiGet(SITE, "stats", {}, { settings: null })).rejects.toBeInstanceOf(UmamiNotConfiguredError);
  });
  it("sends a GET with the Bearer key and no key in the URL", async () => {
    const f = vi.fn(async () => jsonRes({ ok: 1 }));
    await umamiGet(SITE, "stats", { startAt: 1, endAt: 2 }, { settings: S, fetchImpl: f as never });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://10.88.0.2:18743/api/websites/${SITE}/stats?startAt=1&endAt=2`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(url).not.toContain(KEY);
  });
  it("rejects a website id that is not a UUID (no path injection)", async () => {
    await expect(umamiGet("../admin", "stats", {}, { settings: S, fetchImpl: vi.fn() as never })).rejects.toBeInstanceOf(UmamiBadResponseError);
  });
  it("times out as unreachable", async () => {
    const hang = ((_u: unknown, init: RequestInit) => new Promise((_r, rej) => {
      init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as unknown as typeof fetch;
    await expect(umamiGet(SITE, "stats", {}, { settings: { ...S, timeoutMs: 20 }, fetchImpl: hang })).rejects.toBeInstanceOf(UmamiUnreachableError);
  });
  it("maps statuses: 401/403 auth, 404 not found, 5xx unreachable, other 4xx bad response, non-JSON bad response", async () => {
    const st = (n: number) => ({ settings: S, fetchImpl: (async () => new Response("{}", { status: n })) as unknown as typeof fetch });
    await expect(umamiGet(SITE, "stats", {}, st(401))).rejects.toBeInstanceOf(UmamiAuthError);
    await expect(umamiGet(SITE, "stats", {}, st(403))).rejects.toBeInstanceOf(UmamiAuthError);
    await expect(umamiGet(SITE, "stats", {}, st(404))).rejects.toBeInstanceOf(UmamiNotFoundError);
    await expect(umamiGet(SITE, "stats", {}, st(502))).rejects.toBeInstanceOf(UmamiUnreachableError);
    await expect(umamiGet(SITE, "stats", {}, st(500))).rejects.toBeInstanceOf(UmamiUnreachableError);
    await expect(umamiGet(SITE, "stats", {}, st(400))).rejects.toBeInstanceOf(UmamiBadResponseError);
    await expect(umamiGet(SITE, "stats", {}, { settings: S, fetchImpl: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch }))
      .rejects.toBeInstanceOf(UmamiBadResponseError);
  });
  it("never puts the key in an error message", async () => {
    const boom = (async () => { throw new Error(`connect failed with ${KEY}`); }) as unknown as typeof fetch;
    const e = await umamiGet(SITE, "stats", {}, { settings: S, fetchImpl: boom }).catch((x) => x as Error);
    expect(e).toBeInstanceOf(UmamiUnreachableError);
    expect(String((e as Error).message)).not.toContain(KEY);
  });
});

describe("suppression and mappers", () => {
  it("suppress shows <5 for 0..4 and the number from 5", () => {
    expect([0, 1, 4].map(suppress)).toEqual(["<5", "<5", "<5"]);
    expect([5, 6, 1000].map(suppress)).toEqual([5, 6, 1000]);
  });
  it("summary maps stats and derives bounce/time; suppresses small cells and their ratios", () => {
    expect(summarize(mapStats(STATS))).toEqual({ visitors: 400, visits: 500, pageviews: 1200, bounceRate: 0.3, avgVisitSeconds: 180 });
    expect(summarize(mapStats({ pageviews: 9, visitors: 3, visits: 4, bounces: 1, totaltime: 100 })))
      .toEqual({ visitors: "<5", visits: "<5", pageviews: 9, bounceRate: null, avgVisitSeconds: null });
    expect(mapStats({ pageviews: { value: 7 } }).pageviews).toBe(7);
    expect(mapStats(undefined)).toEqual({ pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 });
  });
  it("sources: AI-search grouping by referrer host (host or subdomain, not a look-alike), sum suppressed after grouping", () => {
    const s = mapSources(REFS);
    expect(s.aiSearch.total).toBe(18);
    expect(s.aiSearch.hosts.map((h) => h.label).sort()).toEqual(["chatgpt.com", "claude.ai", "m.chatgpt.com", "perplexity.ai"]);
    expect(s.aiSearch.hosts.find((h) => h.label === "perplexity.ai")!.count).toBe("<5");
    expect(s.aiSearch.hosts.find((h) => h.label === "notchatgpt.com")).toBeUndefined();
    expect(s.referrers[0]).toEqual({ label: "www.google.com", count: 200 });
    expect(mapSources([{ x: "claude.ai", y: 2 }]).aiSearch.total).toBe("<5");
  });
  it("sections: views + reach against pageviews, small cells suppressed", () => {
    expect(mapSections(SECTIONS, 1200)).toEqual([
      { sectionId: "home.hero", views: 1000, reachPct: 83.3 },
      { sectionId: "pricing.step3", views: 40, reachPct: 3.3 },
      { sectionId: "footer", views: "<5", reachPct: null },
    ]);
    expect(mapSections(SECTIONS, 3)[0].reachPct).toBeNull();
  });
  it("funnel: joins the four events by form_id", () => {
    const rows = mapFunnel({
      lead_form_start: [{ value: "contact", total: 50 }, { value: "onboard", total: 10 }],
      lead_form_step: [{ value: "onboard", total: 30 }],
      lead_form_send: [{ value: "contact", total: 20 }, { value: "onboard", total: 4 }],
      generate_lead: [{ value: "contact", total: 18 }],
    });
    expect(rows).toEqual([
      { formId: "contact", lead_form_start: 50, lead_form_step: "<5", lead_form_send: 20, generate_lead: 18 },
      { formId: "onboard", lead_form_start: 10, lead_form_step: 30, lead_form_send: "<5", generate_lead: "<5" },
    ]);
  });
});

describe("readAnalytics from recorded fixtures", () => {
  const q = { siteId: SITE, startAt: 1, endAt: 2 };
  const routes = {
    stats: STATS,
    "metrics?type=path": PATHS,
    "metrics?type=referrer": REFS,
    "event-data/values?section_view:section_id": SECTIONS,
    "event-data/values?cta_click:link_location": [{ value: "hero", total: 30 }, { value: "footer", total: 2 }],
    "event-data/values?lead_form_start:form_id": [{ value: "contact", total: 50 }],
    "event-data/values?lead_form_step:form_id": [],
    "event-data/values?lead_form_send:form_id": [{ value: "contact", total: 20 }],
    "event-data/values?generate_lead:form_id": [{ value: "contact", total: 18 }],
    "event-data/values?web_vitals:metric_name": [{ value: "LCP", total: 300 }, { value: "CLS", total: 2 }],
    "event-data/values?web_vitals:metric_rating": [{ value: "good", total: 500 }, { value: "poor", total: 3 }],
  };
  const opts = { settings: S, fetchImpl: fx(routes) };
  it("each kind maps", async () => {
    expect(await readAnalytics("summary", { ...q, opts })).toMatchObject({ visitors: 400, bounceRate: 0.3 });
    expect(await readAnalytics("pages", { ...q, opts })).toEqual([{ label: "/", count: 300 }, { label: "/services/web/", count: 120 }, { label: "/rare/", count: "<5" }]);
    expect(await readAnalytics("sources", { ...q, opts })).toMatchObject({ aiSearch: { total: 18 } });
    expect(await readAnalytics("sections", { ...q, opts })).toHaveLength(3);
    expect(await readAnalytics("ctas", { ...q, opts })).toEqual([{ label: "hero", count: 30 }, { label: "footer", count: "<5" }]);
    expect(await readAnalytics("forms", { ...q, opts })).toEqual([{ formId: "contact", lead_form_start: 50, lead_form_step: "<5", lead_form_send: 20, generate_lead: 18 }]);
    expect(await readAnalytics("vitals", { ...q, opts })).toEqual({
      byMetric: [{ label: "LCP", count: 300 }, { label: "CLS", count: "<5" }],
      byRating: [{ label: "good", count: 500 }, { label: "poor", count: "<5" }],
    });
  });
  it("readSummary passes startAt/endAt", async () => {
    const f = vi.fn(async () => jsonRes(STATS));
    await readSummary({ ...q, opts: { settings: S, fetchImpl: f as never } });
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("startAt=1&endAt=2");
  });
});

describe("resolveRange", () => {
  it("defaults to the 30 days ending today and bounds inclusively in UTC", () => {
    const r = resolveRange(undefined, undefined, new Date("2026-10-11T12:00:00Z"));
    expect(r.from).toBe("2026-09-12");
    expect(r.to).toBe("2026-10-11");
    expect(r.endAt - r.startAt).toBe(30 * 86400000 - 1);
  });
  it("refuses bad, reversed and over-long ranges", () => {
    expect(() => resolveRange("2026-13-01", "2026-10-01")).toThrow(AnalyticsRangeError);
    expect(() => resolveRange("2026-10-02", "2026-10-01")).toThrow(AnalyticsRangeError);
    expect(() => resolveRange("2024-01-01", "2026-10-01")).toThrow(AnalyticsRangeError);
    expect(() => resolveRange("x", "2026-10-01")).toThrow(AnalyticsRangeError);
  });
});

describe("buildAnalytics states", () => {
  it("not_configured when settings are null (never an empty dashboard)", async () => {
    const r = await buildAnalytics("summary", SITE, "2026-10-01", "2026-10-10", { settings: null });
    expect(r).toMatchObject({ state: "not_configured" });
    expect(r.data).toBeUndefined();
    expect(r.message).toMatch(/not set up/);
  });
  it("not_bound when the property has no umami_site_id", async () => {
    expect((await buildAnalytics("summary", null, "2026-10-01", "2026-10-10", { settings: S })).state).toBe("not_bound");
  });
  it("unreachable on 5xx; rejected on 401/403/404", async () => {
    const mk = (n: number) => ({ settings: S, fetchImpl: (async () => new Response("{}", { status: n })) as unknown as typeof fetch });
    expect((await buildAnalytics("summary", SITE, "2026-10-01", "2026-10-10", mk(503))).state).toBe("unreachable");
    expect((await buildAnalytics("summary", SITE, "2026-10-01", "2026-10-10", mk(401))).state).toBe("rejected");
    expect((await buildAnalytics("summary", SITE, "2026-10-01", "2026-10-10", mk(403))).state).toBe("rejected");
    expect((await buildAnalytics("summary", SITE, "2026-10-01", "2026-10-10", mk(404))).state).toBe("rejected");
  });
  it("ok carries the range and data; a bad range is a 400", async () => {
    const r = await buildAnalytics("summary", SITE, "2026-10-01", "2026-10-10", { settings: S, fetchImpl: fx({ stats: STATS }) });
    expect(r).toMatchObject({ state: "ok", range: { from: "2026-10-01", to: "2026-10-10" }, data: { visitors: 400 } });
    await expect(buildAnalytics("summary", SITE, "nope", "2026-10-10", { settings: S })).rejects.toMatchObject({ status: 400 });
  });
});

describe("MCP tools", () => {
  it("seven read-only tools, no write/impact, range in the path so the hub forwards it", () => {
    expect(ANALYTICS_MCP_TOOLS.map((t) => t.name)).toEqual([
      "search.analyticsSummary", "search.analyticsPages", "search.analyticsSources", "search.analyticsSections",
      "search.analyticsCtas", "search.analyticsForms", "search.analyticsVitals",
    ]);
    for (const t of ANALYTICS_MCP_TOOLS) {
      expect(t.method).toBe("GET");
      expect(t.write).toBeUndefined();
      expect(t.impact).toBeUndefined();
      for (const p of [":tenantId", ":propertyId", ":from", ":to"]) expect(t.pathTemplate).toContain(p);
    }
  });
});
