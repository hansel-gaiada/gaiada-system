"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { can } from "@/lib/rbac";
import { setWorkflowActive, replayBridgeStream } from "@/lib/admin";
import { updateApprovalRetryCount } from "@/lib/entities";

export interface AutomationActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

// Activate/deactivate one workflow. The backend gates this to platform-admin/owner (narrower than
// the read-only canvas) because deactivating silently stops business automation.
export async function toggleWorkflow(
  workflowId: string,
  activate: boolean,
  _prev: AutomationActionState | null,
  _formData: FormData,
): Promise<AutomationActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const me = await getMe(userId);
  const res = await setWorkflowActive(userId, me, workflowId, activate);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/systems/automation");
  // Report n8n's own resulting state rather than assuming the requested one took effect.
  return { ok: true, message: res.active ? "Workflow activated." : "Workflow deactivated." };
}

// Re-deliver a stream's dead-lettered events so the workflows they trigger run again.
export async function replayDeadLetters(
  entityType: string,
  _prev: AutomationActionState | null,
  _formData: FormData,
): Promise<AutomationActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const me = await getMe(userId);
  const res = await replayBridgeStream(userId, me, entityType);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/systems/automation");
  const replayed = res.replayed ?? 0;
  return {
    ok: true,
    message:
      replayed === 0
        ? "Nothing to replay — this stream has no dead-lettered events."
        : `Requeued ${replayed} event${replayed === 1 ? "" : "s"}${res.remaining ? ` (${res.remaining} still parked)` : ""}.`,
  };
}

// D14-08 — the "Approval retry" card's write, riding D14-07's namespaced settings path
// (`companies.settings.automation.approvalRetry.autoRetryCount`, 0..3, 0 = manual only). Gated on
// `company.manage` (the same capability the page uses to decide whether to render the card at all)
// so a direct call from a stale client can't bypass what the render already refused to offer —
// mirrors `companies/actions.ts`'s own `can(me, "company.manage", companyId)` gate.
export async function setApprovalRetryCount(
  tenantId: string,
  _prev: AutomationActionState | null,
  formData: FormData,
): Promise<AutomationActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const me = await getMe(userId);
  if (!can(me, "company.manage", tenantId)) {
    return { ok: false, error: "You don't have permission to change this setting." };
  }
  const count = Number(formData.get("autoRetryCount"));
  if (!Number.isInteger(count) || count < 0 || count > 3) {
    return { ok: false, error: "autoRetryCount must be an integer 0..3." };
  }
  try {
    await updateApprovalRetryCount(userId, tenantId, count);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath("/systems/automation");
  return { ok: true, message: count === 0 ? "Auto-retry off — manual retry only." : `Auto-retry set to ${count} attempt${count === 1 ? "" : "s"}.` };
}
