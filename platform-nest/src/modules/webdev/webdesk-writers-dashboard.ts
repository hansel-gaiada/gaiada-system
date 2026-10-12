// M5-W8 — the writer dashboard's PURE core: no DB, no network, no clock, no Cerbos. The orchestration (the gate, the
// WebDesk reads, the Cerbos pair checks, the four data sources) is `webdesk-writers-dashboard.service.ts`; this file is
// everything that decides what a figure MEANS, so each rule is testable from plain values.
//
// THE RULES THIS FILE PINS
//  * MISSING IS NOT ZERO. Every metric is `{ value, reason }`: a value, or null with a typed reason in plain words. A source
//    that did not answer (Umami down, no Search Console rows, a failed read) can never turn into a 0.
//  * COUNTS ONLY. A lead is a number here, never an id, a name or an address (the SQL in the sources file selects none of
//    them). Umami view counts under 5 are "<5" (visitor addendum R-V6), exactly as the A4 reads do.
//  * A PAGE PATH COMES FROM THE COMPOSITION. `composition.ui.routePattern` (vocabulary 1.4.0: "/blog/{slug}/", "/{locale}/blog/{slug}/")
//    turns an item into the page it is served at, through the vocabulary's own `pagePathFor`. No pattern, or one that cannot be applied, is said in words and the
//    item's figures are all "unavailable" (a guessed path would attach another page's numbers to it).
import { normalizePagePath, DECAY_DATA_LAG_DAYS, MIN_GSC_COVERAGE_DAYS } from "../search/content-decay";
import { SUPPRESS_BELOW, suppress, type Count } from "../search/umami-reads";
import { pagePathFor, routePatternProblem } from "./vocabulary/composition";

// ── reasons ──────────────────────────────────────────────────────────────────────────────────────

export const REASON_TEXT = {
  no_route_pattern: "This collection has no public page address on record, so no page figures can be matched to its items.",
  bad_route_pattern: "This collection's page address pattern is not one the dashboard can use.",
  slug_not_routable: "This item's address contains characters that cannot be turned into a public page address.",
  locale_not_routable: "This language has no page address in the collection's address pattern.",
  no_search_property: "This website is not linked to a Search Console property in the search tool, so search and analytics figures are unavailable.",
  umami_not_configured: "Website analytics is not set up on this server yet.",
  umami_not_bound: "The search property for this website is not linked to an analytics site yet.",
  umami_unreachable: "Website analytics could not be reached. Try again in a moment.",
  umami_rejected: "Website analytics refused the request, so no figures are shown.",
  umami_no_data: "Website analytics has recorded no visits for this period, so figures are unavailable.",
  umami_truncated: "This page is not among the pages analytics lists for this period, so its views are unknown, not zero.",
  umami_no_time: "Analytics did not give a reading time for this page.",
  small_cell: "Fewer than 5 visits, so no average is shown.",
  gsc_no_data: "Search Console has too little data for this period, so figures are unavailable.",
  search_unavailable: "Search figures could not be read right now.",
  leads_unavailable: "Lead counts could not be read right now.",
  decay_unavailable: "The decay check could not be read right now.",
  decay_off: "The decay check is switched off on this server, so \"no alert\" would not mean the page is healthy.",
} as const;
export type ReasonCode = keyof typeof REASON_TEXT;
export interface Reason { code: ReasonCode; text: string }
export const reasonOf = (code: ReasonCode): Reason => ({ code, text: REASON_TEXT[code] });

/** A figure, or null with the reason it is not available. `value` is never a placeholder zero. */
export type Metric<T> = { value: T; reason: null } | { value: null; reason: Reason };
export const ok = <T>(value: T): Metric<T> => ({ value, reason: null });
export const unavailable = <T>(code: ReasonCode): Metric<T> => ({ value: null, reason: reasonOf(code) });

export type SourceResult<T> = { ok: true; data: T } | { ok: false; reason: Reason };
export const sourceOk = <T>(data: T): SourceResult<T> => ({ ok: true, data });
export const sourceFail = (code: ReasonCode): SourceResult<never> => ({ ok: false, reason: reasonOf(code) });

// ── period and windows ───────────────────────────────────────────────────────────────────────────

export const DASHBOARD_PERIODS = { "7d": 7, "28d": 28, "90d": 90 } as const;
export type DashboardPeriod = keyof typeof DASHBOARD_PERIODS;
export const DEFAULT_PERIOD: DashboardPeriod = "28d";
export const isPeriod = (v: string): v is DashboardPeriod => Object.prototype.hasOwnProperty.call(DASHBOARD_PERIODS, v);

