// M5-W8 — the writer dashboard without services: the pure rules (windows, page path, trend, small cells, assembly), the data sources'
// parsers and SQL text, the Umami reads against a fake fetch, and the SERVICE (order, visibility, outages, pagination, chunking)
// against stubs for WebDesk, Cerbos and the four sources. The HTTP + real Cerbos + Postgres behaviour is
// `webdesk-writers-dashboard.test.ts` (the Linux gate).
import { describe, it, expect } from "vitest";
import { ForbiddenException, HttpException, ServiceUnavailableException } from "@nestjs/common";
import { webdevModule } from "./index";
import type { ContentGate, EditableSite } from "./webdesk-content.service";
import type { Principal } from "../../rbac/principal";
import type { Resource } from "../../rbac/cerbos";
import {
  CERBOS_CHUNK, assembleItems, chunked, dashboardWindows, decodeCursor, encodeCursor, exactFigure, gscMinCoverageDays, isLocalized, ok,
  resolvePagePath, routePatternOf, sourceFail, sourceOk, topQueriesOf, trendOf, viewsFigure, unavailable,
  type DecayInfo, type PageItem, type Sourced, type UmamiData,
} from "./webdesk-writers-dashboard";
import {
  DECAY_SQL, GSC_PAGES_SQL, GSC_QUERIES_SQL, LEADS_SQL, PROPERTY_SQL, candidatePaths, decayJobEnabled, matchProperty, normDomain, parseUmamiPaths,
  parseUmamiTime, readUmami, type DashboardSources, type SourcesInput,
} from "./webdesk-writers-dashboard-sources";
import {
  WebdeskWritersDashboardService, domainsOf, pairKey, pairVerdicts, parseQuery,
  type DashboardAuthz, type DashboardWebdesk, type Pair, type PairVerdict, type WdCollection, type WdItemRow,
} from "./webdesk-writers-dashboard.service";

const NOW = new Date("2026-10-12T10:00:00Z");

// ── windows ──────────────────────────────────────────────────────────────────────────────────────

describe("dashboardWindows", () => {
  it("28d: the 28 days ending today, the 28 before, and Search Console shifted back by the 3-day lag", () => {
    const w = dashboardWindows(NOW, 28);
    expect(w.traffic.current).toEqual({ from: "2026-09-15", to: "2026-10-12" });
    expect(w.traffic.previous).toEqual({ from: "2026-08-18", to: "2026-09-14" });
    expect(w.search.current).toEqual({ from: "2026-09-12", to: "2026-10-09" });
    expect(w.search.previous).toEqual({ from: "2026-08-15", to: "2026-09-11" });
  });
  it("7d windows are exactly 7 days and do not overlap", () => {
    const w = dashboardWindows(NOW, 7);
    expect(w.traffic.current).toEqual({ from: "2026-10-06", to: "2026-10-12" });
    expect(w.traffic.previous).toEqual({ from: "2026-09-29", to: "2026-10-05" });
  });
  it("Search Console coverage needs half the window, between 3 and 14 days", () => {
    expect([gscMinCoverageDays(7), gscMinCoverageDays(28), gscMinCoverageDays(90)]).toEqual([4, 14, 14]);
  });
});

// ── the page path ────────────────────────────────────────────────────────────────────────────────

describe("resolvePagePath", () => {
  const base = { slug: "best-villas", locale: "en", defaultLocale: "en", localized: true };
  it("fills {slug}; the default language drops the {locale} segment, another language keeps it", () => {
    expect(resolvePagePath({ ...base, pattern: "/blog/{slug}/" })).toEqual({ path: "/blog/best-villas/" });
    expect(resolvePagePath({ ...base, pattern: "/{locale}/blog/{slug}/" })).toEqual({ path: "/blog/best-villas/" });
    expect(resolvePagePath({ ...base, locale: "id", pattern: "/{locale}/blog/{slug}/" })).toEqual({ path: "/id/blog/best-villas/" });
  });
  it("says why there is no path, in a code", () => {
    expect(resolvePagePath({ ...base, pattern: undefined })).toEqual({ reason: "no_route_pattern" });
    expect(resolvePagePath({ ...base, pattern: "" })).toEqual({ reason: "no_route_pattern" });
    expect(resolvePagePath({ ...base, pattern: "blog/{slug}" })).toEqual({ reason: "bad_route_pattern" });
    expect(resolvePagePath({ ...base, pattern: "/blog/{title}/" })).toEqual({ reason: "bad_route_pattern" });
    expect(resolvePagePath({ ...base, pattern: "/blog/{slug/" })).toEqual({ reason: "bad_route_pattern" });
    expect(resolvePagePath({ ...base, pattern: 42 })).toEqual({ reason: "bad_route_pattern" });
    expect(resolvePagePath({ ...base, pattern: "/x?a={slug}" })).toEqual({ reason: "bad_route_pattern" });
    expect(resolvePagePath({ ...base, slug: "a/../b", pattern: "/blog/{slug}/" })).toEqual({ reason: "slug_not_routable" });
    expect(resolvePagePath({ ...base, slug: "a b", pattern: "/blog/{slug}/" })).toEqual({ reason: "slug_not_routable" });
  });
  it("a localized collection whose pattern has no {locale} has no address for a non-default language", () => {
    expect(resolvePagePath({ ...base, locale: "id", pattern: "/blog/{slug}/" })).toEqual({ reason: "locale_not_routable" });
    expect(resolvePagePath({ ...base, locale: "id", localized: false, pattern: "/blog/{slug}/" })).toEqual({ path: "/blog/best-villas/" });
  });
  it("a singleton page may have a fixed address with no {slug}", () => {
    expect(resolvePagePath({ ...base, slug: "Home Page!", pattern: "/about/" })).toEqual({ path: "/about/" });
  });
  it("reads the pattern defensively from a composition that may not carry it (the vocabulary has no such key yet)", () => {
    expect(routePatternOf({ ui: { label: "Posts" } })).toBeUndefined();
    expect(routePatternOf(null)).toBeUndefined();
    expect(routePatternOf({ ui: { label: "Posts", routePattern: "/blog/{slug}/" } })).toBe("/blog/{slug}/");
    expect(isLocalized({ localized: false })).toBe(false);
    expect(isLocalized({})).toBe(true);
  });
});

