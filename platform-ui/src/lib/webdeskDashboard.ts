import "server-only";
// M5-W8 — the reader and the strict wire validation for the writer dashboard (server-only half; types and copy are in
// `webdeskDashboardModel.ts`). Same rules as `webdeskContent.ts` / `webdeskEditorial.ts`, whose `wire` / `wdCall` / `siteBase` this reuses:
// EVERY 2xx body is validated before it is returned; a body that does not match is `contract_drift` (never rendered as data); no path
// turns a refusal into an empty list.
//
//   GET …/writers/dashboard[?period&collection&locale&mine&cursor&limit] -> {tenantSlug, siteId, period, windows, scope, sources, items[], page}
//
// What this parser refuses on purpose (each is drift, so a BFF bug shows as a defect and not as a wrong number on a card):
//  * a metric with BOTH a value and a reason, or with NEITHER (a figure must be a figure or an explained absence, never a silent null);
//  * a raw number under 5 for a view count (a small cell must arrive as "<5"; the BFF applies the rule, the UI never has to);
//  * a trend with no two numbers to compare;
//  * a lead count that is not a plain number.
import { siteBase, wdCall, wire, WireDrift } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import type {
  Count, CountWithTrend, DashboardItem, DashboardMetrics, DashboardFilters, DayWindow, DecayInfo, Metric, Reason, SourceStatus, TopQuery, Trend,
  WindowPair, WritersDashboard,
} from "./webdeskDashboardModel";
import { isPeriodKey } from "./webdeskDashboardModel";

const { str, int, bool, nullable, arr, obj, key } = wire;
const strN = nullable(str);
type P<T> = (v: unknown, path: string) => T;

function parseReason(v: unknown, path: string): Reason {
  const o = obj(v, path);
  const text = key(o, "text", str, path);
  if (text.trim() === "") throw new WireDrift(`${path}.text`, "words", text);
  return { code: key(o, "code", str, path), text };
}

/** `{ value, reason }`: exactly one is non-null. */
function metric<T>(p: P<T>): P<Metric<T>> {
  return (v, path) => {
    const o = obj(v, path);
    const value = key(o, "value", nullable(p), path);
    const reason = key(o, "reason", (r, rp) => (r === null ? null : parseReason(r, rp)), path);
    if (value === null && reason === null) throw new WireDrift(path, "a value or a reason (a figure is never silently null)", null);
    if (value !== null && reason !== null) throw new WireDrift(path, "a value or a reason, not both", { value, reason });
    return (value !== null ? { value, reason: null } : { value: null, reason: reason as Reason }) as Metric<T>;
  };
}

const exactCount: P<number> = (v, path) => {
  const n = int(v, path);
  if (n < 0) throw new WireDrift(path, "a count >= 0", v);
  return n;
};
/** A visitor count: a number of at least 5, or the string "<5". A raw 0..4 is the BFF breaking the small-cell rule. */
const viewCount: P<Count> = (v, path) => {
  if (v === "<5") return v;
  const n = exactCount(v, path);
  if (n < 5) throw new WireDrift(path, 'a count of at least 5, or "<5"', v);
  return n;
};
const trend: P<Trend | null> = (v, path) => {
  if (v === null) return null;
  if (v === "up" || v === "down" || v === "flat") return v;
  throw new WireDrift(path, "up | down | flat | null", v);
};

function figure(count: P<Count>): P<CountWithTrend> {
  return (v, path) => {
    const o = obj(v, path);
    const current = key(o, "current", count, path);
    const previous = key(o, "previous", nullable(count), path);
    const t = key(o, "trend", trend, path);
    if (t !== null && (typeof current !== "number" || typeof previous !== "number")) throw new WireDrift(`${path}.trend`, "null unless both periods are numbers", t);
    return { current, previous, trend: t };
  };
}

function parseTopQuery(v: unknown, path: string): TopQuery {
  const o = obj(v, path);
  return { query: key(o, "query", str, path), clicks: key(o, "clicks", exactCount, path), impressions: key(o, "impressions", exactCount, path) };
}

function parseDecay(v: unknown, path: string): "none" | DecayInfo {
  if (v === "none") return "none";
  const o = obj(v, path);
  return {
    findingId: key(o, "findingId", str, path), status: key(o, "status", str, path), reason: key(o, "reason", str, path),
    detectedAt: key(o, "detectedAt", str, path), briefId: key(o, "briefId", strN, path),
  };
}

