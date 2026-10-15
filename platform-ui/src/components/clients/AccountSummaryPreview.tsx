import type { ResultsKpi } from "@/lib/clientCentre";
import { summaryPeriodLabel, type SummarySnapshot } from "@/lib/clientReports";
import { formatDate } from "@/lib/format";
import "./accountSummary.css";

// PV7-07 — the frozen figures of an account summary, readable (BFF §56.1). Pure: the snapshot in, markup out, no state.
//
// What it shows is exactly what a client-wide contact of this client can already see: projects with their milestones and
// deliverables, what was completed in the month, how long each side took to answer, the Services & results numbers, and the
// client reports published that month. There is no money, task, time, person or internal gate in the snapshot, so there is none
// here. No list items are used (tables only): the Reports tab's rows are the page's only `<li>`s.
//
// HONESTY: a section the snapshot could not read (`null`) says so and is never shown as zero or as an empty table. A month that
// starts before milestone completion dates were recorded says from when they are known; deliverables are counted by when their
// status last changed, because a deliverable has no delivery date. A turnaround with too few answers says so rather than a number.

const when = (iso: string | null | undefined) => (iso ? formatDate(iso) : "—");

function Unread({ what }: { what: string }) {
  return <p className="as-unread">{what} could not be read when this summary was drafted. It is left out, not counted as zero.</p>;
}

function kpiValue(k: ResultsKpi): string {
  if (k.value === null) return "—";
  if (k.unit === "percent") return `${k.value}%`;
  if (k.unit === "ratio") return `${Math.round(k.value * 1000) / 10}%`;
  return k.value.toLocaleString("en-US");
}

function side(label: string, t: { medianDays: number | null; n: number; withheld: boolean }): string {
  if (t.withheld || t.medianDays === null) return `${label}: too few answers in the window to give a typical time (${t.n}).`;
  return `${label}: a typical answer took ${t.medianDays} ${t.medianDays === 1 ? "day" : "days"} (${t.n} ${t.n === 1 ? "answer" : "answers"}).`;
}

