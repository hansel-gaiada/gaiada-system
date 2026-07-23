"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { platformFetch } from "@/lib/platform";

export async function decideApproval(tenantId: string, approvalId: string, decision: "approved" | "rejected"): Promise<{ ok: boolean; error?: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  try {
    await platformFetch(`/api/${tenantId}/modules/agency/approvals/${approvalId}/decide`, userId, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath("/");
  revalidatePath("/approvals");
  return { ok: true };
}

export type QueueDecideOrigin = "agency" | "automation" | "pipeline";

// The Home `NeedsMeQueue`'s decide dispatcher — one action shape over the
// queue's three approval-like origins, matching contract §9(a)'s generic
// decide façade in spirit (`POST /api/:t/approvals/:id/decide {origin,
// decision}`) WITHOUT waiting on that endpoint: it dispatches straight to
// each origin's own already-live decide handler (no new authorization model,
// `approvals.decide` is checked server-side per-origin exactly as today).
// Swap the body of this function for a single call to the façade once
// WSUX-2 ships — callers (NeedsMeQueue) never need to change.
export async function decideQueueItem(
  tenantId: string,
  origin: QueueDecideOrigin,
  originId: string,
  decision: "approved" | "rejected",
): Promise<{ ok: boolean; error?: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const path =
    origin === "agency" ? `/api/${tenantId}/modules/agency/approvals/${originId}/decide`
    : origin === "automation" ? `/api/${tenantId}/automation-approvals/${originId}/decide`
    : `/api/${tenantId}/pipeline/gates/${originId}/decide`;
  try {
    await platformFetch(path, userId, { method: "POST", body: JSON.stringify({ decision }) });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath("/");
  revalidatePath("/departments");
  return { ok: true };
}

// WSUX-6 — the unified /approvals inbox's decide action. Unlike
// `decideQueueItem` above (which dispatches per-origin to each native decide
// route directly, predating WSUX-2), this calls the WSUX-2 façade
// (`POST /api/:t/approvals/:id/decide`) straight up: one path, all five
// origins (agency|pipeline|hr|automation|agent), the façade's own dispatcher
// does the per-origin authorize()/Cerbos call. No new authorization model —
// same rule as `decideQueueItem`'s own comment, just via the endpoint instead
// of a client-side origin switch.
export type ApprovalDecideOrigin = "agency" | "pipeline" | "hr" | "automation" | "agent";

export async function decideApprovalItem(
  tenantId: string,
  origin: ApprovalDecideOrigin,
  id: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  try {
    await platformFetch(`/api/${tenantId}/approvals/${id}/decide`, userId, {
      method: "POST",
      body: JSON.stringify({ origin, decision, note }),
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath("/approvals");
  revalidatePath("/");
  revalidatePath("/departments");
  return { ok: true };
}
