// M5-A4 — the analytics reads over umami-client.ts (no DB, no HTTP framework: pure mapping + the
// call fan-out, so each read is testable from a recorded Umami response fixture).
//
// SMALL-CELL SUPPRESSION (visitor addendum R-V6): every count < 5 leaves this file as the string "<5",
// never the number, so no caller (BFF, MCP, UI) can show a small cell. Derived ratios (bounce rate,
// reach, average time) are null when their denominator or numerator is suppressed.
//
// The event contract is gaiada-web-revamp src/scripts/tracking/events.ts: section_view{section_id},
// cta_click{link_location}, lead_form_start/step/send + generate_lead{form_id}, web_vitals{metric_name,
// metric_rating}. Add, don't rename: unknown values simply appear as extra rows.
import { umamiGet, type UmamiGetOpts } from "./umami-client";

export const SUPPRESS_BELOW = 5;
export type Count = number | "<5";
export function suppress(n: number): Count {
  return n < SUPPRESS_BELOW ? "<5" : n;
}

/** Referrer hosts that count as "AI search" (matched on the host or any subdomain). */
export const AI_SEARCH_HOSTS = ["chatgpt.com", "perplexity.ai", "gemini.google.com", "copilot.microsoft.com", "claude.ai"] as const;

export interface DateRange { from: string; to: string } // YYYY-MM-DD, inclusive, UTC
export const MAX_RANGE_DAYS = 400;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class AnalyticsRangeError extends Error {}