export function AccountSummaryPreview({ snapshot: s }: { snapshot: SummarySnapshot }) {
  const ms = s.completed.milestones;
  const ds = s.completed.deliverables;
  return (
    <div className="as-preview" aria-label={`Figures for ${summaryPeriodLabel(s.period)}`}>
      <p className="as-note">
        Frozen on {when(s.generatedAt)} for {summaryPeriodLabel(s.period)}. These are the figures the client&apos;s main contacts can
        already see. The current-state figures (projects, what is waiting) are as of that date.
      </p>
      {s.unavailable.length > 0 && (
        <p className="as-note as-note--warn" role="status">Some figures could not be read: {s.unavailable.join(", ")}. They are left out below.</p>
      )}

      <section aria-labelledby={`as-h-projects-${s.period}`}>
        <h3 id={`as-h-projects-${s.period}`} className="as-preview__h">Projects</h3>
        {s.projects === null ? <Unread what="The projects" /> : s.projects.length === 0 ? <p className="as-note">This client has no projects.</p> : (
          <table className="as-table">
            <thead>
              <tr>
                <th scope="col">Project</th><th scope="col">Status</th>
                <th scope="col" className="as-num">Milestones done</th><th scope="col" className="as-num">Late</th>
                <th scope="col" className="as-num">Deliverables delivered</th><th scope="col">Next milestone</th>
              </tr>
            </thead>
            <tbody>
              {s.projects.map((p) => (
                <tr key={p.projectId}>
                  <td>{p.name}</td><td>{p.status}</td>
                  <td className="as-num">{p.milestones.done} of {p.milestones.total}</td>
                  <td className="as-num">{p.milestones.late}</td>
                  <td className="as-num">{p.deliverables.delivered} of {p.deliverables.total}</td>
                  <td>{p.nextMilestone ? `${p.nextMilestone.name} (${formatDate(p.nextMilestone.dueDate)})` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {s.waiting === null ? <Unread what="What is waiting on each side" /> : (
          <p className="as-note">
            Waiting on the client: {s.waiting.onClient.count}{s.waiting.onClient.oldestSince ? `, the oldest since ${formatDate(s.waiting.onClient.oldestSince)}` : ""}.
            {" "}Waiting on us: {s.waiting.onUs.count}{s.waiting.onUs.oldestSince ? `, the oldest since ${formatDate(s.waiting.onUs.oldestSince)}` : ""}.
          </p>
        )}
      </section>

      <section aria-labelledby={`as-h-done-${s.period}`}>
        <h3 id={`as-h-done-${s.period}`} className="as-preview__h">Completed in {summaryPeriodLabel(s.period)}</h3>
        {ms === null ? <Unread what="The completed milestones" /> : (
          <>
            {ms.wholeMonthKnown !== true && (
              <p className="as-note as-note--warn">
                {ms.knownSince
                  ? `Milestone completion dates are recorded from ${formatDate(ms.knownSince)}, so milestones finished before then are not counted.`
                  : "Milestone completion dates are not recorded for this whole month, so the count may be incomplete."}
              </p>
            )}
            {ms.items.length === 0 ? <p className="as-note">No milestone was completed in this month.</p> : (
              <table className="as-table">
                <caption>{ms.count} {ms.count === 1 ? "milestone" : "milestones"} completed</caption>
                <thead><tr><th scope="col">Project</th><th scope="col">Milestone</th><th scope="col">Completed</th></tr></thead>
                <tbody>{ms.items.map((i, n) => <tr key={`${i.name}-${n}`}><td>{i.projectName}</td><td>{i.name}</td><td>{formatDate(i.completedOn)}</td></tr>)}</tbody>
              </table>
            )}
          </>
        )}
        {ds === null ? <Unread what="The delivered deliverables" /> : ds.items.length === 0 ? (
          <p className="as-note">No deliverable changed to delivered in this month.</p>
        ) : (
          <table className="as-table">
            <caption>{ds.count} {ds.count === 1 ? "deliverable" : "deliverables"} delivered (counted in the month its status last changed)</caption>
            <thead><tr><th scope="col">Project</th><th scope="col">Deliverable</th><th scope="col">Status</th><th scope="col">Changed</th></tr></thead>
            <tbody>{ds.items.map((i, n) => <tr key={`${i.name}-${n}`}><td>{i.projectName}</td><td>{i.name}</td><td>{i.status}</td><td>{formatDate(i.on)}</td></tr>)}</tbody>
          </table>
        )}
      </section>

      <section aria-labelledby={`as-h-turn-${s.period}`}>
        <h3 id={`as-h-turn-${s.period}`} className="as-preview__h">How quickly each side answers</h3>
        {s.turnaround === null ? <Unread what="The turnaround" /> : (
          <>
            <p className="as-note">The {s.turnaround.windowDays} days up to {formatDate(s.turnaround.windowEnd)}.</p>
            <p className="as-note">{side("The client", s.turnaround.client)}</p>
            <p className="as-note">{side("Us", s.turnaround.ours)}</p>
          </>
        )}
      </section>

      <section aria-labelledby={`as-h-results-${s.period}`}>
        <h3 id={`as-h-results-${s.period}`} className="as-preview__h">Services and results</h3>
        {s.results === null ? <Unread what="The services results" /> : s.results.services.length === 0 ? (
          <p className="as-note">No service has results to show.</p>
        ) : (
          s.results.services.map((card) => (
            <table className="as-table" key={`${card.service}-${card.title}`}>
              <caption>{card.title}{card.since ? `, since ${formatDate(card.since)}` : ""}</caption>
              <thead><tr><th scope="col">Figure</th><th scope="col" className="as-num">Now</th><th scope="col" className="as-num">Before</th></tr></thead>
              <tbody>
                {card.kpis.length === 0
                  ? <tr><td colSpan={3}>No figure to show for this service.</td></tr>
                  : card.kpis.map((k) => <tr key={k.key}><td>{k.label}</td><td className="as-num">{kpiValue(k)}</td><td className="as-num">{k.previous === null ? "—" : k.previous.toLocaleString("en-US")}</td></tr>)}
              </tbody>
            </table>
          ))
        )}
        {s.results && s.results.unavailable.length > 0 && (
          <p className="as-note as-note--warn">These services could not be read: {s.results.unavailable.join(", ")}.</p>
        )}
      </section>

      <section aria-labelledby={`as-h-reports-${s.period}`}>
        <h3 id={`as-h-reports-${s.period}`} className="as-preview__h">Reports published this month</h3>
        {s.reports === null ? <Unread what="The published reports" /> : s.reports.length === 0 ? (
          <p className="as-note">No report was published to the client in this month.</p>
        ) : (
          <table className="as-table">
            <thead><tr><th scope="col">Report</th><th scope="col">Period</th><th scope="col">Published</th></tr></thead>
            <tbody>{s.reports.map((r) => <tr key={r.id}><td>{r.title}</td><td>{formatDate(r.periodStart)} to {formatDate(r.periodEnd)}</td><td>{formatDate(r.publishedOn)}</td></tr>)}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
