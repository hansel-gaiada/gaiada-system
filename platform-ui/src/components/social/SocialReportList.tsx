// SCP-5a (BFF §63.18, §63.17), SCP-5 W5-A4 (§63.24): the Social reports list: every client's reports of the chosen kind by period, with the state in the design's four words, whether the notes (or, for a
// daily or weekly report, the summary) are done, the day it falls due and the SIMULATED mark. Pure over the one `GET reports` answer: the filters are links (the kind, the status and the period go in the
// page's query), so the list needs no script. An empty list is only ever said when the read SUCCEEDED; the page turns a refused or failed read into its own sentence before it gets here.
import Link from "next/link";
import { formatDate } from "@/lib/format";
import { REPORT_STATES, filtersHref, periodWords, reportHref, reportStateWords, rowStateLine, sortReports, type SocialReportRow } from "@/lib/socialReports";
import { dayWords, isShortKind, kindNoun, type KindTab } from "@/lib/socialReportKinds";
import { SimulatedMark } from "./SimulatedMark";
import "./cycles.css";
import "./reports.css";

export function SocialReportList({ deptId, rows, filters, tab = "monthly", fiscalYearStartMonth = 1 }: {
  deptId: string;
  rows: readonly SocialReportRow[];
  filters: { status: string | null; period: string | null };
  /** The kind the list shows (the monthly report by default). */
  tab?: KindTab;
  fiscalYearStartMonth?: number;
}) {
  const shown = sortReports(rows);
  const filtered = filters.status !== null || filters.period !== null;
  const link = (f: { status: string | null; period: string | null }) => filtersHref(deptId, { ...f, kind: tab });
  const short = tab === "daily" || tab === "weekly";
  return (
    <div className="scp-reports">
      <nav className="scp-reports__filters" aria-label="Filter the reports">
        <div className="scp-reports__filter" role="group" aria-label="Status">
          <span>Status</span>
          <Link className="scp-reports__chip" href={link({ ...filters, status: null })} aria-current={filters.status === null}>All</Link>
          {REPORT_STATES.map((s) => (
            <Link key={s} className="scp-reports__chip" href={link({ ...filters, status: s })} aria-current={filters.status === s}>{reportStateWords(s)}</Link>
          ))}
        </div>
      </nav>

      {shown.length === 0 ? (
        <p className="scp-note" role="status">
          {filtered ? "No report matches this filter." : `No client has a ${tab === "other" ? "campaign or ad hoc" : kindNoun(tab).toLowerCase()} yet. The officer drafts them from here, or generates them with AI.`}
          {filtered && <> <Link className="scp-link" href={link({ status: null, period: null })}>Show every report of this kind</Link></>}
        </p>
      ) : (
        <table className="scp-reports__table">
          <caption className="scp-field__hint" style={{ textAlign: "left", paddingBottom: 6 }}>{shown.length} {shown.length === 1 ? "report" : "reports"}</caption>
          <thead>
            <tr><th scope="col">Client</th><th scope="col">Period</th><th scope="col">State</th><th scope="col">{short ? "Summary" : "Notes"}</th><th scope="col">Due</th><th scope="col">Last step</th></tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td><Link className="scp-link" href={reportHref(deptId, r.id)}>{r.clientName}</Link> {r.simulated && <SimulatedMark of="metrics" />}</td>
                <td>{periodWords(r.period, r.kind, fiscalYearStartMonth)}{tab === "other" ? ` (${r.kind === "adhoc" ? "ad hoc" : r.kind})` : ""}{r.live ? " · live" : ""}</td>
                <td><span className={`scp-reports__state scp-reports__state--${r.status}`}>{rowStateLine(r)}</span></td>
                <td>{isShortKind(r.kind) ? (r.summaryPresent ? "Written" : "Not written") : r.kind === "campaign" || r.kind === "adhoc" ? "Not needed" : r.notesComplete ? "Complete" : "Incomplete"}</td>
                <td>{r.due && r.status !== "delivered" ? dayWords(r.due) : ""}</td>
                <td>{r.deliveredAt ? `Sent ${formatDate(r.deliveredAt)}` : r.approvedAt ? `Approved ${formatDate(r.approvedAt)}` : r.createdAt ? `Drafted ${formatDate(r.createdAt)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
