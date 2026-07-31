import type { ReactNode } from "react";
import type { ReportDocument, ReportSeries, ReportDistribution, ReportTable } from "@/lib/reports";
import type { CheckinDay } from "@/lib/checkins";
import { TrendLine } from "./charts/TrendLine";
import { GroupedBars } from "./charts/GroupedBars";
import { StackedBars } from "./charts/StackedBars";
import { Donut } from "./charts/Donut";
import { ReportTableView } from "./charts/ReportTableView";
import { CalendarHeatmap } from "./charts/CalendarHeatmap";

// TR-17's grain-specific chart composition — the thing `ReportViewer`'s `children` slot exists for
// (its own header comment: "that arrangement genuinely differs per grain and is TR-17's job to
// wire"). §15's TR-13 landing note is the governing rule here: "§7's chart table is a USEFUL SUBSET
// server-side, not exhaustive... render what the document actually contains and degrade honestly
// for what it doesn't — do not render an empty chart frame that implies missing data is zero."
//
// So every section below is gated on the document key it needs actually being present, and the
// following §7-named charts are DELIBERATELY NOT attempted because `document-builder.ts` (TR-13)
// does not emit the series/distribution/table they'd need — rendering them would be an empty frame
// implying zero, which is the exact failure this rule forbids:
//   - Burndown/CumulativeFlow (project) — explicitly deferred per §15's TR-13 landing note.
//   - workload-by-person stacked bars / status-tag donut / milestone table (project) — no such
//     distribution/table exists in the live document.
//   - capacity-vs-logged area / compliance heatmap (department) — not emitted.
//   - cross-dept stacked area over time / unattributed-bucket tile (company) — not emitted; the
//     nearest honest substitute for "dept-comparison" is the `department_portfolio` TABLE, rendered
//     below as a table rather than force-adapted into a bar chart (§7: "no adapter layer" — this
//     kit's components take the document's own shapes directly, never a caller-built transform).
//   - "top risks/anomalies table" (company) — already covered: `ReportViewer` renders
//     `document.highlights` itself, directly beneath the KPI wall.
//
// A ratio SERIES (`on_time_rate`) is deliberately never charted here as its own `TrendLine`: at
// week/month bucket granularity `TrendLine` only recomputes an honest per-bucket ratio when the
// sibling numerator/denominator series are ALSO present in the array it's given (it uses that same
// array both to render lines and to resolve ratio lookups — see `lib/reports.ts`'s bucketing
// header). Passing just `[on_time_rate]` would silently sum daily percentages across a bucket —
// exactly the average-of-averages bug §5.4/ruling 5 warns about. The two counters behind it
// (`tasks_completed_on_time`, `tasks_completed_with_due_date`) are both plain additive counts, so
// showing THEM as grouped bars is both what §7 literally names ("on-time vs completed grouped
// bars") and immune to that bug at any bucket width — this is the one place TR-17 had to make a
// correctness call rather than a display call.
function findSeries(document: ReportDocument, key: string): ReportSeries | undefined {
  return document.series.find((s) => s.key === key);
}
function findDist(document: ReportDocument, key: string): ReportDistribution | undefined {
  return document.distributions.find((d) => d.key === key);
}
function findTable(document: ReportDocument, key: string): ReportTable | undefined {
  return document.tables.find((t) => t.key === key);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rc-section">
      <h3 className="rc-section__title">{title}</h3>
      {children}
    </section>
  );
}

/** The subset `document-builder.ts` computes IDENTICALLY for every grain (§7's per-grain table
 *  names activity/on-time explicitly for person; the backend's own design computes them uniformly
 *  across all four grains regardless — rendering them everywhere is "what the document actually
 *  contains", not an invented chart). */