// ── figures ──────────────────────────────────────────────────────────────────────────────────────

describe("figures", () => {
  it("a trend is flat inside 5 % of the earlier figure, and never computed from a small cell", () => {
    expect(trendOf(100, 100)).toBe("flat");
    expect(trendOf(104, 100)).toBe("flat");
    expect(trendOf(120, 100)).toBe("up");
    expect(trendOf(70, 100)).toBe("down");
    expect(trendOf(3, 2)).toBe("up");
    expect(trendOf(0, 0)).toBe("flat");
    expect(trendOf(1, 0)).toBe("up");
    expect(viewsFigure(3, 50)).toEqual({ current: "<5", previous: 50, trend: null });
    expect(viewsFigure(50, 3)).toEqual({ current: 50, previous: "<5", trend: null });
    expect(viewsFigure(80, 40)).toEqual({ current: 80, previous: 40, trend: "up" });
    expect(viewsFigure(80, null)).toEqual({ current: 80, previous: null, trend: null });
    expect(exactFigure(3, 1)).toEqual({ current: 3, previous: 1, trend: "up" });
  });
  it("top queries: at least 5 impressions, by clicks then impressions, at most 3", () => {
    const rows = [
      { query: "rare", clicks: 9, impressions: 4 },
      { query: "b", clicks: 5, impressions: 100 },
      { query: "a", clicks: 5, impressions: 200 },
      { query: "c", clicks: 1, impressions: 50 },
      { query: "d", clicks: 0, impressions: 900 },
      { query: "", clicks: 99, impressions: 99 },
    ];
    expect(topQueriesOf(rows).map((r) => r.query)).toEqual(["a", "b", "c"]);
  });
  it("chunks of at most 50, and the cursor round-trips and refuses junk", () => {
    expect(chunked(Array.from({ length: 120 }, (_, i) => i)).map((c) => c.length)).toEqual([50, 50, 20]);
    expect(CERBOS_CHUNK).toBe(50);
    expect(decodeCursor(encodeCursor({ collection: "post", webdesk: "abc" }))).toEqual({ collection: "post", webdesk: "abc" });
    expect(decodeCursor(encodeCursor({ collection: "post", webdesk: null }))).toEqual({ collection: "post", webdesk: null });
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify(["", null])).toString("base64url"))).toBeNull();
  });
});

// ── assembly ─────────────────────────────────────────────────────────────────────────────────────

const umamiOk = (cur: Record<string, number>, prev: Record<string, number> | null = {}, time: UmamiData["time"] = null, truncated = false): UmamiData => ({
  current: { covered: true, truncated, byPath: new Map(Object.entries(cur)) },
  previous: prev === null ? null : { covered: true, truncated: false, byPath: new Map(Object.entries(prev)) },
  time,
});
const finding: DecayInfo = { findingId: "f1", status: "open", reason: "Clicks fell 40 %.", detectedAt: "2026-10-10T00:00:00.000Z", briefId: null };
const allGood = (over: Partial<Sourced> = {}): Sourced => ({
  umami: sourceOk(umamiOk({ "/blog/a": 120 }, { "/blog/a": 60 }, new Map([["/blog/a", { pageviews: 120, visits: 100, totaltime: 21000 }]]))),
  gsc: sourceOk({
    currentCovered: true, previousCovered: true,
    current: new Map([["/blog/a", { clicks: 30, impressions: 900 }]]), previous: new Map([["/blog/a", { clicks: 50, impressions: 800 }]]),
    queries: new Map([["/blog/a", [{ query: "villa bali", clicks: 20, impressions: 400 }]]]),
  }),
  leads: sourceOk({ current: new Map([["/blog/a", 2]]), previous: new Map([["/blog/a", 1]]) }),
  decay: sourceOk({ enabled: true, byPath: new Map([["/blog/a", finding]]) }),
  ...over,
});
const item = (over: Partial<PageItem> = {}): PageItem => ({
  itemId: "i1", collectionKey: "post", locale: "en", slug: "a", title: "A", publishedVersion: 2, mine: true, path: { path: "/blog/a/" }, ...over,
});