function parseMetrics(v: unknown, path: string): DashboardMetrics {
  const o = obj(v, path);
  return {
    views: key(o, "views", metric(figure(viewCount)), path),
    avgSeconds: key(o, "avgSeconds", metric((x, p) => ({ seconds: key(obj(x, p), "seconds", exactCount, p) })), path),
    clicks: key(o, "clicks", metric(figure(exactCount)), path),
    impressions: key(o, "impressions", metric(figure(exactCount)), path),
    topQueries: key(o, "topQueries", metric(arr(parseTopQuery)), path),
    leads: key(o, "leads", metric(figure(exactCount)), path),
  };
}

function parseItem(v: unknown, path: string): DashboardItem {
  const o = obj(v, path);
  const pagePath = key(o, "pagePath", strN, path);
  const pagePathReason = key(o, "pagePathReason", (r, rp) => (r === null ? null : parseReason(r, rp)), path);
  // A path and the reason there is none are two halves of one fact.
  if ((pagePath === null) === (pagePathReason === null)) throw new WireDrift(`${path}.pagePath`, "a path, or null with pagePathReason", pagePath);
  return {
    itemId: key(o, "itemId", str, path), collectionKey: key(o, "collectionKey", str, path), locale: key(o, "locale", str, path),
    slug: key(o, "slug", str, path), title: key(o, "title", strN, path), publishedVersion: key(o, "publishedVersion", int, path),
    mine: key(o, "mine", bool, path), pagePath, pagePathReason,
    metrics: key(o, "metrics", parseMetrics, path),
    decay: key(o, "decay", metric(parseDecay), path),
  };
}

function parseWindow(v: unknown, path: string): DayWindow {
  const o = obj(v, path);
  return { from: key(o, "from", str, path), to: key(o, "to", str, path) };
}
function parseWindowPair(v: unknown, path: string): WindowPair {
  const o = obj(v, path);
  return { current: key(o, "current", parseWindow, path), previous: key(o, "previous", parseWindow, path) };
}

function parseSource(v: unknown, path: string): SourceStatus {
  const o = obj(v, path);
  const state = key(o, "state", str, path);
  if (state === "ok" || state === "not_asked") return { state };
  if (state === "unavailable") return { state, reason: key(o, "reason", parseReason, path) };
  throw new WireDrift(`${path}.state`, "ok | unavailable | not_asked", state);
}

export function parseDashboard(v: unknown): WritersDashboard {
  const p = "dashboard";
  const o = obj(v, p);
  const scope = key(o, "scope", str, p);
  if (scope !== "all_site" && scope !== "scoped") throw new WireDrift(`${p}.scope`, "all_site | scoped", scope);
  const sources = obj(key(o, "sources", obj, p), `${p}.sources`);
  const period = obj(key(o, "period", obj, p), `${p}.period`);
  const windows = obj(key(o, "windows", obj, p), `${p}.windows`);
  const page = obj(key(o, "page", obj, p), `${p}.page`);
  return {
    tenantSlug: key(o, "tenantSlug", str, p), siteId: key(o, "siteId", str, p),
    period: { key: key(period, "key", str, `${p}.period`), days: key(period, "days", int, `${p}.period`) },
    windows: { traffic: key(windows, "traffic", parseWindowPair, `${p}.windows`), search: key(windows, "search", parseWindowPair, `${p}.windows`) },
    scope,
    sources: {
      umami: key(sources, "umami", parseSource, `${p}.sources`), search: key(sources, "search", parseSource, `${p}.sources`),
      leads: key(sources, "leads", parseSource, `${p}.sources`), decay: key(sources, "decay", parseSource, `${p}.sources`),
    },
    items: key(o, "items", arr(parseItem), p),
    page: { cursor: key(page, "cursor", strN, `${p}.page`), hasMore: key(page, "hasMore", bool, `${p}.page`), limit: key(page, "limit", int, `${p}.page`) },
  };
}

// ── Reader ───────────────────────────────────────────────────────────────────────────────────────

export function getWritersDashboard(userId: string, company: string, tenantSlug: string, siteId: string, f: DashboardFilters = {}): Promise<WdResult<WritersDashboard>> {
  const q = new URLSearchParams();
  if (isPeriodKey(f.period)) q.set("period", f.period);
  if (f.collection) q.set("collection", f.collection);
  if (f.locale) q.set("locale", f.locale);
  if (f.mine) q.set("mine", "true");
  if (f.cursor) q.set("cursor", f.cursor);
  q.set("limit", "25");
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/writers/dashboard?${q.toString()}`, userId, parseDashboard);
}
