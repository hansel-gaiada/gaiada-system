// M5-A4 — Website → Analytics: the shapes of platform-nest's `GET /api/:t/modules/search/properties/:id/analytics/:kind`
// (search-analytics.controller.ts), a tolerant-but-honest parser, the site -> search-property match, and formatting.
// Pure: no server-only imports, so the browser and the tests can use it.
//
// Two rules the whole tab rests on:
//   * a read that did not return data is a STATE with words, never an empty table (an empty list is a claim);
//   * a count under 5 arrives from the server as the string "<5" and is shown as "<5". The UI never recomputes
//     or reveals a small number (visitor addendum R-V6).

export type Count = number | "<5";
export type AnalyticsKind = "summary" | "pages" | "sources" | "sections" | "ctas" | "forms" | "vitals";
export const ANALYTICS_KINDS: readonly AnalyticsKind[] = ["summary", "pages", "sources", "sections", "ctas", "forms", "vitals"];

export interface MetricRow { label: string; count: Count }
export interface Summary { visitors: Count; visits: Count; pageviews: Count; bounceRate: number | null; avgVisitSeconds: number | null }
export interface Sources { referrers: MetricRow[]; aiSearch: { total: Count; hosts: MetricRow[] } }
export interface SectionRow { sectionId: string; views: Count; reachPct: number | null }
export interface FunnelRow { formId: string; lead_form_start: Count; lead_form_step: Count; lead_form_send: Count; generate_lead: Count }
export interface Vitals { byMetric: MetricRow[]; byRating: MetricRow[] }

export interface AnalyticsData {
  summary: Summary; pages: MetricRow[]; sources: Sources; sections: SectionRow[]; ctas: MetricRow[]; forms: FunnelRow[]; vitals: Vitals;
}

/** What one read came back as. `ok` carries parsed data; every other state carries the server's plain words. */
export type AnalyticsRead<K extends AnalyticsKind> =
  | { state: "ok"; data: AnalyticsData[K] }
  | { state: "not_configured" | "not_bound" | "unreachable" | "rejected"; message: string };

export class AnalyticsShapeError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function count(v: unknown, at: string): Count {
  if (v === "<5" || (typeof v === "number" && Number.isFinite(v) && v >= 5)) return v as Count;
  // A raw small number would break the suppression promise: refuse it rather than show it.
  throw new AnalyticsShapeError(`${at}: expected a count of 5 or more, or "<5"`);
}
function str(v: unknown, at: string): string {
  if (typeof v !== "string") throw new AnalyticsShapeError(`${at}: expected a string`);
  return v;
}
function numN(v: unknown, at: string): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new AnalyticsShapeError(`${at}: expected a number or null`);
  return v;
}
function list<T>(v: unknown, at: string, f: (x: Record<string, unknown>, at: string) => T): T[] {
  if (!Array.isArray(v)) throw new AnalyticsShapeError(`${at}: expected an array`);
  return v.map((x, i) => {
    if (!isObj(x)) throw new AnalyticsShapeError(`${at}[${i}]: expected an object`);
    return f(x, `${at}[${i}]`);
  });
}
const row = (o: Record<string, unknown>, at: string): MetricRow => ({ label: str(o.label, `${at}.label`), count: count(o.count, `${at}.count`) });
const obj = (v: unknown, at: string): Record<string, unknown> => {
  if (!isObj(v)) throw new AnalyticsShapeError(`${at}: expected an object`);
  return v;
};

