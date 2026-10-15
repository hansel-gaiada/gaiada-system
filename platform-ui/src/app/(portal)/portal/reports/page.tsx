import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { listPortalReports } from "@/lib/portal-data";
import { portalDate, portalPeriod, reportDownloadLabel } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { PortalReportDownload } from "@/components/portal/PortalReportDownload";

// PV7-04b — Reports: the performance reports we have published to this client (social and search), newest first.
// Second tab of the Overview area (`PORTAL_AREAS`); the report-published notice and the deliverables' "Open report"
// link both land here (BFF §55).
//
// The list is the BACKEND's (`GET portal/reports`, §55.4): published reports in this contact's reach only, so a
// project-scoped contact sees the reports of their project and a report with no project reaches client-wide contacts
// only. Nothing is filtered or re-derived here. "New" is the server's `readAt === null` for this user.
//
// A report's download goes through the portal's own file route (the one Documents uses) and marks the report read from
// the click; the link is labelled from the FILE's content type (search reports are Markdown, social ones PDF), never
// assumed to be a PDF. A failed read says it could not load and is never shown as "no reports".
export default async function PortalReportsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const reports = await listPortalReports(userId, tenant);

  return (
    <>
      <PortalPageHead
        eyebrow="Your account"
        title="Reports"
        lead="The performance reports we have published for you, newest first."
        actions={<PortalLive topics={["reports"]} />}
      />
      {reports === null ? (
        <EmptyNote>Reports could not be loaded just now. Please try again in a moment.</EmptyNote>
      ) : reports.length === 0 ? (
        <EmptyNote>No reports have been published yet.</EmptyNote>
      ) : (
        <Card title={`${reports.length} ${reports.length === 1 ? "report" : "reports"}`}>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 16 }}>
            {reports.map((r) => {
              const isNew = r.readAt === null;
              return (
                <li key={r.id} id={r.id} style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap", scrollMarginTop: 96 }}>
                  <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                    <div style={{ font: "500 14px/1.4 var(--font-body)", color: "var(--ink-strong)" }}>
                      {r.title}
                      {isNew && <> <span className="cp-conv-unread">New</span></>}
                    </div>
                    <div style={{ font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
                      {portalPeriod(r.periodStart, r.periodEnd)} · {r.projectName ?? "Whole account"} · Published {portalDate(r.publishedAt)}
                    </div>
                  </div>
                  <PortalReportDownload
                    tenant={tenant}
                    reportId={r.id}
                    fileId={r.file.id}
                    label={reportDownloadLabel(r.file.contentType)}
                    title={r.title}
                    isNew={isNew}
                  />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
