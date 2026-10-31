import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartmentNode } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { todayIsoInDisplayZone } from "@/lib/format";
import { getReportRules, getReportRuns, getSocialReports } from "@/lib/socialReports-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { parseReportFilters, type SocialReportRow } from "@/lib/socialReports";
import { chosenTab, isPeriodicKind, offeredTabs, periodChoices } from "@/lib/socialReportKinds";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { SocialReportList } from "@/components/social/SocialReportList";
import { GenerateReports } from "@/components/social/GenerateReports";
import { ReportKindBar } from "@/components/social/ReportKindBar";
import "@/components/social/cycles.css";
import "@/components/social/reports.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ status?: string | string[]; period?: string | string[]; kind?: string | string[]; run?: string | string[] }>;

// SCP-5a (BFF §63.18, §63.17), SCP-5 W5-A4 (§63.24.7): the Social reports list: each client's reports of the chosen KIND (Daily, Weekly, Monthly, Quarterly, Half-year, Yearly, Other, showing only the kinds the
// company has on, from `GET rules`) by period, in the design's four states, with whether the notes (or the summary) are done and the SIMULATED mark. It is the "Social reports" tab of the shared Reports row
// (never `{D}/reports`, which is SEO's). Filters are the kind, the status and the period, in the query. "Generate with AI" drafts one client's report or, as a background run, every client's: its progress
// panel follows `?run=<runId>` too, so a link to a run (a scheduled one included) opens its results. The whole team reads the list (`social_report` · `read`); a refused read is "no access" and a failed one is
// "cannot tell", never an empty list. The page belongs to the Social Media workspace only.
export default async function SocialReportsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartmentNode(userId, tenant, deptId);
  if (!dept) notFound();
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const q = await searchParams;
  const filters = parseReportFilters(q);
  const runParam = (Array.isArray(q.run) ? q.run[0] : q.run) ?? null;
  // The company's rules decide which kinds are offered; read first, as the kind decides what the list asks for. A failed read offers the monthly report and Other only, and says so.
  const rulesRead = await getReportRules(userId, tenant);
  const rules = rulesRead.kind === "ok" ? rulesRead.data : null;
  const offered = offeredTabs(rules);
  const tab = chosenTab(filters.kind, offered);
  const fy = rules?.fiscalYearStartMonth ?? 1;
  const [listed, mine, runs] = await Promise.all([
    getSocialReports(userId, tenant, { status: filters.status, period: filters.period, kind: isPeriodicKind(tab) ? tab : null }),
    getAllocation(userId, tenant),
    getReportRuns(userId, tenant),
  ]);
  const reports = listed.kind === "ok" ? { kind: "ok" as const, data: (tab === "other" ? listed.data.filter((r: SocialReportRow) => r.kind === "campaign" || r.kind === "adhoc") : listed.data) } : listed;
  if (reports.kind === "forbidden") return <ReadRefusal subject="Social reports" kind="forbidden" detail="Reading them needs a Social Media read tier (the social_staff role, or a manager)." />;
  if (reports.kind === "unavailable") return <ReadRefusal subject="Social reports" kind="unavailable" reason={reports.reason} />;

  const today = todayIsoInDisplayZone();
  // The one-client picker: the client's own officer drafts for their clients, the four for every open client (the server's allocation flag `canPlan` says who the four are).
  const rows = mine.kind === "ok" ? mine.data.filter((r) => r.status !== "closed") : [];
  const isApprover = mine.kind === "ok" && mine.data.some((r) => r.canPlan);
  const clients = rows.filter((r) => isApprover || r.officer?.id === userId).map((r) => ({ engagementId: r.engagementId, clientName: r.clientName }));
  const choices = isPeriodicKind(tab) ? periodChoices(tab, today, { fiscalYearStartMonth: fy, allowCurrent: true, count: 16 }) : [];
  const generateKind = isPeriodicKind(tab) ? tab : runParam ? "monthly" : null;
  return (
    <Card title="Social reports">
      <p className="scp-lede">
        Each client&apos;s reports, by kind. The officer writes each from the period&apos;s numbers, or generates them with AI, and submits it; the Social Media head, the GM, the owner or the superadmin checks it and sends it to the client.
      </p>
      {rulesRead.kind !== "ok" && <p className="scp-note" role="status">The company&apos;s report kinds could not be read, so only the monthly report and Other are shown. {rulesRead.kind === "unavailable" ? rulesRead.reason : ""}</p>}
      {mine.kind === "unavailable" && <p className="scp-note" role="status">Your clients could not be read, so the Generate with AI bar is hidden. {mine.reason}</p>}
      <ReportKindBar deptId={deptId} offered={offered} tab={tab} status={filters.status} period={filters.period} choices={choices} />
      {generateKind && (mine.kind === "ok" || runParam) && (
        <GenerateReports
          deptId={deptId} kind={generateKind} clients={clients} isApprover={isApprover} today={today} rule={rules?.kinds[generateKind] ?? null} fiscalYearStartMonth={fy}
          runs={runs.kind === "ok" ? runs.data : null} followRunId={runParam}
        />
      )}
      <SocialReportList deptId={deptId} rows={reports.data} filters={filters} tab={tab} fiscalYearStartMonth={fy} />
    </Card>
  );
}