export interface DayWindow { from: string; to: string } // YYYY-MM-DD, inclusive, UTC
export interface WindowPair { current: DayWindow; previous: DayWindow }
export interface DashboardWindows {
  /** Umami and leads: the `days` days ending today (UTC) and the `days` before them. */
  traffic: WindowPair;
  /** Search Console settles late: the same two windows, shifted back by the decay job's own lag. */
  search: WindowPair;
}

const DAY = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function dashboardWindows(now: Date, days: number): DashboardWindows {
  const today = Date.parse(`${isoDay(now.getTime())}T00:00:00Z`);
  const pair = (end: number): WindowPair => ({
    current: { from: isoDay(end - (days - 1) * DAY), to: isoDay(end) },
    previous: { from: isoDay(end - (2 * days - 1) * DAY), to: isoDay(end - days * DAY) },
  });
  return { traffic: pair(today), search: pair(today - DECAY_DATA_LAG_DAYS * DAY) };
}

export const startOf = (d: string): number => Date.parse(`${d}T00:00:00.000Z`);
export const endOf = (d: string): number => Date.parse(`${d}T23:59:59.999Z`);

/** Search Console rows on at least this many days of a window make it measurable (half of it, 3 to 14 days). */
export function gscMinCoverageDays(days: number): number {
  return Math.min(MIN_GSC_COVERAGE_DAYS, Math.max(3, Math.ceil(days / 2)));
}

// ── the page path of an item ─────────────────────────────────────────────────────────────────────

export interface PathInput {
  /** `composition.ui.routePattern`, whatever the composition held (unknown on purpose). */
  pattern: unknown;
  slug: string;
  locale: string;
  defaultLocale: string;
  /** `composition.localized !== false`. */
  localized: boolean;
}

/**
 * item -> the public page path, or the reason there is none.
 *
 * The grammar and the filling-in are the vocabulary's own (1.4.0, M5-W8b: `routePatternProblem`, `pagePathFor`): an absolute path
 * of literal `[a-z0-9-]` segments, `{slug}` exactly once and `{locale}` at most once, each a whole segment. For the tenant's DEFAULT
 * language the `/{locale}` segment is left out. This adds one rule of the dashboard's own: a LOCALIZED collection whose pattern has no
 * `{locale}` has no address for a non-default language (the same address would be claimed by every language), so that item has none.
 */
export function resolvePagePath(a: PathInput): { path: string } | { reason: ReasonCode } {
  if (a.pattern === undefined || a.pattern === null || a.pattern === "") return { reason: "no_route_pattern" };
  if (routePatternProblem(a.pattern) !== null) return { reason: "bad_route_pattern" };
  const pattern = a.pattern as string;
  const hasLocale = /(^|\/)\{locale\}(\/|$)/.test(pattern);
  if (a.localized && a.locale !== a.defaultLocale && !hasLocale) return { reason: "locale_not_routable" };
  const path = pagePathFor(pattern, { slug: a.slug, locale: a.locale, defaultLocale: a.defaultLocale });
  if (path !== null) return { path };
  // a valid pattern that did not resolve: the slug or the language cannot be put in a URL (a stand-in slug tells which)
  return pagePathFor(pattern, { slug: "x", locale: a.locale, defaultLocale: a.defaultLocale }) === null ? { reason: "locale_not_routable" } : { reason: "slug_not_routable" };
}

/** The composition's pattern, defensively: the key may not exist (it is not in the vocabulary yet). */
export function routePatternOf(composition: unknown): unknown {
  const c = composition !== null && typeof composition === "object" ? (composition as Record<string, unknown>) : {};
  const ui = c.ui !== null && typeof c.ui === "object" ? (c.ui as Record<string, unknown>) : {};
  return ui.routePattern;
}
export const isLocalized = (composition: unknown): boolean =>
  !(composition !== null && typeof composition === "object" && (composition as Record<string, unknown>).localized === false);

/** The match key shared by every source: the same normalisation the decay job and the search tables use. */
export const pathKey = (publicPath: string): string | null => normalizePagePath(publicPath);

// ── trends and the metric shapes ─────────────────────────────────────────────────────────────────

export type Trend = "up" | "down" | "flat";
export interface CountWithTrend {
  current: Count;
  /** The same figure for the period before; null when that period could not be measured (or is a small cell). */
  previous: Count | null;
  /** Direction, only when both periods are real numbers (never from a "<5"). */
  trend: Trend | null;
}

