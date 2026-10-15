import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readResult } from "@/lib/readResult";
import { listClientReports } from "@/lib/clientReports-data";
import {
  REPORT_SOURCE_LABEL, REPORT_STATUS_LABEL, lastMonth, staffReportDownloadLabel, summaryPeriodLabel, thisMonth, type StaffClientReport,
} from "@/lib/clientReports";
import { formatDate } from "@/lib/format";
import { Card, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";
import { ClientReportActions } from "@/components/clients/ClientReportActions";
import { AccountSummaryDraftForm } from "@/components/clients/AccountSummaryDraftForm";
import { AccountSummaryEditor } from "@/components/clients/AccountSummaryEditor";
import { AccountSummaryPreview } from "@/components/clients/AccountSummaryPreview";
import { FileLink } from "@/components/clients/billing/FileLink";
import "@/components/clients/billing/billing.css";

// PV7-04b — the hub's REPORTS tab (`/clients/[id]/reports`; BFF §55.3), under the Overview area.
//
// Every report for this client in every status, newest first: delivered social and search reports arrive here already
// Published (delivery publishes them), and drafts (an account summary, an agent's draft) wait for a person to Publish
// them. A published report says whether the client sees it ("Client sees this", the backend's `clientVisible`, never
// guessed); a withdrawn one keeps its reason, which is for staff only. Download goes through the staff file route.
//
// PV7-07: the monthly ACCOUNT SUMMARY. "Draft account summary" (a month picker, last month by default) freezes the client's figures
// for that month and drafts a narrative; the draft's row opens to the narrative editor and the frozen figures, and Publish renders
// the PDF (the backend does that) and puts it in front of the client's main contacts. A published or withdrawn summary shows its
// narrative and figures read-only: they never change once it leaves draft.
//
// The read refuses explicitly: a denied or failed read is a `<ReadRefusal>`, never "no reports". The hub layout renders the
// client's name as the page's one `<h1>`, so this page starts at `<h2>`.
export default async function ClientReportsPage({ params }: { params: Promise<{ clientId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();

  const res = await readResult(listClientReports(userId, tenant, clientId));

  return (
    <section aria-labelledby="cr-title">
      <h2 id="cr-title" className="bl-section__title">Reports</h2>
      <p className="bl-section__lede">
        Performance reports for this client. A delivered social or search report is published to the client at once; a
        draft stays internal until you publish it. Withdraw takes a published report back out of their portal.
      </p>
      {res.kind !== "ok" ? (
        <ReadRefusal subject="this client's reports" kind={res.kind} reason={res.kind === "unavailable" ? res.reason : undefined} />
      ) : (
        <>
          <AccountSummaryDraftForm clientId={clientId} defaultMonth={lastMonth()} maxMonth={thisMonth()} />
          {res.data.length === 0 ? (
            <EmptyNote>No report has been made for this client yet. Delivered social and search reports appear here, published to the client.</EmptyNote>
          ) : (
            <Card>
              <ul style={{ margin: 0, padding: 0 }}>
                {res.data.map((r) => <ReportRow key={r.id} report={r} clientId={clientId} />)}
              </ul>
            </Card>
          )}
        </>
      )}
    </section>
  );
}

function ReportRow({ report: r, clientId }: { report: StaffClientReport; clientId: string }) {
  return (
    <li className="bl-payment" style={{ listStyle: "none" }} id={r.id}>
      <div className="bl-payment__head">
        <p className="bl-payment__amount">{r.title}</p>
        <span className="bl-payment__meta">
          <StatusBadge label={REPORT_STATUS_LABEL[r.status]} />
          {/* Only a published report is in front of the client; the marker is the backend's `clientVisible`. */}
          {r.status === "published" && <ClientVisibilityMarker clientVisible={r.clientVisible} />}
        </span>
      </div>
      <p className="bl-payment__meta">
        {REPORT_SOURCE_LABEL[r.source]} · {formatDate(r.periodStart)} to {formatDate(r.periodEnd)} · {r.projectName ?? "Whole account"}
        {r.file
          ? <>{" · "}<FileLink fileId={r.file.id} label={staffReportDownloadLabel(r.file.contentType)} /></>
          : r.source === "account_summary" ? " · The PDF is made when you publish" : " · No file yet"}
      </p>
      <p className="bl-payment__meta">
        {r.status === "draft" && <>Draft since {formatDate(r.createdAt)}. The client cannot see it.</>}
        {r.status === "published" && (
          <>
            Published {formatDate(r.publishedAt)}{r.publishedByName ? ` by ${r.publishedByName}` : ""}
            {typeof r.readCount === "number" && ` · opened by ${r.readCount} ${r.readCount === 1 ? "contact" : "contacts"}`}
          </>
        )}
        {r.status === "withdrawn" && (
          <>
            Published {formatDate(r.publishedAt)}{r.publishedByName ? ` by ${r.publishedByName}` : ""}. Withdrawn {formatDate(r.withdrawnAt)}
            {r.withdrawnByName ? ` by ${r.withdrawnByName}` : ""}.
          </>
        )}
      </p>
      {r.status === "withdrawn" && r.withdrawnReason && <p className="bl-payment__meta">Reason (staff only): {r.withdrawnReason}</p>}
      {r.source === "account_summary" && r.snapshot && typeof r.narrativeMd === "string" && (
        <details className="as-details" open={r.status === "draft"}>
          <summary>{summaryPeriodLabel(r.period ?? r.snapshot.period)}: narrative and figures</summary>
          {r.status === "draft" ? (
            <AccountSummaryEditor reportId={r.id} clientId={clientId} narrativeMd={r.narrativeMd} narrativeSource={r.narrativeSource ?? "deterministic"} />
          ) : (
            <div className="as-narrative">
              <p className="as-narrative__text">{r.narrativeMd}</p>
            </div>
          )}
          <AccountSummaryPreview snapshot={r.snapshot} />
        </details>
      )}
      <ClientReportActions report={r} clientId={clientId} />
    </li>
  );
}
