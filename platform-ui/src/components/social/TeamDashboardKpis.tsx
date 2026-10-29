// SCP-5d (SCP-Q24): the KPI strip at the top of the Team dashboard. It is the Overview's "Department condition" banner (`ConditionBlock`, DW-3k) fed by the same
// honest reader (`getDeptKpis`, BFF §40) and the same rules (`conditionView`), so the dashboard and the Overview word a department's condition alike. The viewer is
// one of the four approvers, so the banner and its tiles are always the head's view (the GM, the owner and the superadmin are not heads of the unit, but this page is
// theirs). A refused read says so in one quiet line: nothing is drawn as if the department were on track. A failed read says "Unavailable".
import { getDeptKpis } from "@/lib/deptKpis";
import { conditionHref, conditionView } from "@/lib/overviewCondition";
import { ConditionBlock } from "@/components/overview/widgets/ConditionBlock";

export async function TeamDashboardKpis({ userId, tenantId, deptId, month }: { userId: string; tenantId: string; deptId: string; month: string }) {
  const result = await getDeptKpis(userId, tenantId, { unit: deptId, periodKind: "month", start: `${month}-01` });
  const view = conditionView("head", result, conditionHref(deptId, "month", `${month}-01`));
  if (view.kind === "none") {
    return <p className="std-note" role="status" data-section="kpis">The department&rsquo;s KPIs are not shown to you.</p>;
  }
  return <div data-section="kpis"><ConditionBlock view={view} /></div>;
}
