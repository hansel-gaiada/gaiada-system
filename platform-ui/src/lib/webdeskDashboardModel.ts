// M5-W8 — the writer dashboard, client-safe half: types, the plain-words copy for every figure and every "unavailable", and the
// small pure helpers the cards use. NO `server-only`, NO I/O. The reader and the strict parser are `webdeskDashboard.ts` (server-only).
//
//   BFF (M5-W8, FRONTEND-BFF-CONTRACT §27 "Writers' room dashboard"):
//     GET /api/:company/modules/webdev/content/sites/:tenantSlug/:siteId/writers/dashboard?period&collection&locale&mine&cursor&limit
//
// THE RULES THIS SCREEN KEEPS
//  * A figure the BFF could not read is "Unavailable" with its reason in words. It is never drawn as 0 and its row is never dropped.
//  * Counts only. A lead is a number here; no screen of this feature can show a visitor, a name, an address or a lead id (none is ever sent).
//  * A view count under 5 is "fewer than 5" (the BFF sends "<5"); a raw number under 5 for views is contract drift, not data.

export type Count = number | "<5";
export type Trend = "up" | "down" | "flat";

export interface Reason { code: string; text: string }
/** A figure, or null with the reason it is unavailable. Exactly one of the two is non-null. */
export type Metric<T> = { value: T; reason: null } | { value: null; reason: Reason };

export interface CountWithTrend { current: Count; previous: Count | null; trend: Trend | null }
export interface TopQuery { query: string; clicks: number; impressions: number }
export interface DecayInfo { findingId: string; status: string; reason: string; detectedAt: string; briefId: string | null }

export interface DashboardMetrics {
  views: Metric<CountWithTrend>;
  avgSeconds: Metric<{ seconds: number }>;
  clicks: Metric<CountWithTrend>;
  impressions: Metric<CountWithTrend>;
  topQueries: Metric<TopQuery[]>;
  leads: Metric<CountWithTrend>;
}

export interface DashboardItem {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  title: string | null;
  publishedVersion: number;
  mine: boolean;
  pagePath: string | null;
  pagePathReason: Reason | null;
  metrics: DashboardMetrics;
  decay: Metric<"none" | DecayInfo>;
}

export type SourceStatus = { state: "ok" } | { state: "unavailable"; reason: Reason } | { state: "not_asked" };
export interface DayWindow { from: string; to: string }
export interface WindowPair { current: DayWindow; previous: DayWindow }

export interface WritersDashboard {
  tenantSlug: string;
  siteId: string;
  period: { key: string; days: number };
  windows: { traffic: WindowPair; search: WindowPair };
  scope: "all_site" | "scoped";
  sources: { umami: SourceStatus; search: SourceStatus; leads: SourceStatus; decay: SourceStatus };
  items: DashboardItem[];
  page: { cursor: string | null; hasMore: boolean; limit: number };
}

// ── filters ──────────────────────────────────────────────────────────────────────────────────────

export const PERIODS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "7d", label: "Last 7 days" },
  { key: "28d", label: "Last 28 days" },
  { key: "90d", label: "Last 90 days" },
];
export const DEFAULT_PERIOD = "28d";
export const isPeriodKey = (s: string | undefined): s is string => PERIODS.some((p) => p.key === s);

export interface DashboardFilters { period?: string; collection?: string; locale?: string; mine?: boolean; cursor?: string }

/** The filters as a query string for this page (not the BFF's): only what differs from the default is written. */
export function filterQuery(f: DashboardFilters): string {
  const p = new URLSearchParams();
  if (isPeriodKey(f.period) && f.period !== DEFAULT_PERIOD) p.set("period", f.period);
  if (f.collection) p.set("collection", f.collection);
  if (f.locale) p.set("locale", f.locale);
  if (f.mine) p.set("mine", "true");
  if (f.cursor) p.set("cursor", f.cursor);
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ── words ────────────────────────────────────────────────────────────────────────────────────────

export function formatCount(c: Count): string {
  return c === "<5" ? "fewer than 5" : c.toLocaleString("en-GB");
}

export interface TrendInfo { glyph: string; word: string }
/** An arrow AND a word: the arrow alone is not the signal. `null` (no comparison possible) draws nothing. */
export function trendInfo(t: Trend | null): TrendInfo | null {
  switch (t) {
    case "up": return { glyph: "▲", word: "up on the period before" };
    case "down": return { glyph: "▼", word: "down on the period before" };
    case "flat": return { glyph: "▬", word: "about the same as the period before" };
    default: return null;
  }
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

const DAY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${DAY_MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : iso;
}
export const formatWindow = (w: DayWindow): string => `${formatDay(w.from)} to ${formatDay(w.to)}`;

export function decayStatusWords(status: string): string {
  switch (status) {
    case "open": return "Open: nobody has looked at it yet";
    case "acknowledged": return "Acknowledged: someone has seen it";
    case "refresh_brief_filed": return "A refresh brief was filed";
    default: return status.replace(/_/g, " ");
  }
}

/** Which collection and language options a filter offers: the site's, plus whatever the current filter already holds. */
export function filterOptions(known: readonly string[], rows: readonly string[], current: string | undefined): string[] {
  return Array.from(new Set([...known, ...rows, ...(current ? [current] : [])])).sort();
}

/** One sentence for the banner above the cards: which sources did not answer for this page, each with its own reason. */
export function unavailableSources(s: WritersDashboard["sources"]): Array<{ label: string; reason: Reason }> {
  const out: Array<{ label: string; reason: Reason }> = [];
  const add = (label: string, st: SourceStatus) => { if (st.state === "unavailable") out.push({ label, reason: st.reason }); };
  add("Website analytics", s.umami);
  add("Search Console", s.search);
  add("Leads", s.leads);
  add("Decay check", s.decay);
  return out;
}
