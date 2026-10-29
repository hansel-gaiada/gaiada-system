import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { getSocialReport } from "@/lib/socialReports-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { SocialReportView } from "@/components/social/SocialReportView";
import "@/components/social/cycles.css";
import "@/components/social/reports.css";

type Params = Promise<{ deptId: string; reportId: string }>;

// SCP-5a (BFF §63.18, §63.17): one monthly report, in the same area as the list. The read is the server's (`GET reports/:id`: the numbers' document, the notes, the plan, `simulated`, and the
// `canApprove` and `canDeliver` that decide the buttons); the page draws it and `SocialReportView` carries the form. A report that does not exist is a 404; a refused read is "no access" and a
// failed one "cannot tell". Once sent, the page is read-only and points at the client's Reports tab, where the published copy is listed.
export default async function SocialReportPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId, reportId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const read = await getSocialReport(userId, tenant, reportId);
  if (read.kind === "forbidden") return <ReadRefusal subject="This report" kind="forbidden" detail="Reading it needs a Social Media read tier (the social_staff role, or a manager)." />;
  if (read.kind === "unavailable") return <ReadRefusal subject="This report" kind="unavailable" reason={read.reason} />;
  const report = read.data;
  if (!report) notFound();

  // The client's name is the document's scope; the client's id (for the link to its published reports) is the allocation row of the engagement. A failed read leaves the text without the link.
  const clientName = report.document.header.scopeName;
  let clientReportsHref: string | null = null;
  if (report.status === "delivered") {
    const alloc = await getAllocation(userId, tenant);
    const clientId = alloc.kind === "ok" ? alloc.data.find((r) => r.engagementId === report.engagementId)?.clientId : null;
    if (clientId) clientReportsHref = `/clients/${encodeURIComponent(clientId)}/reports`;
  }

  return (
    <Card>
      <SocialReportView deptId={deptId} report={report} clientName={clientName} clientReportsHref={clientReportsHref} />
    </Card>
  );
}
