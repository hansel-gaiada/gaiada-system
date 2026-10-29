import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { todayIsoInDisplayZone } from "@/lib/format";
import { getSocialReports } from "@/lib/socialReports-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { parseReportFilters } from "@/lib/socialReports";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { SocialReportList } from "@/components/social/SocialReportList";
import { DraftReportForm } from "@/components/social/DraftReportForm";
import "@/components/social/cycles.css";
import "@/components/social/reports.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ status?: string | string[]; period?: string | string[] }>;

// SCP-5a (BFF §63.18, §63.17): the Social reports list: each client's monthly reports by month, in the design's four states (Draft, HoD check, Ready, Sent), with whether the notes are complete and
// the SIMULATED mark. It is the "Social reports" tab of the shared Reports row (never `{D}/reports`, which is SEO's). Filters are the status and the month, in the query. An officer also gets
// "Draft this month's report" for the clients they work on. The whole team reads the list (`social_report` · `read`); a refused read is "no access" and a failed one is "cannot tell", never an
// empty list. The page belongs to the Social Media workspace only.
export default async function SocialReportsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const filters = parseReportFilters(await searchParams);
  const [reports, mine] = await Promise.all([
    getSocialReports(userId, tenant, filters),
    getAllocation(userId, tenant, { mine: true }),
  ]);
  if (reports.kind === "forbidden") return <ReadRefusal subject="Social reports" kind="forbidden" detail="Reading them needs a Social Media read tier (the social_staff role, or a manager)." />;
  if (reports.kind === "unavailable") return <ReadRefusal subject="Social reports" kind="unavailable" reason={reports.reason} />;

  const today = todayIsoInDisplayZone();
  const clients = mine.kind === "ok" ? mine.data.filter((r) => r.status !== "closed").map((r) => ({ engagementId: r.engagementId, clientName: r.clientName })) : [];
  return (
    <Card title="Social reports">
      <p className="scp-lede">
        Each client&apos;s monthly report. The officer writes it from the month&apos;s numbers and submits it; the Social Media head, the GM, the owner or the superadmin checks it and sends it to the client.
      </p>
      {mine.kind === "unavailable" && <p className="scp-note" role="status">Your clients could not be read, so the draft bar is hidden. {mine.reason}</p>}
      {clients.length > 0 && <DraftReportForm deptId={deptId} clients={clients} thisMonth={today.slice(0, 7)} />}
      <SocialReportList deptId={deptId} rows={reports.data} filters={filters} />
    </Card>
  );
}
