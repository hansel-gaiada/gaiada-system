import { notFound, redirect } from "next/navigation";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listChangeRequests } from "@/lib/webdevChangeRequests-data";
import { ChangeRequestsPanel, type ChangeRequestOrigins } from "@/components/departments/ChangeRequestsPanel";
import { Card } from "@/components/ui";
import { IncomingRequestsTable } from "@/components/requests/IncomingRequestsTable";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { readRequests } from "@/lib/requests-data";
import { originsByChangeRequest, requestsPageView } from "@/lib/requests";
import "@/components/requests/requests.css";
import { listSignedContractsAction } from "@/lib/conversationActions";
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

  // DW-5d / DW-5e: the page follows the department's workspace (the shell's own `workspaceFor` name match).
  const dept = await getDepartment(userId, tenant, deptId);
  const view = dept ? requestsPageView(workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key) : "other";

  if (view === "creatives") {
    // DW-5d, Incoming: the asset requests waiting on this department, open, oldest first (the server's order).
    const incoming = await readRequests(userId, tenant, { box: "incoming", unitId: deptId }, "open", { kind: "assets" });
    if (incoming.kind === "forbidden") return <ReadRefusal subject="this department's incoming requests" kind="forbidden" />;
    if (incoming.kind === "unavailable") return <ReadRefusal subject="This department's incoming requests" kind="unavailable" reason={incoming.reason} />;
    return (
      <Card title="Incoming requests" hint="A request is a task on this department's board. Open it to see the brief, and deliver it from its page.">
        {incoming.data.length === 0
          ? <p className="req-empty">No requests are waiting for this department.</p>
          : <IncomingRequestsTable rows={incoming.data} />}
      </Card>
    );
  }

  // AGN-3: the queue is this tab's subject. A denied reader used to get the teach-state ("no
  // requests yet"), which is the one reading of an empty queue that was never true for them. An
  // ALLOWED-but-empty queue still shows the teach-state, which is MI-05's actual acceptance criterion.
  const rowsResult = await listChangeRequests(userId, tenant);
  if (rowsResult.kind === "forbidden") {
    return <ReadRefusal subject="this department's change requests" kind="forbidden" />;
  }
  if (rowsResult.kind === "unavailable") {
    return <ReadRefusal subject="The change-request queue" kind="unavailable" reason={rowsResult.reason} />;
  }
  const rows = rowsResult.data;
  const canTriage = can(me, "pm.manage", tenant);

  // DW-5e: a change request that came from a request between departments says where from. A UI-side join on the work item's
  // id; if that read fails the column says so, and the queue still renders.
  let origins: ChangeRequestOrigins | undefined;
  if (view === "web-dev") {
    const eng = await readRequests(userId, tenant, { box: "incoming", unitId: deptId }, "all", { kind: "engineering" });
    origins = eng.kind === "ok" ? { state: "ok", byChangeRequest: originsByChangeRequest(eng.data) } : { state: "unavailable" };
  }

  const actions = {
    getDetail: getChangeRequestDetailAction.bind(null, tenant),
    triage: triageChangeRequestAction.bind(null, tenant, deptId),
    listSignedContracts: listSignedContractsAction,
  };

  return <ChangeRequestsPanel rows={rows} canTriage={canTriage} actions={actions} origins={origins} />;
}