describe("assembleItems", () => {
  it("every figure for a page with data, trends included", () => {
    const [r] = assembleItems([item()], allGood());
    expect(r.pagePath).toBe("/blog/a/");
    expect(r.metrics.views).toEqual(ok({ current: 120, previous: 60, trend: "up" }));
    expect(r.metrics.avgSeconds).toEqual(ok({ seconds: 210 }));
    expect(r.metrics.clicks).toEqual(ok({ current: 30, previous: 50, trend: "down" }));
    expect(r.metrics.impressions.value).toMatchObject({ current: 900, trend: "up" });
    expect(r.metrics.topQueries).toEqual(ok([{ query: "villa bali", clicks: 20, impressions: 400 }]));
    expect(r.metrics.leads).toEqual(ok({ current: 2, previous: 1, trend: "up" }));
    expect(r.decay).toEqual(ok(finding));
  });
  it("matches the stored path (no trailing slash) to the item's address (with one)", () => {
    const [r] = assembleItems([item({ path: { path: "/blog/a" } })], allGood());
    expect(r.metrics.views.value).toMatchObject({ current: 120 });
  });
  it("an Umami outage is null with a reason on the Umami figures only, never 0, and the row stays", () => {
    const [r] = assembleItems([item()], allGood({ umami: sourceFail("umami_unreachable") }));
    expect(r.metrics.views).toEqual(unavailable("umami_unreachable"));
    expect(r.metrics.views.value).toBeNull();
    expect(r.metrics.avgSeconds.value).toBeNull();
    expect(r.metrics.clicks.value).not.toBeNull();
    expect(r.metrics.leads.value).not.toBeNull();
  });
  it("a Search Console source with too little data is null with a reason, not 0 clicks", () => {
    const [r] = assembleItems([item()], allGood({ gsc: sourceOk({ currentCovered: false, previousCovered: false, current: new Map(), previous: new Map(), queries: new Map() }) }));
    expect(r.metrics.clicks).toEqual(unavailable("gsc_no_data"));
    expect(r.metrics.impressions).toEqual(unavailable("gsc_no_data"));
    expect(r.metrics.topQueries).toEqual(unavailable("gsc_no_data"));
  });
  it("covered data with no row for the page is a measured zero; an uncovered earlier period only drops the trend", () => {
    const g = sourceOk({ currentCovered: true, previousCovered: false, current: new Map(), previous: new Map(), queries: new Map() });
    const [r] = assembleItems([item()], allGood({ gsc: g }));
    expect(r.metrics.clicks).toEqual(ok({ current: 0, previous: null, trend: null }));
    expect(r.metrics.topQueries).toEqual(ok([]));
  });
  it("views under 5 are \"<5\" with no trend and no average", () => {
    const [r] = assembleItems([item()], allGood({ umami: sourceOk(umamiOk({ "/blog/a": 3 }, { "/blog/a": 40 }, new Map([["/blog/a", { pageviews: 3, visits: 2, totaltime: 100 }]]))) }));
    expect(r.metrics.views).toEqual(ok({ current: "<5", previous: 40, trend: null }));
    expect(r.metrics.avgSeconds).toEqual(unavailable("small_cell"));
  });
  it("a page absent from a truncated Umami list is unknown, not zero; absent from a complete one is measured", () => {
    expect(assembleItems([item()], allGood({ umami: sourceOk(umamiOk({ "/other": 90 }, {}, null, true)) }))[0].metrics.views).toEqual(unavailable("umami_truncated"));
    expect(assembleItems([item()], allGood({ umami: sourceOk(umamiOk({ "/other": 90 }, {})) }))[0].metrics.views).toEqual(ok({ current: "<5", previous: "<5", trend: null }));
  });
  it("an analytics site with no visits at all is 'no data', not zero views", () => {
    const empty: UmamiData = { current: { covered: false, truncated: false, byPath: new Map() }, previous: null, time: null };
    expect(assembleItems([item()], allGood({ umami: sourceOk(empty) }))[0].metrics.views).toEqual(unavailable("umami_no_data"));
  });
  it("the reading time is only trusted when its page views agree with the views figure", () => {
    const u = sourceOk(umamiOk({ "/blog/a": 120 }, {}, new Map([["/blog/a", { pageviews: 999, visits: 100, totaltime: 21000 }]])));
    expect(assembleItems([item()], allGood({ umami: u }))[0].metrics.avgSeconds).toEqual(unavailable("umami_no_time"));
    expect(assembleItems([item()], allGood({ umami: sourceOk(umamiOk({ "/blog/a": 120 }, {}, null)) }))[0].metrics.avgSeconds).toEqual(unavailable("umami_no_time"));
  });
  it("leads: exact counts, 0 when none landed, null with a reason when the read failed", () => {
    expect(assembleItems([item()], allGood({ leads: sourceOk({ current: new Map(), previous: new Map() }) }))[0].metrics.leads).toEqual(ok({ current: 0, previous: 0, trend: "flat" }));
    expect(assembleItems([item()], allGood({ leads: sourceFail("leads_unavailable") }))[0].metrics.leads).toEqual(unavailable("leads_unavailable"));
  });
  it("decay: a finding, 'none' when the detector runs, null with a reason when it is off or failed", () => {
    const none = (enabled: boolean) => allGood({ decay: sourceOk({ enabled, byPath: new Map() }) });
    expect(assembleItems([item()], none(true))[0].decay).toEqual(ok("none"));
    expect(assembleItems([item()], none(false))[0].decay).toEqual(unavailable("decay_off"));
    expect(assembleItems([item()], allGood({ decay: sourceFail("decay_unavailable") }))[0].decay).toEqual(unavailable("decay_unavailable"));
  });
  it("an item with no public path keeps its row and every figure says why it is unavailable", () => {
    const [r] = assembleItems([item({ path: { reason: "no_route_pattern" } })], allGood());
    expect(r.pagePath).toBeNull();
    expect(r.pagePathReason?.code).toBe("no_route_pattern");
    for (const m of [r.metrics.views, r.metrics.avgSeconds, r.metrics.clicks, r.metrics.impressions, r.metrics.topQueries, r.metrics.leads, r.decay]) {
      expect(m.value).toBeNull();
      expect(m.reason?.code).toBe("no_route_pattern");
      expect(m.reason?.text.length).toBeGreaterThan(10);
    }
  });
});

