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
import { NOTE_AREAS, type ReportAction, type ReportNotes } from "./report-notes";
import { periodicWhen } from "../../core/report-period-label";
import { periodRange } from "./pipeline/rules-periods";
import type { PeriodicKind } from "./pipeline/rules";

/** SCP-5 W5-A2 (BFF §63.24.1): the six periodic kinds and SMM-23's two. */
export type ReportKind = PeriodicKind | "campaign" | "adhoc";

/** Mirrors `search/reports.ts#periodDateRange` byte-for-byte (see that file's own header on why a
 *  small duplicated helper is this estate's idiom across separate modules): `period` as `YYYY-MM`
 *  resolves to that calendar month; anything else (adhoc/campaign with no period, or a malformed
 *  one) falls back to the trailing 30 days ending at `fallbackEnd`. */
export function periodDateRange(
  period: string | null, fallbackEnd: Date, opts: { kind?: PeriodicKind; fiscalYearStartMonth?: number } = {},
): { start: string; end: string } {
  // SCP-5 W5-A2 (BFF §63.24.1): given the report's periodic kind, every form of period resolves to its range (quarters, halves
  // and years from the company's fiscal year start). Without `kind` (campaign, ad hoc, the monthly as SCP-5a built it) nothing
  // changes: `YYYY-MM` is that month and anything else the trailing 30 days.
  if (opts.kind && period) {
    const r = periodRange(opts.kind, period.trim(), opts.fiscalYearStartMonth ?? 1);
    if (r) return r;
  }
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
  const periodic = periodicWhen(kind, period, start, end);
  if (periodic) return periodic;
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

/** SCP-5a (§63.18, PV7-Q3): one boost the client paid for in the period: the CLIENT'S OWN ad spend, never our fees. `spendMinor`
 *  is in minor units of `currency` (`minorUnit` digits), and null until the boost stops or completes (the spend is recorded
 *  then): a running boost's spend is unknown, never a fabricated 0. */
export interface BoostSpendInput {
  boostId: string;
  postTitle: string;
  startsOn: string;
  days: number;
  status: string;
  currency: string;
  minorUnit: number;
  spendMinor: number | null;
  paidReach: number | null;
  clicks: number | null;
}

export interface ReportSnapshotFacts {
  rangeStart: string;
  rangeEnd: string;
  daily: DailyMetricInput[];
  posts: PostMetricInput[];
  postsPublishedInPeriod: number; // a REAL count of our own rows — always known, real 0 is legitimate
  kpiTargets: KpiTargetInput[];
  /** SCP-5a: the period's boosts that ran (optional: a caller with none passes nothing). */
  boosts?: BoostSpendInput[];
}

/** SCP-5a: the client's own ad spend of the period, per currency (a mixed-currency month is never summed across currencies). */
export interface FrozenAdSpend {
  currency: string;
  minorUnit: number;
  boosts: number;
  /** Sum of the KNOWN spends, or null when no boost of this currency has its spend recorded yet. */
  spendMinor: number | null;
  paidReach: number | null;
  clicks: number | null;
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
  /** SCP-5a: the client's own ad spend of the period (boosts), absent when no boost ran or on a snapshot frozen before SCP-5a. */
  adSpend?: FrozenAdSpend[];
  /** SCP-5 W5-A2 (BFF §63.24.1): the short kinds' own facts, the counts the tables below summarise (a real 0 is a fact: "nothing is
   *  scheduled"). Absent on every other kind. */
  shortKind?: { approvedPosts: number; nextPosts: number; nextLabel: "day" | "week"; bestPostReach: number | null };
}

/** SCP-5 W5-A2: the best post of a short report's period by reach, and the next period's pipeline posts. */
export interface BestPostFact { title: string; network: string; publishedAt: string | null; reach: number }
export interface NextPostFact { postId: string; title: string; format: string | null; scheduledAt: string; phase: string | null; phaseLabel: string | null }
export interface ShortKindFactsInput { approvedPosts: number; bestPost: BestPostFact | null; nextPosts: NextPostFact[]; nextLabel: "day" | "week" }

/**
 * SCP-5 W5-A2 (BFF §63.24.1): a daily or weekly report's own numbers on top of the snapshot: the posts the client approved in the
 * period (a real count: 0 is a fact), the best post by reach (a table when one has a reach) and what the pipeline has dated in the
 * next day or week (a table when there is any). The snapshot is returned as a new object.
 */
export function withShortKindFacts(frozen: FrozenSocialReportMetrics, x: ShortKindFactsInput): FrozenSocialReportMetrics {
  const tables = [...frozen.tables];
  if (x.bestPost) {
    tables.push({
      key: "best_post", label: "Best post by reach",
      columns: [
        { key: "post", label: "Post" }, { key: "network", label: "Network" }, { key: "publishedAt", label: "Published" },
        { key: "reach", label: "Reach", unit: "count", align: "right" },
      ],
      rows: [{ post: x.bestPost.title, network: x.bestPost.network, publishedAt: x.bestPost.publishedAt, reach: x.bestPost.reach }],
    });
  }
  if (x.nextPosts.length > 0) {
    tables.push({
      key: "next_period", label: x.nextLabel === "day" ? "Coming up the next day" : "Coming up the next week",
      columns: [
        { key: "title", label: "Post" }, { key: "format", label: "Format" }, { key: "scheduledAt", label: "Scheduled" }, { key: "phaseLabel", label: "Where it is" },
      ],
      rows: x.nextPosts.map((p) => ({ postId: p.postId, title: p.title, format: p.format, scheduledAt: p.scheduledAt, phase: p.phase, phaseLabel: p.phaseLabel })),
    });
  }
  return {
    ...frozen,
    kpis: [...frozen.kpis, { metricKey: "posts_approved_period", label: "Posts approved by the client", unit: "count", value: x.approvedPosts, appraisalSafe: false }],
    tables,
    shortKind: { approvedPosts: x.approvedPosts, nextPosts: x.nextPosts.length, nextLabel: x.nextLabel, bestPostReach: x.bestPost?.reach ?? null },
  };
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

  // ── SCP-5a (§63.18, PV7-Q3): the period's boosts, as the CLIENT'S OWN ad spend. The spend is the amount the client's ad
  //    account paid, recorded when the boost stopped or completed; no fee or margin of ours is in these rows, and none is read.
  //    A running boost's spend is null ("not recorded yet"), never 0. Money is shown in major units of its currency.
  const boosts = facts.boosts ?? [];
  const adSpend: FrozenAdSpend[] = [];
  if (boosts.length > 0) {
    const major = (minor: number | null, mu: number) => (minor === null ? null : minor / 10 ** mu);
    for (const currency of [...new Set(boosts.map((b) => b.currency))].sort()) {
      const of = boosts.filter((b) => b.currency === currency);
      adSpend.push({
        currency, minorUnit: of[0].minorUnit, boosts: of.length,
        spendMinor: sumKnown(of.map((b) => b.spendMinor)), paidReach: sumKnown(of.map((b) => b.paidReach)), clicks: sumKnown(of.map((b) => b.clicks)),
      });
    }
    const single = adSpend.length === 1 ? adSpend[0] : null;
    tables.push({
      key: "ad_spend",
      label: "Paid boosts (your own ad spend)",
      columns: [
        { key: "post", label: "Post" },
        { key: "startsOn", label: "Started" },
        { key: "days", label: "Days", unit: "count", align: "right" },
        { key: "spend", label: "Spend", align: "right" },
        { key: "currency", label: "Currency" },
        { key: "paidReach", label: "Paid reach", unit: "count", align: "right" },
        { key: "clicks", label: "Clicks", unit: "count", align: "right" },
      ],
      rows: [...boosts].sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.boostId.localeCompare(b.boostId)).map((b) => ({
        post: b.postTitle, startsOn: b.startsOn, days: b.days, spend: major(b.spendMinor, b.minorUnit), currency: b.currency,
        paidReach: b.paidReach, clicks: b.clicks,
      })),
      ...(single
        ? { totalRow: { post: "Total", startsOn: null, days: null, spend: major(single.spendMinor, single.minorUnit), currency: single.currency, paidReach: single.paidReach, clicks: single.clicks } }
        : {}),
    });
  }

  const highlights: ReportHighlight[] = [];
  if (facts.postsPublishedInPeriod === 0) {
    highlights.push({ kind: "anomaly", text: "No posts were published in this engagement during this period." });
  }

  return { rangeStart, rangeEnd, kpis, series, tables, highlights, ...(adSpend.length > 0 ? { adSpend } : {}) };
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
  /** SCP-5a: the notes and the action plan, printed as two tables so the PDF the client receives carries them. */
  notes?: ReportNotes;
  actionPlan?: ReportAction[];
  /** SCP-5a: the row's `simulated` (the frozen numbers include simulated rows): the page and the PDF draw the watermark. */
  simulated?: boolean;
  /** SCP-5 W5-A2: a short report's line about what comes next; printed under the summary, as the client receives it. */
  nextPeriod?: string | null;
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
    tables: [...input.frozen.tables, ...notesTables(input.notes ?? {}, input.actionPlan ?? [])],
    highlights: input.frozen.highlights,
    narrative: {
      source: input.frozen.narrativeSource ?? "deterministic", model: input.frozen.narrativeModel,
      text: input.nextPeriod && /\S/.test(input.nextPeriod)
        ? `${input.narrativeText}\n\nNext ${input.frozen.shortKind?.nextLabel ?? (input.kind === "daily" ? "day" : "week")}: ${input.nextPeriod.trim()}`
        : input.narrativeText,
    },
    ...(input.simulated ? { simulated: true } : {}),
  };
}

