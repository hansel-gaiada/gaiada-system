"use server";
// MI-05 — server actions backing the staff console's Requests tab. Gated on `pm.manage` (the same
// manager-tier bundle the Cerbos `webdev_change_request` policy grants `triage` to — company_admin /
// manager / group_executive / platform_admin, per §4.2 of the design; module_manager is the one Cerbos
// tier this UI mirror can't express yet, since no `webdev_staff`/`webdev_manager` derived role is
// modeled in rbac.ts — the BACKEND remains the real authority regardless of what this gate renders).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { can } from "@/lib/rbac";
import { getChangeRequest } from "@/lib/webdevChangeRequests-data";
import type { ChangeRequestDetail, CrKind, CrRoute, ExistingTriageArtifact } from "@/lib/webdevChangeRequests";

type TriageResult =
  | { ok: true; status: string; route: CrRoute | null; pipelineRunId?: string; pmTaskId?: string }
  | { ok: false; error: string; existing?: ExistingTriageArtifact; notImplemented?: boolean };

async function requireSession(): Promise<{ userId: string; me: Awaited<ReturnType<typeof getMe>> } | { ok: false; error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Not signed in." };
  const me = await getMe(userId);
  return { userId, me };
}

function refresh(deptId: string) {
  revalidatePath(`/departments/${deptId}/requests`);
}

/** Detail fetch for the drawer — invoked from the client component on row-select, so the list read
 *  (which lacks `body`/linked-artifact status) doesn't have to be pre-fetched for every row up front. */
export async function getChangeRequestDetailAction(
  tenant: string,
  id: string,
): Promise<{ ok: true; row: ChangeRequestDetail } | { ok: false; error: string }> {
  const ctx = await requireSession();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const row = await getChangeRequest(ctx.userId, tenant, id);
  if (!row) return { ok: false, error: "Change request not found (or you don't have access)." };
  return { ok: true, row };
}

/** The whole disposition — decline or convert — mirroring the controller's single `triage` action.
 *
 *  409 ("already triaged") is NOT an error path here: the caller gets `existing` back so the panel
 *  can show/link the artifact a race loser (or a double-click) discovers already exists, per the
 *  ticket's instruction to treat it as "someone already triaged this", not a failure toast.
 *  501 (route: control_plane) surfaces its own explicit message rather than a generic one — the CR
 *  stays re-triageable, so `notImplemented` just tells the panel not to treat this as a hard error. */
export async function triageChangeRequestAction(
  tenant: string,
  deptId: string,
  id: string,
  payload: { action: "decline" | "convert"; route?: CrRoute; reason?: string; kindOverride?: CrKind },
): Promise<TriageResult> {
  const ctx = await requireSession();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!can(ctx.me, "pm.manage", tenant)) return { ok: false, error: "You don't have permission to triage change requests." };
  try {
    const r = await platformFetch<{ id: string; status: string; route: CrRoute | null; pipelineRunId?: string; pmTaskId?: string }>(
      `/api/${tenant}/webdev/change-requests/${id}/triage`,
      ctx.userId,
      { method: "POST", body: JSON.stringify(payload) },
    );
    refresh(deptId);
    return { ok: true, status: r.status, route: r.route, pipelineRunId: r.pipelineRunId, pmTaskId: r.pmTaskId };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 409 && e.existing) {
        refresh(deptId);
        return { ok: false, error: e.message, existing: e.existing as unknown as ExistingTriageArtifact };
      }
      if (e.status === 501) {
        return { ok: false, error: e.message, notImplemented: true };
      }
      return { ok: false, error: e.message };
    }
    throw e;
  }
}