function CommonCharts({ document }: { document: ReportDocument }) {
  const { header } = document;
  const activity = findSeries(document, "activity_events");
  const onTimeNum = findSeries(document, "tasks_completed_on_time");
  const onTimeDenom = findSeries(document, "tasks_completed_with_due_date");
  const evidence = findDist(document, "evidence_by_source");
  return (
    <>
      {activity && (
        <Section title="Activity">
          <TrendLine series={[activity]} dayCount={header.dayCount} title="Activity" unit={activity.unit} />
        </Section>
      )}
      {onTimeNum && onTimeDenom && (
        <Section title="Completed on time vs. with a due date">
          <GroupedBars kind="time" series={[onTimeNum, onTimeDenom]} dayCount={header.dayCount} title="On-time vs completed" />
        </Section>
      )}
      {evidence && (
        <Section title="Evidence by source">
          <StackedBars kind="category" distributions={[evidence]} title="Evidence by source" />
        </Section>
      )}
    </>
  );
}

// TR-38 — check-in `CalendarHeatmap` (person grain). Compliance data lives behind a SEPARATE
// endpoint (`GET /checkins`, checkins.controller.ts §6.2), not on `ReportDocument` at all — so
// unlike every other section in this file, its data can't be found by key on `document`. The
// person-grain page fetches it separately (its own try/catch, so a failure there degrades by
// simply omitting this section rather than failing the whole report) and passes it down as
// `checkinDays`, already reduced to `CalendarHeatmap`'s four-state shape by
// `lib/checkins.ts`'s `buildCalendarDays` (§5.3's false-negative guard applied there, not here —
// this component never sees raw history rows, only the already-honest calendar).
export function PersonCharts({ document, checkinDays }: { document: ReportDocument; checkinDays?: CheckinDay[] }) {
  const timeByProject = findDist(document, "time_by_project");
  const contributions = findTable(document, "contributions");
  return (
    <div className="rc-sections-grid">
      <CommonCharts document={document} />
      {checkinDays && checkinDays.length > 0 && (
        <Section title="Check-in compliance">
          <CalendarHeatmap days={checkinDays} title="Check-in compliance" />
        </Section>
      )}
      {timeByProject && (
        <Section title="Time by project">
          <Donut distribution={timeByProject} title="Time by project" />
        </Section>
      )}
      {contributions && (
        <Section title={contributions.label}>
          <ReportTableView table={contributions} />
        </Section>
      )}
    </div>
  );
}

export function ProjectCharts({ document }: { document: ReportDocument }) {
  const { header } = document;
  const throughput = findSeries(document, "throughput_weighted");
  const overdue = findTable(document, "overdue_tasks");
  return (
    <div className="rc-sections-grid">
      <CommonCharts document={document} />
      {throughput && (
        <Section title="Throughput (weighted)">
          <GroupedBars kind="time" series={[throughput]} dayCount={header.dayCount} title="Throughput" />
        </Section>
      )}
      {overdue && (
        <Section title={overdue.label}>
          <ReportTableView table={overdue} />
        </Section>
      )}
    </div>
  );
}

export function DepartmentCharts({ document }: { document: ReportDocument }) {
  const { header } = document;
  const throughput = findSeries(document, "throughput_weighted");
  const perPerson = findTable(document, "per_person");
  const servedCompanies = findDist(document, "served_companies_split");
  return (
    <div className="rc-sections-grid">
      <CommonCharts document={document} />
      {throughput && (
        <Section title="Throughput (weighted)">
          <TrendLine series={[throughput]} dayCount={header.dayCount} title="Throughput" unit={throughput.unit} />
        </Section>
      )}
      {servedCompanies && (
        <Section title="Served companies">
          <StackedBars kind="category" distributions={[servedCompanies]} title="Served companies" />
        </Section>
      )}
      {perPerson && (
        <Section title={perPerson.label}>
          <ReportTableView table={perPerson} />
        </Section>
      )}
    </div>
  );
}

export function CompanyCharts({ document }: { document: ReportDocument }) {
  const { header } = document;
  const throughput = findSeries(document, "throughput_weighted");
  const deptPortfolio = findTable(document, "department_portfolio");
  return (
    <div className="rc-sections-grid">
      <CommonCharts document={document} />
      {throughput && (
        <Section title="Throughput (weighted)">
          <TrendLine series={[throughput]} dayCount={header.dayCount} title="Throughput" unit={throughput.unit} />
        </Section>
      )}
      {deptPortfolio && (
        <Section title={deptPortfolio.label}>
          <ReportTableView table={deptPortfolio} />
        </Section>
      )}
    </div>
  );
}
