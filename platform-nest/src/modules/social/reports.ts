// SMM-23 — the client-facing engagement report: snapshot + AI narrative -> approve -> render (via
// report-renderer / print-payload, addendum Δ13) -> files + Drive + deliverable. Design
// smm-design.md §04 ("`social_reports` — mirrors `search_reports`") + §07 ("Low-impact artifacts
// (reports, campaign plans) approve in-console via module permissions").
//
// Pure/testable split (mirrors search/reports.ts and search-reports.controller.ts's own header):
// this file builds the FROZEN metrics snapshot and the ReportDocument the print pipeline renders.
// Every DB read/write, every gateway call and every Cerbos check lives in
// social-reports.controller.ts; this file makes no I/O of its own.
//
// ── NO INVENTED NUMBERS (the ticket's own named risk — the highest-stakes instance of this
// module's rule: a confident wrong number on a document that reaches a client) ────────────────────
// `capabilities.ts`/`media-rules.ts` treat an absent counter as `quota_unknown`, never a fabricated
// zero. This file holds the SAME discipline for a report:
//   - `sumKnown` returns `null`, never `0`, when EVERY value it was given is null/undefined — a
//     metric nobody ever pulled is OMITTED from the document (see `kpi()` below), not shown as 0.
//   - `latestKnown` (for a point-in-time counter like `followers`) walks from the newest day
//     backwards and returns the first NON-NULL reading, never the newest day's raw value if that
//     day itself was never pulled.
//   - A count that genuinely comes from counting our OWN rows (e.g. "posts published this period")
//     is NOT subject to this rule — zero published posts is a real, known fact, not an absent
//     counter, and is rendered as a real 0.
import type {
  ReportHeader, ReportKpi, ReportSeries, ReportSeriesPoint, ReportTable, ReportHighlight, ReportDocument,
} from "../reports/report-document";

export type ReportKind = "monthly" | "campaign" | "adhoc";

/** Mirrors `search/reports.ts#periodDateRange` byte-for-byte (see that file's own header on why a
 *  small duplicated helper is this estate's idiom across separate modules): `period` as `YYYY-MM`
 *  resolves to that calendar month; anything else (adhoc/campaign with no period, or a malformed
 *  one) falls back to the trailing 30 days ending at `fallbackEnd`. */
