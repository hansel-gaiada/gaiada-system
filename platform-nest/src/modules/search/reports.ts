// SM-22 — client-facing report rendering (docs/blueprints/seo-sem-design.md §12 SM-22; deps SM-10
// data, SM-17 usage/legend, SM-18 SEM). Pure/testable split (mirrors sem-export.ts / search-audit.ts):
// this file only turns already-resolved facts into a client-facing markdown document. Every DB read
// and the `files`/`deliverables` write live in search-reports.controller.ts (a SEPARATE file from
// search.controller.ts, per this ticket's file-ownership rule — SM-21 owns that file's edit surface
// this wave, and SM-10 already owns its own REPORTS section: listReports/getReport/draftReportNarrative,
// which this file/controller never touches or re-implements).
//
// ── WHY THIS EXISTS: THE HONESTY RULES THIS TICKET IS GRADED ON (ticket brief, restated at point of
//    use so a reader of the render function doesn't have to go back to the ticket to know WHY) ──────
// 1. "A report LEAVES THE BUILDING" — once delivered, a caveat can never be appended after the fact.
//    Every section below either shows a number WITH its own disclosure inline (never in a trailing
//    footnote a reader can miss) or shows an explicit "no data" state — never a bare number with no
//    surrounding context for a client who cannot ask a follow-up question.
// 2. Cost-to-serve (`search_provider_calls.cost_usd`) NEVER appears here, in any form, at any
//    granularity — that is OUR vendor spend (design addendum §A3), not the client's information. The
//    only money this file ever renders is the client's OWN ad spend (`search_campaign_metrics_daily.
//    cost_minor`), explicitly labelled as such. Nothing in `ReportRenderInput` carries a `costUsd`
//    field for exactly this reason — there is nothing here FOR a caller to accidentally wire in.
// 3. Simulated data is watermarked, never silently rendered as real (mirrors sem-export.ts's own
//    ratified precedent: a `-SIMULATED` filename suffix + an in-document banner, not a refusal to
//    deliver — a refusal would make the report gate on nothing the reviewer can control mid-review).
// 4. Freshness/sampling facts (GSC's 2-3 day lag, GA4's sampling) survive into the rendered document —
//    reusing google/gsc-client.ts's OWN `GSC_FRESHNESS_LAG_DAYS` constant rather than restating the
//    number, so the two can never drift.
// 5. Empty is not zero: a section with literally no underlying rows renders an explicit "no data for
//    this period" line, never a chart/number implying a real zero was measured.
// 6. No new metric definitions: `rankTop10`/`criticalFindingsOpen`/`kpiTargets` are read VERBATIM from
//    the already-frozen `search_reports.metrics` JSON that SM-10's `draftReportNarrative` computed —
//    this file never recomputes them differently. The one genuinely NEW figure this file computes
//    (rank-snapshot real/simulated provenance) is stated as a SEPARATE, explicitly-dated disclosure
//    ("as of render time") beside the frozen count, never as a competing redefinition of it.

export interface ProvenanceCounts {
  real: number;
  simulated: number;
}

export interface SimulatedRow {
  simulated: boolean;
}

/** Generic real/simulated tally over any row carrying a `simulated` flag. Re-implemented here (not
 *  imported) rather than reaching into sem-export.ts's private `summarizeKeywordProvenance` — same
 *  posture that file's own header takes toward its siblings: a private helper stays private, the
 *  TYPE-level shape is what's allowed to be shared, and this module's rows (rank/GSC/GA4/Ads) are a
 *  different shape than sem-export's keyword rows anyway. */
export function summarizeSimulated(rows: SimulatedRow[]): ProvenanceCounts {
  let real = 0;
  let simulated = 0;
  for (const r of rows) {
    if (r.simulated) simulated++;
    else real++;
  }
  return { real, simulated };
}

export function hasAnySimulated(p: ProvenanceCounts): boolean {
  return p.simulated > 0;
}
export function isAllSimulated(p: ProvenanceCounts): boolean {
  return p.simulated > 0 && p.real === 0;
}

