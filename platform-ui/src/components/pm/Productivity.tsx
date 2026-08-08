"use client";
import { useState } from "react";
import type { ProductivityReport, ProductivityComponents } from "@/lib/pm";
import type { ReportSeries, ReportKpi } from "@/lib/reports";
import { Card, KpiTile } from "@/components/ui";
import { TrendLine } from "@/components/reports/charts/TrendLine";
import { StackedBars } from "@/components/reports/charts/StackedBars";
import { KpiTiles } from "@/components/reports/charts/KpiTiles";
import { PM_TERMS } from "@/lib/pmVocabulary";
import "./productivity.css";

// Productivity view (plan §1.7, workstream E, tickets P4-E3/E4) — the second cross-project view
// Repsona has that we didn't (§1.7's "we have every ingredient and zero assembly"). Consumes
// `GET /api/:t/pm/productivity` (P4-E2) as-is; builds nothing of its own on the backend.
//
// THE THING THAT MATTERS MOST HERE: `report.score` is `null` ON PURPOSE (see lib/pm.ts's
// `ProductivityReport` header). Repsona shows a big opaque number (430, 218) that nobody can
// explain; ours deliberately doesn't, because the composite formula — and who gets to see it — is
// a people decision (plan decision 9 / ticket P4-E1) nobody has made. Rendering `null` as `0` would
// be worse than rendering nothing: a `0` looks like a real (bad) measurement, and this is a number
// people would be judged by. So the score renders as an explicit "—" plus `scoreNote` in full, never
// silently coerced — `ScoreTile` below is the one place in this file that owns that rule.
//
// COMPOSED FROM THE REPORTS CHART KIT, NOT FORKED: `KpiTiles`/`TrendLine`/`StackedBars` are the
// exact reports-kit components (own `--rc-*` palette, own dark-mode support already wired via
// tokens/colors.css) — reused unmodified, same precedent as `Charts.tsx` importing `Donut`
// unmodified (P4-A7). The one thing the kit does NOT have a shape for is a GITHUB-STYLE
// INTENSITY heatmap — `reports/charts/CalendarHeatmap` is hard-coded to a 4-state check-in
// COMPLIANCE enum (submitted/missed/excused/not_expected), not a numeric day total, and extending
// its contract is out of this ticket's file ownership. `Heatmap` below is therefore hand-rolled
// (no new dependency, same "no chart library" constraint — it's a CSS grid + `data-level` buckets,
// not an SVG library), styled through the PM-scoped `--pm-*` tokens (`styles/tokens/pm.css`) since
// it is new PM-owned paint, not a re-export of the reports kit's own palette.
export interface ProductivityProps {
  report: ProductivityReport;
  /** Whose series this is, for the heading — never re-derived from `report.userId` (a raw id is
   *  not a display name); the caller already knows this from `getMe`/`listMembers`. */
  scopeName: string;
  viewingSelf: boolean;
}

const COMPONENT_LABELS: Record<keyof Omit<ProductivityComponents, "total">, string> = {
  completedTasks: "Completed tasks",
  assignedCompleted: `Completed while holding the ${PM_TERMS.ball.toLowerCase()}`,
  involvedCompleted: "Completed tasks you were involved in",
  tasksAccepted: `${PM_TERMS.ball} accepted`,
  reactionsGiven: "Reactions given",
  reactionsReceived: "Reactions received",
  notesContributions: `${PM_TERMS.notes} contributions`,
  comments: `${PM_TERMS.comment}s`,
};
const COMPONENT_ORDER = Object.keys(COMPONENT_LABELS) as (keyof Omit<ProductivityComponents, "total">)[];

