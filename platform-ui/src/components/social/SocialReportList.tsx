// SCP-5a (BFF §63.18, §63.17): the Social reports list: every client's reports by month, with the state in the design's four words, whether the notes are complete, and the SIMULATED mark.
// Pure over the one `GET reports` answer: the filters are links (the status and the period go in the page's query), so the list needs no script. An empty list is only ever said when the
// read SUCCEEDED; the page turns a refused or failed read into its own sentence before it gets here.
import Link from "next/link";
import { formatDate } from "@/lib/format";
import {
  REPORT_STATES, filtersHref, periodWords, periodsOf, reportHref, reportStateWords, rowStateLine, sortReports, type SocialReportRow,
} from "@/lib/socialReports";
import { SimulatedMark } from "./SimulatedMark";
import "./cycles.css";
import "./reports.css";

export function SocialReportList({ deptId, rows, filters }: { deptId: string; rows: readonly SocialReportRow[]; filters: { status: string | null; period: string | null } }) {
  const shown = sortReports(rows);
  const periods = periodsOf(rows);
  const filtered = filters.status !== null || filters.period !== null;
  return (
    <div className="scp-reports">
      <nav className="scp-reports__filters" aria-label="Filter the reports">
        <div className="scp-reports__filter" role="group" aria-label="Status">
          <span>Status</span>
          <Link className="scp-reports__chip" href={filtersHref(deptId, { ...filters, status: null })} aria-current={filters.status === null}>All</Link>
          {REPORT_STATES.map((s) => (
            <Link key={s} className="scp-reports__chip" href={filtersHref(deptId, { ...filters, status: s })} aria-current={filters.status === s}>{reportStateWords(s)}</Link>
          ))}
        </div>
        <div className="scp-reports__filter" role="group" aria-label="Period">
          <span>Month</span>
          <Link className="scp-reports__chip" href={filtersHref(deptId, { ...filters, period: null })} aria-current={filters.period === null}>All</Link>
          {periods.map((p) => (
            <Link key={p} className="scp-reports__chip" href={filtersHref(deptId, { ...filters, period: p })} aria-current={filters.period === p}>{periodWords(p)}</Link>
          ))}
          {filters.period !== null && !periods.includes(filters.period) && (
            <Link className="scp-reports__chip" href={filtersHref(deptId, filters)} aria-current={true}>{periodWords(filters.period)}</Link>
          )}
        </div>
      </nav>

      {shown.length === 0 ? (
        <p className="scp-note" role="status">
          {filtered ? "No report matches this filter." : "No client has a report yet. The officer drafts each month's report from here, once the month is over."}
          {filtered && <> <Link className="scp-link" href={filtersHref(deptId, { status: null, period: null })}>Show every report</Link></>}
        </p>
      ) : (
        <table className="scp-reports__table">
          <caption className="scp-field__hint" style={{ textAlign: "left", paddingBottom: 6 }}>{shown.length} {shown.length === 1 ? "report" : "reports"}</caption>
          <thead>
            <tr><th scope="col">Client</th><th scope="col">Month</th><th scope="col">State</th><th scope="col">Notes</th><th scope="col">Last step</th></tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td><Link className="scp-link" href={reportHref(deptId, r.id)}>{r.clientName}</Link> {r.simulated && <SimulatedMark of="metrics" />}</td>
                <td>{periodWords(r.period, r.kind)}{r.kind !== "monthly" ? ` (${r.kind === "adhoc" ? "ad hoc" : r.kind})` : ""}</td>
                <td><span className={`scp-reports__state scp-reports__state--${r.status}`}>{rowStateLine(r)}</span></td>
                <td>{r.kind !== "monthly" ? "Not needed" : r.notesComplete ? "Complete" : "Incomplete"}</td>
                <td>{r.deliveredAt ? `Sent ${formatDate(r.deliveredAt)}` : r.approvedAt ? `Approved ${formatDate(r.approvedAt)}` : r.createdAt ? `Drafted ${formatDate(r.createdAt)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
