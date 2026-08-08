import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listChangeRequests } from "@/lib/webdevChangeRequests-data";
import { ChangeRequestsPanel } from "@/components/departments/ChangeRequestsPanel";
import { getChangeRequestDetailAction, triageChangeRequestAction } from "./actions";

type Params = Promise<{ deptId: string }>;

// MI-05 — Web Dev staff console "Requests" tab (Build group): the triage queue over MI-03's
// `webdev_change_requests` endpoints. Reads the FULL list (no status filter) so the queue can show
// recently-disposed rows alongside `new` ones — `sortQueue` (lib/webdevChangeRequests.ts) puts every
// `new` row first, client-side, on top of the backend's own oldest-first ordering.
//
// RBAC is mirrored, not owned: `pm.manage` gates whether the drawer's Decline/Convert controls
// render at all (manager/company_admin/group_executive/platform_admin — the same tier Cerbos's
// `webdev_change_request:triage` grants, module_manager aside, which this UI has no role for yet).
// The BACKEND POST is the real boundary regardless of what renders here.
export default async function ChangeRequestsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const rows = await listChangeRequests(userId, tenant);
  const canTriage = can(me, "pm.manage", tenant);

  const actions = {
    getDetail: getChangeRequestDetailAction.bind(null, tenant),
    triage: triageChangeRequestAction.bind(null, tenant, deptId),
  };

  return <ChangeRequestsPanel rows={rows} canTriage={canTriage} actions={actions} />;
}