// ── the sources ──────────────────────────────────────────────────────────────────────────────────

describe("sources: parsers and SQL", () => {
  it("matches a property on the registered domain, www ignored, production first, a verified one winning a tie", () => {
    const rows = [
      { id: "p1", domain: "gaiada.com", umamiSiteId: null, verifiedAt: null },
      { id: "p2", domain: "www.gaiada.com", umamiSiteId: "u2", verifiedAt: "2026-10-01" },
      { id: "p3", domain: "staging.gaiada.com", umamiSiteId: "u3", verifiedAt: "2026-10-01" },
    ];
    expect(matchProperty(["gaiada.com", "staging.gaiada.com"], rows)).toEqual({ id: "p2", umamiSiteId: "u2" });
    expect(matchProperty(["staging.gaiada.com"], rows)?.id).toBe("p3");
    expect(matchProperty(["other.test"], rows)).toBeNull();
    expect(normDomain(" WWW.Gaiada.com. ")).toBe("gaiada.com");
  });
  it("environment domains: production first, a missing hostname skipped", () => {
    expect(domainsOf([{ name: "staging", domain: "staging.x.test" }, { name: "production", domain: "x.test" }, { name: "dev", domain: null }, "junk"])).toEqual(["x.test", "staging.x.test"]);
    expect(domainsOf(undefined)).toEqual([]);
  });
  it("parses Umami path rows and the expanded rows, normalising the path", () => {
    const p = parseUmamiPaths([{ x: "/blog/a/", y: 10 }, { x: "/blog/a", y: 5 }, { x: "/", y: 7 }, { x: 3, y: 1 }]);
    expect(p).toMatchObject({ covered: true, truncated: false });
    expect(p.byPath.get("/blog/a")).toBe(15);
    expect(p.byPath.get("/")).toBe(7);
    expect(parseUmamiPaths([])).toMatchObject({ covered: false });
    expect(parseUmamiPaths(Array.from({ length: 500 }, (_, i) => ({ x: `/p${i}`, y: 1 }))).truncated).toBe(true);
    expect(parseUmamiTime([{ name: "/blog/a/", pageviews: 10, visitors: 8, visits: 9, bounces: 1, totaltime: 900 }])?.get("/blog/a")).toEqual({ pageviews: 10, visits: 9, totaltime: 900 });
    expect(parseUmamiTime({ not: "an array" })).toBeNull();
  });
  it("candidate stored spellings of a path", () => {
    expect(candidatePaths(["/blog/a", "/"]).sort()).toEqual(["", "/", "/blog/a", "/blog/a/"]);
  });
  it("THE LEAD QUERY SELECTS NO IDENTITY: three columns, none of them a lead id, a name, an address or a note", () => {
    const select = LEADS_SQL.slice(LEADS_SQL.indexOf("SELECT") + 6, LEADS_SQL.indexOf("FROM")).replace(/\s+/g, " ").trim();
    expect(select).toBe("created_at, attribution->>'landing' AS landing, attribution->>'form_page' AS form_page");
    for (const bad of ["org_name", "contact_name", "contact_email", "contact_phone", "notes", "visitor_consent", "SELECT id", "submission_ref", "fbp", "gclid"]) {
      expect(LEADS_SQL).not.toContain(bad);
    }
    expect(LEADS_SQL).toContain("erased_at IS NULL");
    expect(LEADS_SQL).toContain("deleted_at IS NULL");
    expect(LEADS_SQL).toContain("web_site_slug = $2");
  });
  it("every search read is tenant- and property-scoped, and Search Console reads only real (not simulated) rows", () => {
    expect(PROPERTY_SQL).toContain("tenant_id = $1");
    expect(GSC_PAGES_SQL).toContain("property_id = $1");
    expect(GSC_PAGES_SQL).toContain("simulated = false");
    expect(GSC_QUERIES_SQL).toContain("simulated = false");
    expect(GSC_QUERIES_SQL).toContain("HAVING sum(impressions) >= $5");
    expect(DECAY_SQL).toContain("property_id = $1");
  });
  it("the decay detector counts as running only for the exact string 1", () => {
    expect(decayJobEnabled({ SEARCH_DECAY_ENABLED: "1" })).toBe(true);
    for (const v of ["", "true", "0", "2", undefined]) expect(decayJobEnabled({ SEARCH_DECAY_ENABLED: v })).toBe(false);
  });
});

