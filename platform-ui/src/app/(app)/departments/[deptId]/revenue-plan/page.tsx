import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { can, isElevated } from "@/lib/rbac";
import { readRevenuePlanYear } from "@/lib/revenuePlan-data";
import { parseYear } from "@/lib/revenuePlan";
import { resolveGmTab, GmTabRefusal } from "@/components/departments/gm/gmTab";
import { RevenuePlanView } from "@/components/revenueplan/RevenuePlanView";

type Params = Promise<{ deptId: string }>;
type Search = Promise<{ year?: string | string[] }>;

const TITLE = "Revenue plan";

// GM console → Command → Revenue plan (DW-7j-5, BFF §40.6.4): the GM's monthly revenue plan, set beside the revenue the books show,
// and the plan the "Revenue against plan" KPI reads.
//
// ── WHO SEES AND WHO EDITS ───────────────────────────────────────────────────────────────────────
// The console gate (`resolveGmTab`) decides who reaches the page; the SERVER decides what each read and write returns
// (`dept_kpi_target` read for the plan and `finance_statement` read for the P&L, each refused in words on the page). Editing is offered
// to `company.manage` or an elevated user, as a mirror: the approver is `company_admin` (owner mirrors it), so a manager sees the
// buttons and is refused by the server with a sentence, never a silent no-op. Everyone else who may read the plan sees it read-only.
export default async function GmRevenuePlanPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId } = await params;
  const ctx = await resolveGmTab(deptId);
  if (!ctx.ok) return <GmTabRefusal reason={ctx.reason} title={TITLE} />;

  // Re-resolved here (as the Decisions tab does): the guard's contract is "may this principal see this console".
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);

  const today = new Date().toISOString().slice(0, 10);
  const year = parseYear((await searchParams).year, Number(today.slice(0, 4)));
  const { plan, actuals } = await readRevenuePlanYear(ctx.userId, ctx.tenantId, year, today);
  const canEdit = can(me, "company.manage", ctx.tenantId) || isElevated(me);

  return <RevenuePlanView year={year} deptId={deptId} plan={plan} actuals={actuals} canEdit={canEdit} />;
}