const AREA_LABELS: Record<(typeof NOTE_AREAS)[number], string> = { followers: "Followers", engagement: "Engagement", audience: "Audience" };

/** SCP-5a: the notes (`notes`; an area with nothing written is left out) and the action plan (`action_plan`), as document
 *  tables the existing print page already renders. Neither table is drawn when it would be empty. */
export function notesTables(notes: ReportNotes, actionPlan: ReportAction[]): ReportTable[] {
  const out: ReportTable[] = [];
  const rows = NOTE_AREAS.flatMap((a) => {
    const n = notes[a];
    if (!n || (!/\S/.test(n.insight) && !/\S/.test(n.suggestion))) return [];
    return [{ area: AREA_LABELS[a], insight: n.insight, suggestion: n.suggestion }];
  });
  if (rows.length > 0) {
    out.push({
      key: "notes", label: "Insights and suggestions",
      columns: [{ key: "area", label: "Area" }, { key: "insight", label: "Insight" }, { key: "suggestion", label: "Suggestion" }],
      rows,
    });
  }
  if (actionPlan.length > 0) {
    out.push({
      key: "action_plan", label: "Action plan",
      columns: [{ key: "action", label: "Action" }, { key: "owner", label: "Owner" }, { key: "due", label: "Due" }],
      rows: actionPlan.map((x) => ({ action: x.action, owner: x.owner === "client" ? "Client" : "Agency", due: x.due ?? null })),
    });
  }
  return out;
}

/**
 * SCP-5a (§63.18 "Reports due"): the day a monthly report for `period` (`YYYY-MM`) is due: the engagement's `report_due_day`
 * of the month after the period, clamped to that month's last day (a 31 in a 30-day month is the 30th). Null for a bad period
 * or day.
 */
export function reportDueDate(period: string, dueDay: number): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); // the last day of the month after `period`
  return new Date(Date.UTC(y, mo, Math.min(dueDay, last))).toISOString().slice(0, 10);
}

/** SCP-5a: the period (`YYYY-MM`) whose monthly report falls due in the month of `todayIso` (`YYYY-MM-DD`): the month before. */
export function previousPeriod(todayIso: string): string {
  const y = Number(todayIso.slice(0, 4));
  const mo = Number(todayIso.slice(5, 7));
  return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
}

/** "August 2026" for `2026-08`; the raw value otherwise. */
export function monthLabel(period: string | null): string {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return period ?? "";
  const [y, mo] = period.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