/** Parse ?from&to (default: the 30 days ending today, UTC). Throws AnalyticsRangeError on bad input. */
export function resolveRange(from?: string, to?: string, now: Date = new Date()): DateRange & { startAt: number; endAt: number } {
  const today = now.toISOString().slice(0, 10);
  const t = to ?? today;
  const bad = (d: string) =>
    !DAY_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d;
  if (bad(t)) throw new AnalyticsRangeError("from and to must be dates as YYYY-MM-DD");
  const f = from ?? new Date(Date.parse(`${t}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  if (bad(f)) throw new AnalyticsRangeError("from and to must be dates as YYYY-MM-DD");
  const startAt = Date.parse(`${f}T00:00:00.000Z`);
  const endAt = Date.parse(`${t}T23:59:59.999Z`);
  if (endAt < startAt) throw new AnalyticsRangeError("from must not be after to");
  if ((endAt - startAt) / 86400000 > MAX_RANGE_DAYS) throw new AnalyticsRangeError(`range is limited to ${MAX_RANGE_DAYS} days`);
  return { from: f, to: t, startAt, endAt };
}

export interface Q { siteId: string; startAt: number; endAt: number; opts?: UmamiGetOpts }

/** Umami v3 returns flat numbers; older versions returned {value}. Accept both. */
function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number") return (v as { value: number }).value;
  return 0;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export interface Summary {
  visitors: Count; visits: Count; pageviews: Count;
  bounceRate: number | null;       // 0..1; null when visits < 5
  avgVisitSeconds: number | null;  // null when visits < 5
}
export interface RawStats { pageviews: number; visitors: number; visits: number; bounces: number; totaltime: number }

export function mapStats(body: unknown): RawStats {
  const b = (body ?? {}) as Record<string, unknown>;
  return { pageviews: num(b.pageviews), visitors: num(b.visitors), visits: num(b.visits), bounces: num(b.bounces), totaltime: num(b.totaltime) };
}
export function summarize(r: RawStats): Summary {
  const ok = r.visits >= SUPPRESS_BELOW;
  return {
    visitors: suppress(r.visitors), visits: suppress(r.visits), pageviews: suppress(r.pageviews),
    bounceRate: ok ? Math.round((r.bounces / r.visits) * 1000) / 1000 : null,
    avgVisitSeconds: ok ? Math.round(r.totaltime / r.visits) : null,
  };
}

export interface MetricRow { label: string; count: Count }
type Raw = { label: string; n: number };
/** [{x,y}] -> rows. Rows with no label are dropped. */
function metricRows(body: unknown): Raw[] {
  const out: Raw[] = [];
  for (const r of arr(body)) {
    const o = r as { x?: unknown; y?: unknown };
    if (typeof o.x === "string" && o.x !== "" && typeof o.y === "number") out.push({ label: o.x, n: o.y });
  }
  return out;
}
/** [{value,total}] -> rows. */
function valueRows(body: unknown): Raw[] {
  const out: Raw[] = [];
  for (const r of arr(body)) {
    const o = r as { value?: unknown; total?: unknown };
    if ((typeof o.value === "string" || typeof o.value === "number") && String(o.value) !== "" && typeof o.total === "number") {
      out.push({ label: String(o.value), n: o.total });
    }
  }
  return out;
}
const toRows = (rows: Raw[]): MetricRow[] =>
  [...rows].sort((a, b) => b.n - a.n).map((r) => ({ label: r.label, count: suppress(r.n) }));

export function hostIsAi(host: string): boolean {
  const h = host.toLowerCase();
  return AI_SEARCH_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

export interface Sources {
  referrers: MetricRow[];
  aiSearch: { total: Count; hosts: MetricRow[] };
}
export function mapSources(body: unknown): Sources {
  const rows = metricRows(body);
  const ai = rows.filter((r) => hostIsAi(r.label));
  return {
    referrers: toRows(rows),
    aiSearch: { total: suppress(ai.reduce((s, r) => s + r.n, 0)), hosts: toRows(ai) },
  };
}

const range = (q: Q) => ({ startAt: q.startAt, endAt: q.endAt });
const values = (q: Q, eventName: string, propertyName: string) =>
  umamiGet(q.siteId, "event-data/values", { eventName, propertyName, ...range(q) }, q.opts);

export async function readSummary(q: Q): Promise<Summary> {
  return summarize(mapStats(await umamiGet(q.siteId, "stats", range(q), q.opts)));
}
export async function readPages(q: Q, limit = 20): Promise<MetricRow[]> {
  return toRows(metricRows(await umamiGet(q.siteId, "metrics", { type: "path", ...range(q), limit: 100 }, q.opts))).slice(0, limit);
}
export async function readSources(q: Q): Promise<Sources> {
  const s = mapSources(await umamiGet(q.siteId, "metrics", { type: "referrer", ...range(q), limit: 500 }, q.opts));
  return { referrers: s.referrers.slice(0, 20), aiSearch: s.aiSearch };
}

export interface SectionRow { sectionId: string; views: Count; reachPct: number | null }
/** Reach = section_view count / page views in the range (the site sends one section_view per section per page view). */
export function mapSections(valuesBody: unknown, pageviews: number): SectionRow[] {
  return [...valueRows(valuesBody)].sort((a, b) => b.n - a.n).map((r) => ({
    sectionId: r.label,
    views: suppress(r.n),
    reachPct: r.n >= SUPPRESS_BELOW && pageviews >= SUPPRESS_BELOW ? Math.min(100, Math.round((r.n / pageviews) * 1000) / 10) : null,
  }));
}
export async function readSections(q: Q): Promise<SectionRow[]> {
  const [vals, stats] = await Promise.all([values(q, "section_view", "section_id"), umamiGet(q.siteId, "stats", range(q), q.opts)]);
  return mapSections(vals, mapStats(stats).pageviews);
}

export async function readCtas(q: Q): Promise<MetricRow[]> {
  return toRows(valueRows(await values(q, "cta_click", "link_location")));
}

export const FUNNEL_EVENTS = ["lead_form_start", "lead_form_step", "lead_form_send", "generate_lead"] as const;
export interface FunnelRow { formId: string; lead_form_start: Count; lead_form_step: Count; lead_form_send: Count; generate_lead: Count }
export function mapFunnel(byEvent: Record<(typeof FUNNEL_EVENTS)[number], unknown>): FunnelRow[] {
  const forms = new Map<string, Record<string, number>>();
  for (const ev of FUNNEL_EVENTS) {
    for (const r of valueRows(byEvent[ev])) {
      const cur = forms.get(r.label) ?? {};
      cur[ev] = r.n;
      forms.set(r.label, cur);
    }
  }
  return [...forms.entries()]
    .sort((a, b) => (b[1].lead_form_start ?? 0) - (a[1].lead_form_start ?? 0) || a[0].localeCompare(b[0]))
    .map(([formId, c]) => ({
      formId,
      lead_form_start: suppress(c.lead_form_start ?? 0), lead_form_step: suppress(c.lead_form_step ?? 0),
      lead_form_send: suppress(c.lead_form_send ?? 0), generate_lead: suppress(c.generate_lead ?? 0),
    }));
}
export async function readForms(q: Q): Promise<FunnelRow[]> {
  const res = await Promise.all(FUNNEL_EVENTS.map((e) => values(q, e, "form_id")));
  return mapFunnel({ lead_form_start: res[0], lead_form_step: res[1], lead_form_send: res[2], generate_lead: res[3] });
}

export interface Vitals { byMetric: MetricRow[]; byRating: MetricRow[] }
export async function readVitals(q: Q): Promise<Vitals> {
  // Umami's values endpoint groups one property at a time, so rating is across all three metrics.
  const [m, r] = await Promise.all([values(q, "web_vitals", "metric_name"), values(q, "web_vitals", "metric_rating")]);
  return { byMetric: toRows(valueRows(m)), byRating: toRows(valueRows(r)) };
}

export const ANALYTICS_KINDS = ["summary", "pages", "sources", "sections", "ctas", "forms", "vitals"] as const;
export type AnalyticsKind = (typeof ANALYTICS_KINDS)[number];

export async function readAnalytics(kind: AnalyticsKind, q: Q): Promise<unknown> {
  switch (kind) {
    case "summary": return readSummary(q);
    case "pages": return readPages(q);
    case "sources": return readSources(q);
    case "sections": return readSections(q);
    case "ctas": return readCtas(q);
    case "forms": return readForms(q);
    case "vitals": return readVitals(q);
  }
}
