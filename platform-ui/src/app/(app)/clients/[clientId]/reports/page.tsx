import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readResult } from "@/lib/readResult";
import { listClientReports } from "@/lib/clientReports-data";
import { REPORT_SOURCE_LABEL, REPORT_STATUS_LABEL, staffReportDownloadLabel, type StaffClientReport } from "@/lib/clientReports";
import { formatDate } from "@/lib/format";
import { Card, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";
import { ClientReportActions } from "@/components/clients/ClientReportActions";
import { FileLink } from "@/components/clients/billing/FileLink";
import "@/components/clients/billing/billing.css";

// PV7-04b — the hub's REPORTS tab (`/clients/[id]/reports`; BFF §55.3), under the Overview area.
//
// Every report for this client in every status, newest first: delivered social and search reports arrive here already
// Published (delivery publishes them), and drafts (an account summary, an agent's draft) wait for a person to Publish
// them. A published report says whether the client sees it ("Client sees this", the backend's `clientVisible`, never
// guessed); a withdrawn one keeps its reason, which is for staff only. Download goes through the staff file route.
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
      ) : res.data.length === 0 ? (
        <EmptyNote>No report has been made for this client yet. Delivered social and search reports appear here, published to the client.</EmptyNote>
      ) : (
        <Card>
          <ul style={{ margin: 0, padding: 0 }}>
            {res.data.map((r) => <ReportRow key={r.id} report={r} clientId={clientId} />)}
          </ul>
        </Card>
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
        {r.file ? <>{" · "}<FileLink fileId={r.file.id} label={staffReportDownloadLabel(r.file.contentType)} /></> : " · No file yet"}
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
      <ClientReportActions report={r} clientId={clientId} />
    </li>
  );
}