/** Parses a report `period` into a queryable [start, end] inclusive date range. Reports are drafted
 *  against a free-form `period` label (search_reports.period is plain `text`, no CHECK) — the two
 *  shapes this module's own callers actually produce are `'YYYY-MM'` (SM-10's monthly cadence) and,
 *  for an 'adhoc'/'audit' kind report, anything a human typed. A recognized `YYYY-MM` resolves to that
 *  calendar month; anything else falls back to the 30 days ending `fallbackEnd` (the report's own
 *  `created_at`) — a defensible default for an ad-hoc report with no calendar period of its own, never
 *  a silent full-history query that could pull in data the narrative was never drafted against. */
export function periodDateRange(period: string, fallbackEnd: Date): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period.trim());
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

export interface ReportKpiTargetFact {
  metric: string;
  target: number;
  direction: string;
}

/** The frozen SM-10 snapshot, read back verbatim — see file header rule 6. */
export interface FrozenReportMetrics {
  rankTop10: number;
  criticalFindingsOpen: number;
  kpiTargets: ReportKpiTargetFact[];
}

/** `null` = no rank snapshots exist for this property at all (rule 5: empty, not zero). Present when
 *  at least one latest-per-(keyword,engine,device) snapshot exists — `provenance` is this ticket's
 *  own additive disclosure (rule 6), computed over the SAME "latest snapshot per tracked combination"
 *  shape search.controller.ts's draftReportNarrative and index.ts's rollup both already use, so the
 *  set of rows behind `provenance` is provably the set the frozen `rankTop10` count was drawn from —
 *  never a differently-shaped query that could silently disagree with it. */
export interface RankDisclosure {
  provenance: ProvenanceCounts;
  asOf: string; // ISO timestamp this provenance snapshot was computed — NOT when rankTop10 was frozen.
}

export interface AuditDisclosure {
  auditsCompleted: number;
}

export interface GscDisclosure {
  present: boolean;
  totalClicks: number;
  totalImpressions: number;
  topQueries: { query: string; clicks: number; impressions: number }[];
  provenance: ProvenanceCounts;
  latestDate: string | null;
  lagDays: number;
}

export interface Ga4Disclosure {
  present: boolean;
  totalSessions: number;
  totalConversions: number;
  provenance: ProvenanceCounts;
  anySampled: boolean;
}

/** `totalClientSpendMinor` is the CLIENT's own ad spend (`search_campaign_metrics_daily.cost_minor`,
 *  design addendum §A3) — never our vendor cost-to-serve, which never reaches this file at all (see
 *  file header rule 2). `currency` is `null` only when `present` is false (no rows to read one from). */
export interface AdsDisclosure {
  present: boolean;
  totalClientSpendMinor: number;
  currency: string | null;
  totalClicks: number;
  totalImpressions: number;
  provenance: ProvenanceCounts;
}

export interface ReportRenderInput {
  reportId: string;
  engagementName: string;
  clientName: string;
  period: string;
  kind: string;
  narrativeMd: string;
  frozen: FrozenReportMetrics;
  rank: RankDisclosure | null;
  audit: AuditDisclosure;
  gsc: GscDisclosure;
  ga4: Ga4Disclosure;
  ads: AdsDisclosure;
  generatedAt: string; // ISO
}

export interface ReportRenderResult {
  markdown: string;
  anySimulated: boolean;
  allSimulated: boolean;
  filename: string;
}