/** Up or down when the change is more than 5 % of the earlier figure (any change from zero counts); otherwise flat. */
export function trendOf(current: number, previous: number): Trend {
  const delta = current - previous;
  if (Math.abs(delta) <= previous * 0.05) return "flat";
  return delta > 0 ? "up" : "down";
}

/** A visitor count: small cells are "<5" and give no trend. */
export function viewsFigure(current: number, previous: number | null): CountWithTrend {
  return {
    current: suppress(current),
    previous: previous === null ? null : suppress(previous),
    trend: previous !== null && current >= SUPPRESS_BELOW && previous >= SUPPRESS_BELOW ? trendOf(current, previous) : null,
  };
}
/** A count that is not a visitor cell (Search Console clicks and impressions, lead counts): exact. */
export function exactFigure(current: number, previous: number | null): CountWithTrend {
  return { current, previous, trend: previous === null ? null : trendOf(current, previous) };
}

export interface TopQuery { query: string; clicks: number; impressions: number }
/** A query shows only with at least this many impressions in the period (a rare query can be one person's). */
export const MIN_QUERY_IMPRESSIONS = 5;
export const TOP_QUERIES = 3;

export function topQueriesOf(rows: readonly TopQuery[]): TopQuery[] {
  return rows
    .filter((r) => r.impressions >= MIN_QUERY_IMPRESSIONS && r.query !== "")
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.query.localeCompare(b.query))
    .slice(0, TOP_QUERIES);
}

export interface DecayInfo {
  findingId: string;
  status: string;
  /** The finding's own words (counts only; a view count under 5 was written "fewer than 5"). */
  reason: string;
  detectedAt: string;
  briefId: string | null;
}

export interface DashboardMetrics {
  views: Metric<CountWithTrend>;
  /** Average seconds per visit that includes this page (Umami: total time / visits), the closest reading-depth figure A4 offers. */
  avgSeconds: Metric<{ seconds: number }>;
  clicks: Metric<CountWithTrend>;
  impressions: Metric<CountWithTrend>;
  topQueries: Metric<TopQuery[]>;
  /** Web leads whose landing page or form page is this page. A number: never a name, an address or an id. */
  leads: Metric<CountWithTrend>;
}

export interface DashboardItem {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  title: string | null;
  publishedVersion: number;
  /** The caller wrote it (WebDesk's author = the caller's id). */
  mine: boolean;
  /** The public path the item is served at; null with `pagePathReason` when it has none. */
  pagePath: string | null;
  pagePathReason: Reason | null;
  metrics: DashboardMetrics;
  decay: Metric<"none" | DecayInfo>;
}

// ── the data each source hands to the assembler (keyed by `pathKey`) ─────────────────────────────

export interface UmamiPathViews { covered: boolean; truncated: boolean; byPath: Map<string, number> }
export interface UmamiTimeRow { pageviews: number; visits: number; totaltime: number }
export interface UmamiData {
  current: UmamiPathViews;
  /** null when the earlier period could not be read: the trend is then absent, the current figure still shows. */
  previous: UmamiPathViews | null;
  /** null when analytics gave no per-page time. */
  time: Map<string, UmamiTimeRow> | null;
}
export interface GscAgg { clicks: number; impressions: number }
export interface GscData {
  currentCovered: boolean;
  previousCovered: boolean;
  current: Map<string, GscAgg>;
  previous: Map<string, GscAgg>;
  queries: Map<string, TopQuery[]>;
}
export interface LeadData { current: Map<string, number>; previous: Map<string, number> }
export interface DecayData { enabled: boolean; byPath: Map<string, DecayInfo> }

/** What `assembleItems` needs about one item, from WebDesk's list row and the Cerbos verdicts. */
export interface PageItem {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  title: string | null;
  publishedVersion: number;
  mine: boolean;
  path: { path: string } | { reason: ReasonCode };
}

/** A source that failed: every item's metric of that source carries its reason. */
export interface Sourced {
  umami: SourceResult<UmamiData>;
  gsc: SourceResult<GscData>;
  leads: SourceResult<LeadData>;
  decay: SourceResult<DecayData>;
}

function viewsMetric(key: string, u: UmamiData): Metric<CountWithTrend> {
  if (!u.current.covered) return unavailable("umami_no_data");
  const n = u.current.byPath.get(key);
  if (n === undefined && u.current.truncated) return unavailable("umami_truncated");
  const cur = n ?? 0;
  let prev: number | null = null;
  if (u.previous && u.previous.covered) {
    const p = u.previous.byPath.get(key);
    prev = p === undefined ? (u.previous.truncated ? null : 0) : p;
  }
  return ok(viewsFigure(cur, prev));
}

