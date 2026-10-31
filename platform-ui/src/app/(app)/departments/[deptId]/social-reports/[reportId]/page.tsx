import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartmentNode } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { getReportRules, getSocialReport, getSocialReports } from "@/lib/socialReports-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { getIdeas } from "@/lib/socialIdeas-data";
import { getCycleTable } from "@/lib/socialCycles-data";
import { todayIsoInDisplayZone } from "@/lib/format";
import { cycleChoiceOf, planMonths, type CycleChoice } from "@/lib/socialIdeas";
import { reportNav } from "@/lib/socialReports";
import { isShortKind } from "@/lib/socialReportKinds";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { SocialReportView } from "@/components/social/SocialReportView";
import { ReportIdeas } from "@/components/social/ReportIdeas";
import "@/components/social/cycles.css";
import "@/components/social/reports.css";

type Params = Promise<{ deptId: string; reportId: string }>;

// SCP-5a (BFF §63.18, §63.17), SCP-5 W5-A4 (§63.24.7, §63.25.4): one report of any kind, in the same area as the list. The read is the server's (`GET reports/:id`: the numbers' document, the notes, the plan or a
// short kind's summary and next-period line, `simulated`, and the `canApprove` and `canDeliver` that decide the buttons); the page draws it and `SocialReportView` carries the form. A daily or weekly report
// also gets its period's navigation (the client's other reports of that kind); the MONTHLY report gets "Ideas for next month" (the client's ideas, and the cycles an idea may be planned into). The company's
// rules (`GET rules`) give the fiscal year and the ideas' metric rule. A report that does not exist is a 404; a refused read is "no access" and a failed one "cannot tell". Once sent, the page is read-only and
// points at the client's Reports tab, where the published copy is listed.
export default async function SocialReportPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId, reportId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartmentNode(userId, tenant, deptId);
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

  // The company's rules: the fiscal year (a quarter's, half's or year's months), the summary's limit and the ideas' metric rule. A failed read uses the seed's defaults and the server decides every write.
  const rulesRead = await getReportRules(userId, tenant);
  const rules = rulesRead.kind === "ok" ? rulesRead.data : null;
  const fy = rules?.fiscalYearStartMonth ?? 1;
  const today = todayIsoInDisplayZone();

  // A short kind: the neighbouring periods, from the client's reports of the kind (a failed read leaves the buttons that draft them, never claims a report is missing).
  let nav: ReturnType<typeof reportNav> | undefined;
  if (isShortKind(report.kind)) {
    const same = await getSocialReports(userId, tenant, { engagementId: report.engagementId, kind: report.kind });
    nav = reportNav(report, same.kind === "ok" ? same.data : [], today, fy);
  }

  // The monthly: its client's ideas, and the cycles one may be added to (the next open cycle and those after it; the server never guesses, so each is the client's own row of that month's table).
  let ideasBlock: React.ReactNode = null;
  if (report.kind === "monthly" && report.period) {
    const months = planMonths(report.period, today);
    const [ideas, tables] = await Promise.all([getIdeas(userId, tenant, report.engagementId), Promise.all(months.map((m) => getCycleTable(userId, tenant, m)))]);
    const cycles: CycleChoice[] = tables.flatMap((t, i) => {
      const c = t.kind === "ok" ? cycleChoiceOf(t.data.rows, report.engagementId, months[i]) : null;
      return c ? [c] : [];
    });
    ideasBlock = (
      <ReportIdeas
        deptId={deptId} engagementId={report.engagementId} reportId={report.id} metricRequired={rules?.ideas.metricRequired ?? true} cycles={cycles}
        ideas={ideas.kind === "ok" ? ideas.data : { unavailable: ideas.kind === "forbidden" ? "Reading them needs a Social Media read tier." : ideas.reason }}
      />
    );
  }

  return (
    <Card>
      <SocialReportView
        deptId={deptId} report={report} clientName={clientName} clientReportsHref={clientReportsHref} nav={nav} fiscalYearStartMonth={fy}
        summaryMax={rules?.kinds[report.kind as "daily"]?.narrativeMax ?? undefined}
      >
        {ideasBlock}
      </SocialReportView>
    </Card>
  );
}