describe("readUmami against a fake Umami", () => {
  const SITE = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
  const settings = { baseUrl: "http://umami.test", apiKey: "umami_secret_key", timeoutMs: 1000 };
  const w = dashboardWindows(NOW, 28);
  const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchWith = (handler: (url: URL) => Response | Promise<Response>) => {
    const calls: URL[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => { const u = new URL(String(input)); calls.push(u); return handler(u); }) as typeof fetch;
    return { fetchImpl, calls };
  };

  it("three GETs: views for both periods and the per-page time", async () => {
    const { fetchImpl, calls } = fetchWith((u) =>
      u.pathname.endsWith("/metrics/expanded") ? reply(200, [{ name: "/blog/a/", pageviews: 12, visits: 10, totaltime: 1000 }])
        : u.searchParams.get("startAt") === String(Date.parse("2026-09-15T00:00:00.000Z")) ? reply(200, [{ x: "/blog/a/", y: 12 }]) : reply(200, [{ x: "/blog/a/", y: 6 }]));
    const r = await readUmami(SITE, w, { settings, fetchImpl });
    expect(r.ok && r.data.current.byPath.get("/blog/a")).toBe(12);
    expect(r.ok && r.data.previous?.byPath.get("/blog/a")).toBe(6);
    expect(r.ok && r.data.time?.get("/blog/a")?.visits).toBe(10);
    expect(calls).toHaveLength(3);
    expect(calls.every((u) => u.pathname.startsWith(`/api/websites/${SITE}/`))).toBe(true);
  });
  it("an outage of the main read is a reason; the expanded or earlier read failing costs only the time or the trend", async () => {
    const down = fetchWith(() => reply(503, {}));
    expect(await readUmami(SITE, w, { settings, fetchImpl: down.fetchImpl })).toMatchObject({ ok: false, reason: { code: "umami_unreachable" } });
    const rejected = fetchWith(() => reply(401, {}));
    expect(await readUmami(SITE, w, { settings, fetchImpl: rejected.fetchImpl })).toMatchObject({ ok: false, reason: { code: "umami_rejected" } });
    const noTime = fetchWith((u) => (u.pathname.endsWith("/expanded") ? reply(404, {}) : reply(200, [{ x: "/a", y: 9 }])));
    const r = await readUmami(SITE, w, { settings, fetchImpl: noTime.fetchImpl });
    expect(r.ok && r.data.time).toBeNull();
    expect(r.ok && r.data.current.byPath.get("/a")).toBe(9);
  });
  it("not configured and not bound are their own reasons and call nothing", async () => {
    const f = fetchWith(() => reply(200, []));
    expect(await readUmami(SITE, w, { settings: null, fetchImpl: f.fetchImpl })).toMatchObject({ ok: false, reason: { code: "umami_not_configured" } });
    expect(await readUmami(null, w, { settings, fetchImpl: f.fetchImpl })).toMatchObject({ ok: false, reason: { code: "umami_not_bound" } });
    expect(f.calls).toHaveLength(0);
  });
  it("the API key never appears in a result", async () => {
    const f = fetchWith(() => reply(503, {}));
    expect(JSON.stringify(await readUmami(SITE, w, { settings, fetchImpl: f.fetchImpl }))).not.toContain("umami_secret_key");
  });
});

// ── the service ──────────────────────────────────────────────────────────────────────────────────

const TENANT = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const site = { tenantSlug: "gaiada", siteId: SITE_ID };

function gateFor(userId: string | undefined): ContentGate {
  const editable = {
    tenant: { slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [] },
    site: { siteId: SITE_ID, name: "Main", kind: "astro", environments: [{ name: "production", domain: "gaiada.com" }, { name: "staging", domain: "staging.gaiada.com" }] },
  } as EditableSite;
  return {
    principal: { userId, roles: [], assurance: "high" } as unknown as Principal,
    tenantId: TENANT,
    require() { return this; },
    resolveSite: async () => editable,
  } as unknown as ContentGate;
}

const row = (itemId: string, slug: string, authorSub: string | null, over: Partial<WdItemRow> = {}): WdItemRow => ({
  itemId, slug, locale: "en", title: slug.toUpperCase(), publishedVersion: 1, authorSub, deleted: false, ...over,
});

interface Fixture {
  collections: WdCollection[];
  items: Record<string, WdItemRow[]>;
  pageSize?: number;
}
function fakeWebdesk(f: Fixture) {
  const calls = { collections: 0, lists: [] as Array<{ key: string; cursor: string | null; limit: number; locale: string | null }> };
  const wd: DashboardWebdesk = {
    async collections() { calls.collections++; return f.collections; },
    async liveItems(_s, key, q) {
      calls.lists.push({ key, cursor: q.cursor, limit: q.limit, locale: q.locale });
      const all = (f.items[key] ?? []).filter((i) => !q.locale || i.locale === q.locale);
      const size = f.pageSize ?? q.limit;
      const start = q.cursor ? Number(q.cursor) : 0;
      const slice = all.slice(start, start + size);
      const more = start + size < all.length;
      return { items: slice, hasMore: more, cursor: more ? String(start + size) : null };
    },
  };
  return { wd, calls };
}

function fakeAuthz(o: { siteWide?: boolean; verdict?: (p: Pair) => PairVerdict; failPairs?: boolean }) {
  const calls = { siteWide: 0, pairs: [] as Pair[][], deny: 0 };
  const authz: DashboardAuthz = {
    async siteWide() { calls.siteWide++; return o.siteWide === true; },
    async pairs(_g, _s, pairs) {
      calls.pairs.push([...pairs]);
      if (o.failPairs) throw new Error("cerbos 500");
      return new Map(pairs.map((p) => [pairKey(p), o.verdict ? o.verdict(p) : { read: false, assign: false }]));
    },
    async deny() { calls.deny++; throw new ForbiddenException("not authorized: cerbos denied read on webdesk_content_item"); },
  };
  return { authz, calls };
}

function fakeSources(sourced?: Partial<Sourced>) {
  const inputs: SourcesInput[] = [];
  const s: DashboardSources = {
    async collect(i) {
      inputs.push(i);
      return {
        umami: sourceOk(umamiOk(Object.fromEntries(i.keys.map((k) => [k, 40])), Object.fromEntries(i.keys.map((k) => [k, 40])))),
        gsc: sourceOk({ currentCovered: true, previousCovered: true, current: new Map(i.keys.map((k) => [k, { clicks: 5, impressions: 50 }])), previous: new Map(), queries: new Map() }),
        leads: sourceOk({ current: new Map(i.keys.map((k) => [k, 1])), previous: new Map() }),
        decay: sourceOk({ enabled: true, byPath: new Map() }),
        ...sourced,
      };
    },
  };
  return { sources: s, inputs };
}