export function Productivity({ report, scopeName, viewingSelf }: ProductivityProps) {
  const kpis: ReportKpi[] = [
    ...COMPONENT_ORDER.map((key) => ({
      metricKey: `productivity.${key}`,
      label: COMPONENT_LABELS[key],
      unit: "count" as const,
      value: report.totals[key],
      appraisalSafe: false, // none of this feeds appraisal scoring — see ScoreTile below
    })),
    {
      metricKey: "productivity.total",
      label: "Total activity",
      unit: "count" as const,
      value: report.totals.total,
      appraisalSafe: false,
    },
  ];

  const totalSeries: ReportSeries = {
    key: "total", label: "Total activity", unit: "count", kind: "area",
    points: report.series.map((d) => ({ t: d.date, v: d.total })),
  };
  const stackSeries: ReportSeries[] = COMPONENT_ORDER.map((key) => ({
    key, label: COMPONENT_LABELS[key], unit: "count", kind: "bar",
    points: report.series.map((d) => ({ t: d.date, v: d[key] })),
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ScoreTile scoreNote={report.scoreNote} />

      <Card title={viewingSelf ? "Your activity, by type" : `${scopeName}'s activity, by type`}>
        <KpiTiles kpis={kpis} />
      </Card>

      <Card
        title="Activity calendar"
        headerRight={<span className="prod-range">{fmtRange(report.from, report.to)} · {report.days} days</span>}
      >
        <Heatmap series={report.series} />
      </Card>

      <Card title="Activity trend">
        <TrendLine series={[totalSeries]} dayCount={report.days} title="Total activity" unit="count" />
      </Card>

      <Card title="Activity by type">
        <StackedBars kind="time" series={stackSeries} dayCount={report.days} title="Activity by type" />
      </Card>

      <p className="prod-reconcile">
        This is a live, personal breakdown of the same activity ledger <code>Reports → Person</code>{" "}
        draws from — but not the same number twice. Reports&apos; <code>delivery.tasks_completed</code>{" "}
        is built by a nightly fact job and is the sealed, appraisal-safe record; the counts here are
        computed live and are explicitly NOT appraisal-safe (see the &ldquo;appraisal-unsafe&rdquo;
        tag on every tile above). The two can disagree for a few hours around the nightly refresh —
        that is expected, not a bug. For the number that counts toward an appraisal, use Reports.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The score — deliberately not a KpiTiles entry. Visually set apart from the ordinary metric grid
// above/below it so it never gets mistaken for one: an "unmeasured" concept next to a set of real
// counts needs to look different, not just carry a different number.
function ScoreTile({ scoreNote }: { scoreNote: string }) {
  return (
    <Card title="Productivity score">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <KpiTile
          label="Composite score"
          value={<span aria-label="No composite score is computed">—</span>}
          foot="Not computed"
        />
        <p className="prod-score-note">{scoreNote}</p>
      </div>
    </Card>
  );
}

function fmtRange(from: string, to: string): string {
  const f = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${f(from)} – ${f(to)}`;
}

// ---------------------------------------------------------------------------
// GitHub-style year heatmap. Monday-first weeks (same ISO-week convention `lib/reports.ts`'s
// `bucketKeyFor` and the reports kit's `CalendarHeatmap` both already use), one column per week,
// `data-level` (0-4) driving colour through CSS so no literal ever appears in a style attribute.
// Every day in `series` already carries an explicit `total` (the backend zero-fills — "a gap day
// is 0, never an absent entry"), so there are no missing cells to pad around, only leading blanks
// to line the first real day up under its true weekday row.
interface DayCell { date: string; total: number; breakdown: ProductivityComponents; level: 0 | 1 | 2 | 3 | 4 }

function isoWeekday(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
}
function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
function monthShort(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
}

function levelFor(total: number, max: number): DayCell["level"] {
  if (total <= 0 || max <= 0) return 0;
  const pct = total / max;
  if (pct > 0.75) return 4;
  if (pct > 0.5) return 3;
  if (pct > 0.25) return 2;
  return 1;
}

function Heatmap({ series }: { series: ProductivityReport["series"] }) {
  if (series.length === 0) {
    return <p className="prod-empty">No activity history in range.</p>;
  }
  const max = Math.max(0, ...series.map((d) => d.total));
  const cells: DayCell[] = series.map((d) => ({ date: d.date, total: d.total, breakdown: d, level: levelFor(d.total, max) }));
  const leadingBlanks = isoWeekday(cells[0].date);
  const padded: (DayCell | null)[] = [...Array(leadingBlanks).fill(null), ...cells];
  const weekCount = Math.ceil(padded.length / 7);

  // A month label over the first column whose week contains the 1st (or the very first column).
  const monthLabels: (string | null)[] = Array.from({ length: weekCount }, (_, w) => {
    const first = padded.slice(w * 7, w * 7 + 7).find((c): c is DayCell => c !== null);
    if (!first) return null;
    const day = Number(first.date.slice(8, 10));
    if (w === 0 || day <= 7) return monthShort(first.date);
    return null;
  });

  const [hover, setHover] = useState<DayCell | null>(null);
  const activeDays = cells.filter((c) => c.total > 0).length;

  return (
    <div className="prod-heatmap">
      <p className="prod-heatmap__summary">
        <strong>{activeDays}</strong> of {cells.length} days had recorded activity in this range.
      </p>
      <div className="prod-heatmap__scroll">
        <div className="prod-heatmap__months" style={{ gridTemplateColumns: `repeat(${weekCount}, 11px)` }} aria-hidden>
          {monthLabels.map((m, i) => <span key={i} className="prod-heatmap__month">{m ?? ""}</span>)}
        </div>
        <div
          className="prod-heatmap__grid"
          style={{ gridTemplateColumns: `repeat(${weekCount}, 11px)` }}
          role="img"
          aria-label={`Activity calendar: ${activeDays} of ${cells.length} days had recorded activity`}
        >
          {padded.map((c, i) => (
            c === null
              ? <span key={`b-${i}`} className="prod-heatmap__cell" style={{ visibility: "hidden" }} aria-hidden />
              : (
                <button
                  key={c.date}
                  type="button"
                  className="prod-heatmap__cell"
                  data-level={c.level}
                  aria-label={`${fmtDay(c.date)}: ${c.total} activity unit${c.total === 1 ? "" : "s"}`}
                  onMouseEnter={() => setHover(c)}
                  onFocus={() => setHover(c)}
                  onMouseLeave={() => setHover(null)}
                  onBlur={() => setHover(null)}
                />
              )
          ))}
        </div>
      </div>
      <div className="prod-heatmap__legend" aria-hidden>
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => <span key={l} className="prod-heatmap__swatch" data-level={l} />)}
        <span>More</span>
      </div>
      {hover && (
        <div className="prod-heatmap__detail" role="status">
          <strong>{fmtDay(hover.date)}</strong> — {hover.total} total
          {hover.total > 0 && (
            <ul className="prod-heatmap__breakdown">
              {COMPONENT_ORDER.filter((k) => hover.breakdown[k] > 0).map((k) => (
                <li key={k}>{COMPONENT_LABELS[k]}: {hover.breakdown[k]}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <table className="prod-fallback">
        <caption>Activity calendar, as a table</caption>
        <thead><tr><th>Date</th><th>Total</th></tr></thead>
        <tbody>
          {cells.map((c) => <tr key={c.date}><td>{fmtDay(c.date)}</td><td>{c.total}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
