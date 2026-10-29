import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { todayIsoInDisplayZone } from "@/lib/format";
import { monthTitle, parseMonth, shiftMonth } from "@/lib/deptCalendar";
import { getTeamDashboard } from "@/lib/socialTeam-data";
import { dashboardHref } from "@/lib/socialTeam";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { TeamDashboard } from "@/components/social/TeamDashboard";
import { TeamDashboardKpis } from "@/components/social/TeamDashboardKpis";
import { TeamDashboardTiles } from "@/components/social/TeamDashboardTiles";
import "@/components/social/cycles.css";
import "@/components/social/teamDashboard.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ month?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

// SCP-5d (BFF §63.19, §63.17; plan §6.2; SCP-Q24): the Social Media Team dashboard, the four approvers' (the registry row `dashboard` gates on `canLeadSocial`,
// PERMISSION §53.4). The order is fixed: the department's KPI strip, the slot for SCP-3f's pipeline tiles, then Needs attention, Clients this cycle, Workload per
// person, Where work waits longest, Step averages and Estimates not set.
//
// The read IS the authorisation (`GET team`: `social_engagement` · `plan`), so anyone else who opens this address gets the page's refusal (the house "no access"
// state, the same as Settings for a person with no read tier), and a failed read says it cannot tell, never an empty dashboard. The gate hides the menu row and
// grants nothing. The month is `?month=YYYY-MM` (this month by default).
export default async function SocialTeamDashboardPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  // The Team dashboard belongs to the Social Media workspace only.
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const sp = await searchParams;
  const today = todayIsoInDisplayZone();
  const month = parseMonth(first(sp.month), today.slice(0, 7));
  const team = await getTeamDashboard(userId, tenant, month);

  if (team.kind === "forbidden") {
    return <ReadRefusal subject="the Team dashboard" kind="forbidden" detail="It is for the Social Media head, the GM, the owner and the superadmin." />;
  }
  if (team.kind === "unavailable") return <ReadRefusal subject="The Team dashboard" kind="unavailable" reason={team.reason} />;

  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  return (
    <Card title="Dashboard">
      <nav className="scp-monthnav" aria-label="Month">
        <Link href={dashboardHref(deptId, prev, today)} className="scp-monthnav__btn" aria-label={`Previous month, ${monthTitle(prev)}`}>←</Link>
        <h4 className="scp-monthnav__title">{monthTitle(month)}</h4>
        <Link href={dashboardHref(deptId, next, today)} className="scp-monthnav__btn" aria-label={`Next month, ${monthTitle(next)}`}>→</Link>
        {month !== today.slice(0, 7) && <Link href={dashboardHref(deptId, today.slice(0, 7), today)} className="scp-monthnav__btn">This month</Link>}
      </nav>
      <div className="std-top">
        <TeamDashboardKpis userId={userId} tenantId={tenant} deptId={deptId} month={month} />
        <TeamDashboardTiles />
      </div>
      <TeamDashboard data={team.data} deptId={deptId} />
    </Card>
  );
}