const POST: WdCollection = { key: "post", composition: { ui: { label: "Posts", routePattern: "/{locale}/blog/{slug}/" } }, liveItems: 4, locales: ["en"] };
const POSTS = [row("i1", "mine-1", ME), row("i2", "theirs-1", OTHER), row("i3", "mine-2", ME), row("i4", "theirs-2", OTHER)];

function svc(parts: { wd: DashboardWebdesk; authz: DashboardAuthz; sources?: DashboardSources }) {
  return new WebdeskWritersDashboardService({ webdesk: parts.wd, authz: parts.authz, sources: parts.sources ?? fakeSources().sources });
}

describe("WebdeskWritersDashboardService", () => {
  it("a WRITER (read, no assign) sees only their own articles", async () => {
    const { wd } = fakeWebdesk({ collections: [POST], items: { post: POSTS } });
    const { authz } = fakeAuthz({ verdict: () => ({ read: true, assign: false }) });
    const r = await svc({ wd, authz }).read(gateFor(ME), site, {}, NOW);
    expect(r.items.map((i) => i.itemId)).toEqual(["i1", "i3"]);
    expect(r.items.every((i) => i.mine)).toBe(true);
    expect(r.scope).toBe("scoped");
    expect(JSON.stringify(r)).not.toContain(OTHER);
  });
  it("an EDITOR (assign on the pair) and a STAFF tier (company-level read) see everything in scope", async () => {
    const f = { collections: [POST], items: { post: POSTS } };
    const ed = await svc({ wd: fakeWebdesk(f).wd, authz: fakeAuthz({ verdict: () => ({ read: true, assign: true }) }).authz }).read(gateFor(ME), site, {}, NOW);
    expect(ed.items).toHaveLength(4);
    const staff = fakeAuthz({ siteWide: true });
    const st = await svc({ wd: fakeWebdesk(f).wd, authz: staff.authz }).read(gateFor(ME), site, {}, NOW);
    expect(st.items).toHaveLength(4);
    expect(st.scope).toBe("all_site");
    expect(staff.calls.pairs).toHaveLength(0); // a company-level reader needs no per-pair question
  });
  it("?mine=true narrows even a staff caller to their own", async () => {
    const r = await svc({ wd: fakeWebdesk({ collections: [POST], items: { post: POSTS } }).wd, authz: fakeAuthz({ siteWide: true }).authz }).read(gateFor(ME), site, { mine: "true" }, NOW);
    expect(r.items.map((i) => i.itemId)).toEqual(["i1", "i3"]);
  });
  it("a caller with no authorship does not become 'own' by an empty author (a legacy item has none)", async () => {
    const r = await svc({
      wd: fakeWebdesk({ collections: [POST], items: { post: [row("i9", "legacy", null)] } }).wd,
      authz: fakeAuthz({ verdict: () => ({ read: true, assign: false }) }).authz,
    }).read(gateFor(ME), site, {}, NOW);
    expect(r.items).toEqual([]);
    const anon = await svc({
      wd: fakeWebdesk({ collections: [POST], items: { post: [row("i9", "legacy", null)] } }).wd,
      authz: fakeAuthz({ verdict: () => ({ read: true, assign: false }) }).authz,
    }).read(gateFor(undefined), site, {}, NOW);
    expect(anon.items).toEqual([]);
  });
  it("a pair the caller may not read hides its items; none readable at all is the ordinary 403, never an empty list", async () => {
    const two: WdCollection[] = [POST, { key: "guide", composition: {}, liveItems: 1, locales: ["en"] }];
    const items = { post: POSTS, guide: [row("g1", "g", ME)] };
    const some = await svc({ wd: fakeWebdesk({ collections: two, items }).wd, authz: fakeAuthz({ verdict: (p) => ({ read: p.collectionKey === "guide", assign: false }) }).authz }).read(gateFor(ME), site, {}, NOW);
    expect(some.items.map((i) => i.itemId)).toEqual(["g1"]);
    const none = fakeAuthz({ verdict: () => ({ read: false, assign: true }) });
    await expect(svc({ wd: fakeWebdesk({ collections: two, items }).wd, authz: none.authz }).read(gateFor(ME), site, {}, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(none.calls.deny).toBe(1);
  });
  it("DENIAL BEFORE VALIDATION: a denied caller with a bad query is 403, not 400; the same query from an allowed caller is 400", async () => {
    const f = { collections: [POST], items: { post: POSTS } };
    const denied = svc({ wd: fakeWebdesk(f).wd, authz: fakeAuthz({ verdict: () => ({ read: false, assign: false }) }).authz });
    await expect(denied.read(gateFor(ME), site, { period: "banana", extra: "1" }, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    const allowed = svc({ wd: fakeWebdesk(f).wd, authz: fakeAuthz({ siteWide: true }).authz });
    await expect(allowed.read(gateFor(ME), site, { period: "banana" }, NOW)).rejects.toMatchObject({ status: 400 });
    expect((await allowed.read(gateFor(ME), site, { period: "7d" }, NOW)).items.length).toBeGreaterThan(0); // positive control
  });
  it("a Cerbos failure is a 503 (we cannot tell what you may see), never an empty dashboard", async () => {
    const r = svc({ wd: fakeWebdesk({ collections: [POST], items: { post: POSTS } }).wd, authz: fakeAuthz({ failPairs: true }).authz }).read(gateFor(ME), site, {}, NOW);
    await expect(r).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it("WebDesk failing is the whole read's 503", async () => {
    const wd: DashboardWebdesk = { collections: async () => { throw new ServiceUnavailableException({ message: "webdesk_unavailable" }); }, liveItems: async () => ({ items: [], hasMore: false, cursor: null }) };
    await expect(svc({ wd, authz: fakeAuthz({ siteWide: true }).authz }).read(gateFor(ME), site, {}, NOW)).rejects.toMatchObject({ status: 503 });
  });
  it("an Umami outage keeps every row and nulls only the Umami figures, with a reason, and says so in the source banner", async () => {
    const { sources } = fakeSources({ umami: sourceFail("umami_unreachable") });
    const r = await svc({ wd: fakeWebdesk({ collections: [POST], items: { post: POSTS } }).wd, authz: fakeAuthz({ siteWide: true }).authz, sources }).read(gateFor(ME), site, {}, NOW);
    expect(r.items).toHaveLength(4);
    for (const i of r.items) {
      expect(i.metrics.views.value).toBeNull();
      expect(i.metrics.views.reason?.code).toBe("umami_unreachable");
      expect(i.metrics.clicks.value).not.toBeNull();
    }
    expect(r.sources.umami).toMatchObject({ state: "unavailable", reason: { code: "umami_unreachable" } });
    expect(r.sources.search).toEqual({ state: "ok" });
  });
  it("the sources are asked once, for the page paths only, with the site's domains (production first)", async () => {
    const fx = fakeSources();
    await svc({ wd: fakeWebdesk({ collections: [POST], items: { post: POSTS } }).wd, authz: fakeAuthz({ siteWide: true }).authz, sources: fx.sources }).read(gateFor(ME), site, { period: "7d" }, NOW);
    expect(fx.inputs).toHaveLength(1);
    expect(fx.inputs[0]).toMatchObject({ tenantId: TENANT, tenantSlug: "gaiada", domains: ["gaiada.com", "staging.gaiada.com"], days: 7 });
    expect([...fx.inputs[0].keys].sort()).toEqual(["/blog/mine-1", "/blog/mine-2", "/blog/theirs-1", "/blog/theirs-2"]);
  });
  it("a collection with no page address lists its items, says so, and asks no source", async () => {
    const bare: WdCollection = { key: "guide", composition: { ui: { label: "Guides" } }, liveItems: 1, locales: ["en"] };
    const fx = fakeSources();
    const r = await svc({ wd: fakeWebdesk({ collections: [bare], items: { guide: [row("g1", "g", ME)] } }).wd, authz: fakeAuthz({ siteWide: true }).authz, sources: fx.sources }).read(gateFor(ME), site, {}, NOW);
    expect(r.items[0].pagePath).toBeNull();
    expect(r.items[0].pagePathReason?.code).toBe("no_route_pattern");
    expect(r.items[0].metrics.views.reason?.code).toBe("no_route_pattern");
    expect(fx.inputs).toHaveLength(0);
    expect(r.sources.umami).toEqual({ state: "not_asked" });
  });
  it("only published, undeleted items are listed even if WebDesk's filter let others through", async () => {
    const items = [row("p", "pub", ME), row("d", "draft", ME, { publishedVersion: null }), row("x", "gone", ME, { deleted: true })];
    const r = await svc({ wd: fakeWebdesk({ collections: [POST], items: { post: items } }).wd, authz: fakeAuthz({ siteWide: true }).authz }).read(gateFor(ME), site, {}, NOW);
    expect(r.items.map((i) => i.itemId)).toEqual(["p"]);
  });
  it("collections with no published item are not scanned; the locale and collection filters narrow", async () => {
    const cols: WdCollection[] = [POST, { key: "empty", composition: {}, liveItems: 0, locales: [] }, { key: "page", composition: {}, liveItems: 1, locales: ["en", "id"] }];
    const fx = fakeWebdesk({ collections: cols, items: { post: POSTS, page: [row("a", "a", ME), row("b", "b", ME, { locale: "id" })] } });
    const az = fakeAuthz({ siteWide: true });
    await svc({ wd: fx.wd, authz: az.authz }).read(gateFor(ME), site, { collection: "page", locale: "id" }, NOW);
    expect(fx.calls.lists.map((l) => `${l.key}:${l.locale}`)).toEqual(["page:id"]);
    await expect(svc({ wd: fx.wd, authz: az.authz }).read(gateFor(ME), site, { collection: "nope" }, NOW)).rejects.toMatchObject({ status: 404 });
  });
  it("pagination: collections in key order, the cursor carries on exactly where the page stopped", async () => {
    const mk = (n: number, p: string) => Array.from({ length: n }, (_, i) => row(`${p}${i}`, `${p}-${i}`, ME));
    const cols: WdCollection[] = [{ ...POST, key: "post", liveItems: 5 }, { key: "page", composition: {}, liveItems: 3, locales: ["en"] }];
    const fx = fakeWebdesk({ collections: cols, items: { post: mk(5, "po"), page: mk(3, "pa") } });
    const s = svc({ wd: fx.wd, authz: fakeAuthz({ siteWide: true }).authz });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await s.read(gateFor(ME), site, { limit: "2", ...(cursor ? { cursor } : {}) }, NOW);
      seen.push(...r.items.map((x) => x.itemId));
      expect(r.page.limit).toBe(2);
      if (!r.page.hasMore) { expect(r.page.cursor).toBeNull(); break; }
      cursor = r.page.cursor;
      expect(cursor).not.toBeNull();
    }
    expect(seen).toEqual(["pa0", "pa1", "pa2", "po0", "po1", "po2", "po3", "po4"]); // `page` sorts before `post`
    await expect(s.read(gateFor(ME), site, { cursor: "junk" }, NOW)).rejects.toMatchObject({ status: 400 });
    await expect(s.read(gateFor(ME), site, { cursor: encodeCursor({ collection: "elsewhere", webdesk: null }) }, NOW)).rejects.toMatchObject({ status: 400 });
  });
  it("a page whose rows are all filtered out reads on (bounded), so a writer is not shown a blank page for no reason", async () => {
    const theirs = (n: number) => Array.from({ length: n }, (_, i) => row(`t${i}`, `t-${i}`, OTHER));
    const allowWriter = fakeAuthz({ verdict: () => ({ read: true, assign: false }) }).authz;
    const found = fakeWebdesk({ collections: [{ ...POST, liveItems: 7 }], items: { post: [...theirs(6), row("mine", "mine", ME)] }, pageSize: 2 });
    const r = await svc({ wd: found.wd, authz: allowWriter }).read(gateFor(ME), site, { limit: "2" }, NOW);
    expect(r.items.map((i) => i.itemId)).toEqual(["mine"]);
    expect(found.calls.lists).toHaveLength(4);
    // beyond the budget it stops and says there is more, rather than reading the whole site in one request
    const deep = fakeWebdesk({ collections: [{ ...POST, liveItems: 30 }], items: { post: [...theirs(29), row("mine", "mine", ME)] }, pageSize: 2 });
    const d = await svc({ wd: deep.wd, authz: allowWriter }).read(gateFor(ME), site, { limit: "2" }, NOW);
    expect(d.items).toEqual([]);
    expect(d.page.hasMore).toBe(true);
    expect(deep.calls.lists).toHaveLength(5);
  });
  it("pair questions: one per (collection, language) with published items, however many there are", async () => {
    const cols: WdCollection[] = Array.from({ length: 60 }, (_, i) => ({ key: `c${String(i).padStart(2, "0")}`, composition: {}, liveItems: 1, locales: ["en", "id"] }));
    const az = fakeAuthz({ verdict: () => ({ read: true, assign: true }) });
    await svc({ wd: fakeWebdesk({ collections: cols, items: {} }).wd, authz: az.authz }).read(gateFor(ME), site, {}, NOW);
    expect(az.calls.pairs).toHaveLength(1);
    expect(az.calls.pairs[0]).toHaveLength(120);
  });
});

describe("pairVerdicts: Cerbos is asked in groups of at most 50", () => {
  it("120 pairs make 120 questions with never more than 50 in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    let asked = 0;
    const check = async (_p: Principal, _r: Resource, actions: readonly string[]) => {
      asked++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return Object.fromEntries(actions.map((a) => [a, a === "read"]));
    };
    const pairs: Pair[] = Array.from({ length: 120 }, (_, i) => ({ collectionKey: `c${i}`, locale: "en" }));
    const out = await pairVerdicts({ userId: ME, roles: [], assurance: "high" } as unknown as Principal, (p) => ({ kind: "webdesk_content_item", collectionKey: p.collectionKey, locale: p.locale }), pairs, check);
    expect(asked).toBe(120);
    expect(peak).toBeLessThanOrEqual(50);
    expect(peak).toBeGreaterThan(1);
    expect(out.size).toBe(120);
    expect(out.get(pairKey(pairs[7]))).toEqual({ read: true, assign: false });
  });
  it("asks for read and assign together, on the pair's own collection and language", async () => {
    const seen: Array<{ actions: readonly string[]; r: Resource }> = [];
    await pairVerdicts({ userId: ME, roles: [], assurance: "high" } as unknown as Principal, (p) => ({ kind: "webdesk_content_item", collectionKey: p.collectionKey, locale: p.locale }),
      [{ collectionKey: "post", locale: "id" }], async (_p, r, actions) => { seen.push({ actions, r }); return { read: true, assign: true }; });
    expect(seen).toHaveLength(1);
    expect([...seen[0].actions].sort()).toEqual(["assign", "read"]);
    expect(seen[0].r).toMatchObject({ collectionKey: "post", locale: "id" });
  });
});

describe("parseQuery", () => {
  it("defaults, and the allowed values", () => {
    expect(parseQuery({})).toMatchObject({ period: "28d", mine: false, limit: 25, collection: null, locale: null, cursor: null });
    expect(parseQuery(undefined)).toMatchObject({ period: "28d" });
    expect(parseQuery({ period: "90d", mine: "true", limit: "100", collection: "post", locale: "id" })).toMatchObject({ period: "90d", mine: true, limit: 100, collection: "post", locale: "id" });
  });
  it("refuses junk with a 400", () => {
    for (const bad of [{ period: "1y" }, { mine: "yes" }, { limit: "0" }, { limit: "101" }, { limit: "2.5" }, { collection: "" }, { locale: "x".repeat(40) }, { cursor: "zzz" }, { siteId: "x" }, { limit: ["1", "2"] }]) {
      expect(() => parseQuery(bad)).toThrow(HttpException);
    }
  });
});

describe("MCP tool", () => {
  it("webdesk.writers.dashboard is a read: GET, no write flag, no impact class, on the BFF route", () => {
    const t = webdevModule.mcpTools.find((x) => x.name === "webdesk.writers.dashboard");
    expect(t).toBeTruthy();
    expect(t).toMatchObject({ method: "GET", minAssurance: "low", pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/writers/dashboard" });
    expect(t!.write).toBeUndefined();
    expect((t as { impact?: string }).impact).toBeUndefined();
    expect(t!.inputSchema).toMatchObject({ required: ["tenantId", "tenantSlug", "siteId"] });
    expect(t!.description).toMatch(/never a visitor, a lead's name, address or id/i);
  });
});