export function periodDateRange(period: string | null, fallbackEnd: Date): { start: string; end: string } {
  const m = period ? /^(\d{4})-(\d{2})$/.exec(period.trim()) : null;
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const start = new Date(Date.UTC(y, mo - 1, 1));
    const end = new Date(Date.UTC(y, mo, 0)); // last day of that month
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  const end = new Date(Date.UTC(fallbackEnd.getUTCFullYear(), fallbackEnd.getUTCMonth(), fallbackEnd.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function periodLabel(kind: ReportKind, period: string | null, start: string, end: string): string {
  if (kind === "monthly" && period && /^\d{4}-\d{2}$/.test(period)) {
    const [y, mo] = period.split("-").map(Number);
    return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  return `${start} – ${end}`;
}

function dayCount(start: string, end: string): number {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((e - s) / 86_400_000) + 1);
}

/** `null` unless at least one input is a real number — never coerces "nothing was ever fetched" to
 *  a fabricated total of 0 (file header). */
export function sumKnown(values: Array<number | null | undefined>): number | null {
  const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (known.length === 0) return null;
  return known.reduce((a, b) => a + b, 0);
}

/** Point-in-time counter (e.g. `followers`): the newest NON-NULL reading in `rows`, walking
 *  backwards from the end of the period. `null` only when every row in the window is null — i.e.
 *  the metric was never pulled for this account/period at all. */
export function latestKnown(rowsNewestLast: Array<number | null | undefined>): number | null {
  for (let i = rowsNewestLast.length - 1; i >= 0; i--) {
    const v = rowsNewestLast[i];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function kpi(metricKey: string, label: string, unit: ReportKpi["unit"], value: number | null): ReportKpi | null {
  if (value === null) return null;
  return { metricKey, label, unit, value, appraisalSafe: false };
}

export interface DailyMetricInput {
  accountId: string;
  network: string;
  date: string; // YYYY-MM-DD, ascending within an account
  followers: number | null;
  impressions: number | null;
  reach: number | null;
  engagements: number | null;
  linkClicks: number | null;
  videoViews: number | null;
}

export interface PostMetricInput {
  variantId: string;
  network: string;
  publishedAt: string | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  videoViews: number | null;
  clicks: number | null;
}

export interface KpiTargetInput {
  metricKey: string;
  targetValue: number;
  direction: "up" | "down";
  duePeriod: string | null;
}

export interface ReportSnapshotFacts {
  rangeStart: string;
  rangeEnd: string;
  daily: DailyMetricInput[];
  posts: PostMetricInput[];
  postsPublishedInPeriod: number; // a REAL count of our own rows — always known, real 0 is legitimate
  kpiTargets: KpiTargetInput[];
}

/** The FROZEN snapshot half of `social_reports.metrics` — everything computed from SMM-21's tables,
 *  before any narrative is attached. Stored verbatim at creation time (search_reports precedent:
 *  "read VERBATIM from the report's own frozen column, never recomputed with a different query
 *  shape" on every later read) so an approved report's numbers cannot silently drift if metrics are
 *  re-pulled after the fact. */
export interface FrozenSocialReportMetrics {
  rangeStart: string;
  rangeEnd: string;
  kpis: ReportKpi[];
  series: ReportSeries[];
  tables: ReportTable[];
  highlights: ReportHighlight[];
  /** How the narrative attached to this report was produced, frozen alongside the numbers at
   *  creation time so `getReport`/`deliverReport` can report it honestly (never hardcoded "ai" —
   *  a gateway hiccup at creation falls back to a deterministic template, and the document must
   *  say so, not claim an AI narrative that never happened). Set by the controller, not by
   *  `buildSocialReportSnapshot` (which knows nothing about the narrative call). */
  narrativeSource?: "ai" | "deterministic";
  narrativeModel?: string;
}

function seriesFor(
  key: string, label: string, unit: ReportSeries["unit"], daily: DailyMetricInput[], rangeStart: string, rangeEnd: string,
  pick: (d: DailyMetricInput) => number | null | undefined,
): ReportSeries {
  const byDate = new Map<string, Array<number | null | undefined>>();
  for (const d of daily) {
    const list = byDate.get(d.date) ?? [];
    list.push(pick(d));
    byDate.set(d.date, list);
  }
  const points: ReportSeriesPoint[] = [];
  const cursor = new Date(`${rangeStart}T00:00:00Z`);
  const endMs = new Date(`${rangeEnd}T00:00:00Z`).getTime();
  while (cursor.getTime() <= endMs) {
    const t = cursor.toISOString().slice(0, 10);
    points.push({ t, v: sumKnown(byDate.get(t) ?? []) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { key, label, unit, kind: "line", points };
}

/** Pure builder — no I/O. `postsPublishedInPeriod` is a real count (never subject to the "unknown
 *  is not zero" rule: it is our own row count, not a metric the publisher engine may or may not
 *  have reported). Every metric derived from `social_metrics_daily`/`social_post_metrics` follows
 *  the file-header discipline: omitted, never zeroed, when nothing was ever pulled. */
export function buildSocialReportSnapshot(facts: ReportSnapshotFacts): FrozenSocialReportMetrics {
  const { daily, posts, rangeStart, rangeEnd } = facts;

  // ── per-account latest followers, summed across accounts (a point-in-time counter) ────────────
  const byAccount = new Map<string, DailyMetricInput[]>();
  for (const d of daily) {
    const list = byAccount.get(d.accountId) ?? [];
    list.push(d);
    byAccount.set(d.accountId, list);
  }
  const followerReadings: Array<number | null> = [];
  for (const rows of byAccount.values()) {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    followerReadings.push(latestKnown(sorted.map((r) => r.followers)));
  }
  const followersTotal = sumKnown(followerReadings);

  const impressionsSum = sumKnown(daily.map((d) => d.impressions));
  const reachSum = sumKnown(daily.map((d) => d.reach));
  const engagementsSum = sumKnown(daily.map((d) => d.engagements));
  const linkClicksSum = sumKnown(daily.map((d) => d.linkClicks));
  const videoViewsSum = sumKnown(daily.map((d) => d.videoViews));
  // Ratio metric: numerator AND denominator must both be real, non-zero-denominator reads, or the
  // rate itself is unknown — never divide by a fabricated denominator.
  const engagementRate = engagementsSum !== null && impressionsSum !== null && impressionsSum > 0
    ? engagementsSum / impressionsSum
    : null;

  const kpis: ReportKpi[] = [
    kpi("posts_published_period", "Posts published", "count", facts.postsPublishedInPeriod),
    kpi("followers_total", "Followers", "count", followersTotal),
    kpi("impressions_period", "Impressions", "count", impressionsSum),
    kpi("reach_period", "Reach", "count", reachSum),
    kpi("engagements_period", "Engagements", "count", engagementsSum),
    kpi("link_clicks_period", "Link clicks", "count", linkClicksSum),
    kpi("video_views_period", "Video views", "count", videoViewsSum),
    engagementRate !== null
      ? { metricKey: "engagement_rate_period", label: "Engagement rate", unit: "percent", value: Math.round(engagementRate * 1000) / 10, numerator: engagementsSum ?? undefined, denominator: impressionsSum ?? undefined, appraisalSafe: false }
      : null,
  ].filter((k): k is ReportKpi => k !== null);

  const series: ReportSeries[] = [
    seriesFor("impressions_daily", "Impressions", "count", daily, rangeStart, rangeEnd, (d) => d.impressions),
    seriesFor("followers_daily", "Followers", "count", daily, rangeStart, rangeEnd, (d) => d.followers),
  ];

  // ── top posts (only posts with at least one fetched metric — a published post never pulled is
  //    omitted entirely, never shown with fabricated zeroes) ────────────────────────────────────
  const withData = posts.filter(
    (p) => p.impressions !== null || p.likes !== null || p.comments !== null || p.shares !== null || p.saves !== null || p.videoViews !== null || p.clicks !== null,
  );
  const topPosts = [...withData].sort((a, b) => (b.impressions ?? -1) - (a.impressions ?? -1)).slice(0, 10);
  const tables: ReportTable[] = [];
  if (topPosts.length > 0) {
    tables.push({
      key: "top_posts",
      label: "Top posts",
      columns: [
        { key: "network", label: "Network" },
        { key: "publishedAt", label: "Published" },
        { key: "impressions", label: "Impressions", unit: "count", align: "right" },
        { key: "likes", label: "Likes", unit: "count", align: "right" },
        { key: "comments", label: "Comments", unit: "count", align: "right" },
        { key: "shares", label: "Shares", unit: "count", align: "right" },
      ],
      rows: topPosts.map((p) => ({
        network: p.network, publishedAt: p.publishedAt, impressions: p.impressions,
        likes: p.likes, comments: p.comments, shares: p.shares,
      })),
    });
  }

  // ── KPI vs target — its own table, deliberately NOT folded into `kpis` above (search_reports'
  //    own frozen-metrics shape keeps `kpiTargets` separate from its plain KPI numbers for the same
  //    reason: a target is a commitment, not a measured value, and conflating the two would let a
  //    target silently masquerade as something we measured). An actual value the module never
  //    computed for this metric_key renders `null` — "not yet fetched", never a fabricated match or
  //    miss against the target. */
  const actualByKey: Record<string, number | null> = {
    followers_total: followersTotal,
    reach_month: reachSum,
    link_clicks_month: linkClicksSum,
    posts_published_month: facts.postsPublishedInPeriod,
    engagement_rate: engagementRate !== null ? Math.round(engagementRate * 1000) / 10 : null,
  };
  if (facts.kpiTargets.length > 0) {
    tables.push({
      key: "kpi_vs_target",
      label: "KPI vs. target",
      columns: [
        { key: "metric", label: "Metric" },
        { key: "actual", label: "Actual", align: "right" },
        { key: "target", label: "Target", align: "right" },
        { key: "direction", label: "Direction" },
      ],
      rows: facts.kpiTargets.map((t) => ({
        metric: t.metricKey,
        actual: actualByKey[t.metricKey] ?? null,
        target: t.targetValue,
        direction: t.direction,
      })),
    });
  }

  const highlights: ReportHighlight[] = [];
  if (facts.postsPublishedInPeriod === 0) {
    highlights.push({ kind: "anomaly", text: "No posts were published in this engagement during this period." });
  }

  return { rangeStart, rangeEnd, kpis, series, tables, highlights };
}

/** Assemble the final `ReportDocument` the print pipeline (`report-pdf-export.ts`'s
 *  `mintPrintJobToken`/`renderPdfViaSidecar`) renders, from the FROZEN snapshot + the (possibly
 *  human-edited) narrative. `header.grain` is pinned to `"company"` — the reports module's four
 *  grains (person/project/department/company) have no fifth "client engagement" grain, and adding
 *  one is out of this ticket's file surface (`report-document.ts` is the reports module's own
 *  contract, mirrored FIELD-FOR-FIELD from `platform-ui/src/lib/reports.ts`, which this ticket must
 *  not touch). `"company"` is the closest existing shape (a client, not a person or a PM project)
 *  and costs nothing beyond the print page's per-grain chart composition not knowing this
 *  document's own series/table keys — see this ticket's own report-back for that named limitation. */
export function buildSocialReportDocument(input: {
  tenantId: string;
  engagementId: string;
  clientName: string;
  kind: ReportKind;
  period: string | null;
  status: string;
  frozen: FrozenSocialReportMetrics;
  narrativeText: string;
  generatedAt: string;
}): ReportDocument {
  const header: ReportHeader = {
    tenantId: input.tenantId,
    grain: "company",
    scopeRef: input.engagementId,
    scopeName: input.clientName,
    periodKind: input.kind === "monthly" ? "month" : "custom",
    periodStart: input.frozen.rangeStart,
    periodEnd: input.frozen.rangeEnd,
    dayCount: dayCount(input.frozen.rangeStart, input.frozen.rangeEnd),
    periodLabel: periodLabel(input.kind, input.period, input.frozen.rangeStart, input.frozen.rangeEnd),
    generatedAt: input.generatedAt,
    sealed: false, // SMM-23 has no seal/revision concept — this is not the 4-grain tracker's period ledger
  };
  return {
    header,
    kpis: input.frozen.kpis,
    series: input.frozen.series,
    distributions: [],
    tables: input.frozen.tables,
    highlights: input.frozen.highlights,
    narrative: { source: input.frozen.narrativeSource ?? "deterministic", text: input.narrativeText, model: input.frozen.narrativeModel },
  };
}