function secondsMetric(key: string, u: UmamiData): Metric<{ seconds: number }> {
  const views = u.current.byPath.get(key);
  const row = u.time?.get(key);
  if (!u.time || !row || views === undefined || row.pageviews !== views) return unavailable("umami_no_time");
  if (row.visits < SUPPRESS_BELOW) return unavailable("small_cell");
  return ok({ seconds: Math.round(row.totaltime / row.visits) });
}

function gscMetric(key: string, g: GscData, pick: "clicks" | "impressions"): Metric<CountWithTrend> {
  if (!g.currentCovered) return unavailable("gsc_no_data");
  const cur = g.current.get(key)?.[pick] ?? 0;
  return ok(exactFigure(cur, g.previousCovered ? (g.previous.get(key)?.[pick] ?? 0) : null));
}

const ALL_UNAVAILABLE = (code: ReasonCode): Pick<DashboardItem, "metrics" | "decay"> => ({
  metrics: {
    views: unavailable(code), avgSeconds: unavailable(code), clicks: unavailable(code),
    impressions: unavailable(code), topQueries: unavailable(code), leads: unavailable(code),
  },
  decay: unavailable(code),
});

/** One dashboard row per item, every figure from the sources or null with its reason. Pure. */
export function assembleItems(items: readonly PageItem[], s: Sourced): DashboardItem[] {
  return items.map((it) => {
    const base = {
      itemId: it.itemId, collectionKey: it.collectionKey, locale: it.locale, slug: it.slug, title: it.title,
      publishedVersion: it.publishedVersion, mine: it.mine,
    };
    if ("reason" in it.path) return { ...base, pagePath: null, pagePathReason: reasonOf(it.path.reason), ...ALL_UNAVAILABLE(it.path.reason) };
    const key = pathKey(it.path.path);
    if (key === null) return { ...base, pagePath: null, pagePathReason: reasonOf("slug_not_routable"), ...ALL_UNAVAILABLE("slug_not_routable") };

    const g = s.gsc;
    const metrics: DashboardMetrics = {
      views: s.umami.ok ? viewsMetric(key, s.umami.data) : { value: null, reason: s.umami.reason },
      avgSeconds: s.umami.ok ? secondsMetric(key, s.umami.data) : { value: null, reason: s.umami.reason },
      clicks: g.ok ? gscMetric(key, g.data, "clicks") : { value: null, reason: g.reason },
      impressions: g.ok ? gscMetric(key, g.data, "impressions") : { value: null, reason: g.reason },
      topQueries: g.ok ? (g.data.currentCovered ? ok(g.data.queries.get(key) ?? []) : unavailable("gsc_no_data")) : { value: null, reason: g.reason },
      leads: s.leads.ok
        ? ok(exactFigure(s.leads.data.current.get(key) ?? 0, s.leads.data.previous.get(key) ?? 0))
        : { value: null, reason: s.leads.reason },
    };
    let decay: Metric<"none" | DecayInfo>;
    if (!s.decay.ok) decay = { value: null, reason: s.decay.reason };
    else {
      const f = s.decay.data.byPath.get(key);
      decay = f ? ok(f) : s.decay.data.enabled ? ok("none") : unavailable("decay_off");
    }
    return { ...base, pagePath: it.path.path, pagePathReason: null, metrics, decay };
  });
}

// ── chunks (the Cerbos batch limit) ──────────────────────────────────────────────────────────────

/** Cerbos CheckResources takes at most 50 resources; the pair checks are made in groups of at most this many. */
export const CERBOS_CHUNK = 50;

export function chunked<T>(xs: readonly T[], size: number = CERBOS_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// ── query ────────────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export interface DashboardQuery {
  period: DashboardPeriod;
  collection: string | null;
  locale: string | null;
  /** true: only the caller's own articles, even when the caller may see more. */
  mine: boolean;
  limit: number;
  cursor: { collection: string; webdesk: string | null } | null;
}

export function encodeCursor(c: { collection: string; webdesk: string | null }): string {
  return Buffer.from(JSON.stringify([c.collection, c.webdesk]), "utf8").toString("base64url");
}
export function decodeCursor(raw: string): { collection: string; webdesk: string | null } | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && v[0] !== "" && (v[1] === null || typeof v[1] === "string")) {
      return { collection: v[0], webdesk: v[1] as string | null };
    }
  } catch { /* malformed */ }
  return null;
}
