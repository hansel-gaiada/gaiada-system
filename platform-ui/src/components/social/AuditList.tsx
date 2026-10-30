// SCP-5g (BFF §63.28, §63.17): the audit list: every open client with its draft's live score, else its latest final's frozen one, else none, and every prospect, worst first as the server answers it. Pure over
// the one `GET audits` answer: the filter is a link (`?subject=`), so the list needs no script. The score is written as "62 out of 100, Fair" and the band as a word, never colour alone. An empty list is only
// ever said when the read SUCCEEDED; the page turns a refused or failed read into its own sentence before it gets here.
import Link from "next/link";
import { formatDate } from "@/lib/format";
import { AUDIT_LIST_PATH, AUDIT_SUBJECTS, auditHref, auditListHref, overallWords, rowScoreWords, statusWords, subjectWords, type AuditListItem, type AuditSubject } from "@/lib/socialAudit";
import { monthTitle } from "@/lib/socialClient";
import { SimulatedMark } from "./SimulatedMark";
import { AuditStartButton } from "./AuditStart";
import "./cycles.css";
import "./reports.css";
import "./audit.css";

export function AuditList({ deptId, rows, subject }: { deptId: string; rows: readonly AuditListItem[]; subject: AuditSubject | null }) {
  return (
    <div className="scp-audit">
      <nav className="scp-reports__filters" aria-label="Filter the audits">
        <div className="scp-reports__filter" role="group" aria-label="Who">
          <span>Show</span>
          <Link className="scp-reports__chip" href={auditListHref(deptId, null)} aria-current={subject === null}>Everyone</Link>
          {AUDIT_SUBJECTS.map((s) => (
            <Link key={s} className="scp-reports__chip" href={auditListHref(deptId, s)} aria-current={subject === s}>{s === "client" ? "Clients" : "Prospects"}</Link>
          ))}
        </div>
      </nav>
      {rows.length === 0 ? (
        <p className="scp-note" role="status">
          {subject === "prospect" ? "There is no prospect audit yet." : subject === "client" ? "There is no open client to audit yet." : "There is no client or prospect to audit yet."}
          {subject !== null && <> <Link className="scp-link" href={AUDIT_LIST_PATH(deptId)}>Show everyone</Link></>}
        </p>
      ) : (
        <div className="scp-tablewrap">
          <table className="scp-audit__list">
            <caption className="scp-field__hint" style={{ textAlign: "left", paddingBottom: 6 }}>{rows.length} {rows.length === 1 ? "row" : "rows"}, lowest score first. A client with no audit comes last.</caption>
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Who</th><th scope="col">Score</th><th scope="col">First fix</th><th scope="col">State</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.auditId ?? `client:${r.engagementId}`}>
                  <td>
                    {r.auditId ? <Link className="scp-link" href={auditHref(deptId, r.auditId)}>{r.name}</Link> : <span className="scp-table__client">{r.name}</span>}
                    {" "}{r.simulated && <SimulatedMark of="metrics" />}
                  </td>
                  <td>{subjectWords(r.subject)}</td>
                  <td>
                    {r.auditId === null ? "No audit yet" : (
                      <>
                        {r.bandLabel && <span className={`scp-audit__band scp-audit__band--${r.band ?? "none"}`}>{r.bandLabel}</span>}{" "}
                        <span>{r.overall === null ? rowScoreWords(r) : `${overallWords(r.overall, null)} · ${r.scored} of ${r.total} scored`}</span>
                      </>
                    )}
                  </td>
                  <td>{r.topFix ? `${r.topFix.label} (${r.topFix.score} out of 5)` : r.auditId ? "None yet" : ""}</td>
                  <td>
                    {r.auditId === null ? (
                      r.engagementId ? <AuditStartButton deptId={deptId} engagementId={r.engagementId} clientName={r.name} /> : null
                    ) : (
                      <>
                        {statusWords(r.status)}
                        {r.month ? `, ${monthTitle(r.month)}` : ""}
                        {r.status === "final" && r.finalizedAt ? `, ${formatDate(r.finalizedAt)}` : ""}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