function fmtInt(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}
function fmtMoneyMinor(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

/** Renders the client-facing report body as markdown (see the standing platform gap this ticket must
 *  name, rather than fake: there is no chart/PDF layer yet — `renderReportMarkdown`'s output is the
 *  full client-facing artifact for THIS ticket; a PDF/branded-chart layer is a real, named dependency
 *  for a later ticket, not something this function pretends to already have).
 *
 *  Never throws — every section here is built from already-validated/typed facts, so there is no
 *  parse step that can fail the way ai-drafts.ts's gateway-response parsers can. */
export function renderReportMarkdown(input: ReportRenderInput): ReportRenderResult {
  const sectionProvenances: ProvenanceCounts[] = [];
  if (input.rank) sectionProvenances.push(input.rank.provenance);
  if (input.gsc.present) sectionProvenances.push(input.gsc.provenance);
  if (input.ga4.present) sectionProvenances.push(input.ga4.provenance);
  if (input.ads.present) sectionProvenances.push(input.ads.provenance);

  const totals = sectionProvenances.reduce(
    (acc, p) => ({ real: acc.real + p.real, simulated: acc.simulated + p.simulated }),
    { real: 0, simulated: 0 },
  );
  const anySimulated = hasAnySimulated(totals);
  const allSimulated = sectionProvenances.length > 0 && isAllSimulated(totals);

  const lines: string[] = [];
  lines.push(`# ${input.engagementName} — ${input.kind} report — ${input.period}`);
  lines.push("");
  lines.push(`Prepared for: **${input.clientName}**  `);
  lines.push(`Generated: ${input.generatedAt}`);
  lines.push("");

  // Rule 1/3: the honesty banner renders IMMEDIATELY after the title, beside the very first number a
  // reader will see below it — never only in a trailing footnote.
  if (allSimulated) {
    lines.push(
      "> ⚠️ **SIMULATED DATA.** Every figure in this report was produced by the platform's " +
        "simulate/demo mode. None of it reflects real search-engine, analytics, or advertising " +
        "performance — do not act on it or represent it to anyone as real.",
    );
    lines.push("");
  } else if (anySimulated) {
    lines.push(
      "> ⚠️ **MIXED DATA.** Some figures below are marked **[SIMULATED]** — those are demo/test " +
        "values, not real performance. Figures without that mark are real, verified data.",
    );
    lines.push("");
  }

  // ── Narrative ──────────────────────────────────────────────────────────────────────────────────
  lines.push("## Summary");
  lines.push(input.narrativeMd.trim().length > 0 ? input.narrativeMd.trim() : "_No narrative drafted._");
  lines.push("");

  // ── Rankings (frozen count; provenance disclosed separately — rule 6) ─────────────────────────────
  lines.push("## Search rankings");
  if (!input.rank) {
    lines.push("_No rank-tracking data collected yet for this property._");
  } else {
    const tag = isAllSimulated(input.rank.provenance) ? " **[SIMULATED]**" : hasAnySimulated(input.rank.provenance) ? " **[MIXED]**" : "";
    lines.push(`- Keywords currently ranking top-10: **${fmtInt(input.frozen.rankTop10)}**${tag}`);
    lines.push(
      `- Rank-tracking data provenance (as of ${input.rank.asOf}): ${fmtInt(input.rank.provenance.real)} real, ` +
        `${fmtInt(input.rank.provenance.simulated)} simulated tracked keyword/engine/device combinations.`,
    );
  }
  lines.push("");

  // ── Technical audits ───────────────────────────────────────────────────────────────────────────
  lines.push("## Technical audits");
  if (input.audit.auditsCompleted === 0) {
    lines.push("_No technical audits completed yet for this property._");
  } else {
    lines.push(
      `- Open critical findings: **${fmtInt(input.frozen.criticalFindingsOpen)}** ` +
        `(across ${fmtInt(input.audit.auditsCompleted)} completed audit(s))`,
    );
  }
  lines.push("");

  // ── KPI targets ────────────────────────────────────────────────────────────────────────────────
  lines.push("## KPI targets");
  if (input.frozen.kpiTargets.length === 0) {
    lines.push("_No KPI targets set for this engagement._");
  } else {
    lines.push("| Metric | Target | Direction |");
    lines.push("|---|---|---|");
    for (const k of input.frozen.kpiTargets) lines.push(`| ${k.metric} | ${k.target} | ${k.direction} |`);
  }
  lines.push("");

  // ── Search Console (GSC) ──────────────────────────────────────────────────────────────────────
  lines.push("## Search Console (organic search)");
  if (!input.gsc.present) {
    lines.push("_No Search Console data pulled for this period._");
  } else {
    const tag = isAllSimulated(input.gsc.provenance) ? " **[SIMULATED]**" : hasAnySimulated(input.gsc.provenance) ? " **[MIXED]**" : "";
    lines.push(`- Clicks: **${fmtInt(input.gsc.totalClicks)}**, Impressions: **${fmtInt(input.gsc.totalImpressions)}**${tag}`);
    if (input.gsc.latestDate) {
      lines.push(
        `- Data through ${input.gsc.latestDate}. Search Console typically lags ${input.gsc.lagDays} ` +
          "days behind real time — the most recent days of the period may not be reflected yet.",
      );
    }
    if (input.gsc.topQueries.length > 0) {
      lines.push("");
      lines.push("| Query | Clicks | Impressions |");
      lines.push("|---|---|---|");
      for (const q of input.gsc.topQueries.slice(0, 10)) lines.push(`| ${q.query} | ${fmtInt(q.clicks)} | ${fmtInt(q.impressions)} |`);
    }
  }
  lines.push("");

  // ── Analytics (GA4) ────────────────────────────────────────────────────────────────────────────
  lines.push("## Analytics (GA4)");
  if (!input.ga4.present) {
    lines.push("_No Analytics data pulled for this period._");
  } else {
    const tag = isAllSimulated(input.ga4.provenance) ? " **[SIMULATED]**" : hasAnySimulated(input.ga4.provenance) ? " **[MIXED]**" : "";
    lines.push(`- Sessions: **${fmtInt(input.ga4.totalSessions)}**, Conversions: **${fmtInt(input.ga4.totalConversions)}**${tag}`);
    if (input.ga4.anySampled) {
      lines.push("- Some of the figures above are based on **sampled** data from Google Analytics and are estimates, not exact counts.");
    }
  }
  lines.push("");

  // ── Ads (client media spend — never our cost-to-serve; rule 2) ────────────────────────────────
  lines.push("## Paid search (client media spend)");
  if (!input.ads.present) {
    lines.push("_No advertising data available for this period._");
  } else {
    const tag = isAllSimulated(input.ads.provenance) ? " **[SIMULATED]**" : hasAnySimulated(input.ads.provenance) ? " **[MIXED]**" : "";
    const currency = input.ads.currency ?? "USD";
    lines.push(
      `- Your media spend: **${fmtMoneyMinor(input.ads.totalClientSpendMinor, currency)}**${tag} ` +
        `— Clicks: ${fmtInt(input.ads.totalClicks)}, Impressions: ${fmtInt(input.ads.totalImpressions)}`,
    );
    lines.push("- This is your own advertising account spend, not a platform service fee.");
  }
  lines.push("");

  lines.push("---");
  lines.push(`_Report id ${input.reportId}. Rendered as Markdown — a formatted PDF layer is not yet built (platform gap, tracked separately)._`);

  return {
    markdown: lines.join("\n"),
    anySimulated,
    allSimulated,
    filename: reportFilename(input.reportId, input.period, input.kind, anySimulated),
  };
}

/** Same `-SIMULATED` filename-suffix convention sem-export.ts's `baseFilename` already ratified for
 *  the SM-30 CSV exports — reused here, not reinvented, for a second independent, parsing-proof
 *  channel that a report containing any simulated figure carries the marker (alongside the in-document
 *  banner `renderReportMarkdown` always emits). */
export function reportFilename(reportId: string, period: string, kind: string, anySimulated: boolean): string {
  const shortId = reportId.slice(0, 8);
  const periodSlug = period.replace(/[^a-zA-Z0-9-]/g, "") || "period";
  return `seo-report-${kind}-${periodSlug}-${shortId}${anySimulated ? "-SIMULATED" : ""}.md`;
}