const PARSERS: { [K in AnalyticsKind]: (d: unknown) => AnalyticsData[K] } = {
  summary: (d) => {
    const o = obj(d, "summary");
    return {
      visitors: count(o.visitors, "visitors"), visits: count(o.visits, "visits"), pageviews: count(o.pageviews, "pageviews"),
      bounceRate: numN(o.bounceRate, "bounceRate"), avgVisitSeconds: numN(o.avgVisitSeconds, "avgVisitSeconds"),
    };
  },
  pages: (d) => list(d, "pages", row),
  sources: (d) => {
    const o = obj(d, "sources");
    const ai = obj(o.aiSearch, "sources.aiSearch");
    return { referrers: list(o.referrers, "referrers", row), aiSearch: { total: count(ai.total, "aiSearch.total"), hosts: list(ai.hosts, "aiSearch.hosts", row) } };
  },
  sections: (d) => list(d, "sections", (o, at) => ({ sectionId: str(o.sectionId, `${at}.sectionId`), views: count(o.views, `${at}.views`), reachPct: numN(o.reachPct, `${at}.reachPct`) })),
  ctas: (d) => list(d, "ctas", row),
  forms: (d) => list(d, "forms", (o, at) => ({
    formId: str(o.formId, `${at}.formId`), lead_form_start: count(o.lead_form_start, `${at}.lead_form_start`), lead_form_step: count(o.lead_form_step, `${at}.lead_form_step`),
    lead_form_send: count(o.lead_form_send, `${at}.lead_form_send`), generate_lead: count(o.generate_lead, `${at}.generate_lead`),
  })),
  vitals: (d) => {
    const o = obj(d, "vitals");
    return { byMetric: list(o.byMetric, "byMetric", row), byRating: list(o.byRating, "byRating", row) };
  },
};

const STATES = new Set(["not_configured", "not_bound", "unreachable", "rejected"]);

/** Validate one BFF body. Throws AnalyticsShapeError on anything off-contract (the page shows that as a contract defect, not an empty tab). */
export function parseAnalyticsRead<K extends AnalyticsKind>(kind: K, body: unknown): AnalyticsRead<K> {
  const o = obj(body, "analytics response");
  if (o.state === "ok") return { state: "ok", data: PARSERS[kind](o.data) };
  if (typeof o.state === "string" && STATES.has(o.state)) {
    return { state: o.state as "not_configured", message: typeof o.message === "string" && o.message ? o.message : "Analytics is not available." };
  }
  throw new AnalyticsShapeError("analytics response: unknown state");
}

// ── Site -> search property ───────────────────────────────────────────────────────────────────────────
export interface PropertyRef { id: string; domain: string; umamiSiteId: string | null }

const host = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

/** The search property whose domain is one of the site's environment domains (www. ignored). null when none matches. */
export function matchProperty(properties: PropertyRef[], domains: Array<string | null>): PropertyRef | null {
  const want = new Set(domains.filter((d): d is string => !!d).map(host));
  return properties.find((p) => want.has(host(p.domain))) ?? null;
}

// ── Date range (the picker is a plain GET form) ───────────────────────────────────────────────────────
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: string | undefined): s is string =>
  !!s && DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** `from`/`to` from the URL, falling back to the 30 days ending today (UTC). `error` is set when the URL asked for something unusable. */
export function resolveRange(from?: string, to?: string, now: Date = new Date()): { from: string; to: string; error: string | null } {
  const today = now.toISOString().slice(0, 10);
  const t = isDay(to) ? to : today;
  const f = isDay(from) ? from : new Date(Date.parse(`${t}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  let error: string | null = null;
  if ((from !== undefined && from !== "" && !isDay(from)) || (to !== undefined && to !== "" && !isDay(to))) error = "Dates must be written as YYYY-MM-DD.";
  else if (f > t) error = "The start date is after the end date.";
  else if ((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86400000 > 399) error = "The range can be at most 400 days.";
  return { from: f, to: t, error };
}

// ── Formatting ────────────────────────────────────────────────────────────────────────────────────────
export const fmtCount = (c: Count): string => (c === "<5" ? "<5" : c.toLocaleString("en-US"));
export const fmtPct = (n: number | null): string => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
export const fmtReach = (n: number | null): string => (n === null ? "n/a" : `${n.toFixed(1)}%`);
export function fmtDuration(s: number | null): string {
  if (s === null) return "n/a";
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
/** Bar width 0..100 for a count against the largest in its table; a suppressed cell has no bar. */
export function barPct(c: Count, max: number): number {
  return c === "<5" || max <= 0 ? 0 : Math.max(2, Math.round((c / max) * 100));
}
export const maxCount = (cs: Count[]): number => cs.reduce<number>((m, c) => (c === "<5" ? m : Math.max(m, c)), 0);
