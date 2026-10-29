// SCP-5d (BFF §63.19): the compact Team dashboard block on Reports › Team, for the Social Media department only. One read (`GET team`, the same one the page uses):
// how many posts and reports need attention, how many of those are late or at risk, and a link to the full dashboard.
//
// It draws ONLY on an ok answer. A 403 (`not_a_social_approver`: the person is not one of the four) or a failed read hides it, as the contract says: the roster below it
// is the page's own and is not touched. A department that is not the Social Media one never reads it.
import Link from "next/link";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { todayIsoInDisplayZone } from "@/lib/format";
import { getTeamDashboard } from "@/lib/socialTeam-data";
import { dashboardHref, lateOrAtRiskCount, postsCount } from "@/lib/socialTeam";
import type { Me } from "@/lib/platform";
import "./teamDashboard.css";

export async function SocialTeamBlock({ me, userId, tenantId, unit }: { me: Me; userId: string; tenantId: string; unit: string }) {
  let dept: Awaited<ReturnType<typeof getDepartment>> = null;
  try { dept = await getDepartment(userId, tenantId, unit); } catch { return null; }
  if (!dept || workspaceFor(activeCompany(me, tenantId)?.vertical, dept.name).key !== "social-media") return null;
  const today = todayIsoInDisplayZone();
  const month = today.slice(0, 7);
  const team = await getTeamDashboard(userId, tenantId, month);
  if (team.kind !== "ok") return null;
  const total = team.data.needsAttention.length;
  const late = lateOrAtRiskCount(team.data);
  return (
    <section className="std-block" aria-label="Social Media Team dashboard" data-testid="social-team-block">
      <p className="std-block__text">
        <strong>{total === 0 ? "Nothing needs attention" : `${total} ${total === 1 ? "item needs" : "items need"} attention`}</strong>
        {" this month; "}
        {late === 0 ? "none is late or at risk." : `${postsCount(late).replace(/ posts?$/, "")} ${late === 1 ? "is" : "are"} late or at risk.`}
      </p>
      <Link href={dashboardHref(unit, month, today)} className="lux-btn lux-btn--ghost lux-btn--sm">Open the Team dashboard</Link>
    </section>
  );
}
