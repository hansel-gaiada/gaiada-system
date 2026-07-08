"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { patchComplianceGate, type AdminActionState } from "@/lib/adminData";

// Resolves userId + active tenant the same way the page does — mirrors
// admin/users/actions.ts, admin/identity/actions.ts and admin/modules/
// actions.ts. patchComplianceGate already flows through adminData's
// gracefulWrite, so no try/catch is needed beyond the session guard —
// {ok,error} is passed straight through for GateEditor to toast.
async function resolveContext(): Promise<{ userId: string; tenant: string } | AdminActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "No active company." };
  return { userId, tenant };
}

// Bound by the page to a specific gate id. Degrades gracefully until PATCH
// /api/:t/compliance-gates/:id lands.
export async function patchGateAction(
  id: string,
  _prev: AdminActionState | null,
  formData: FormData
): Promise<AdminActionState> {
  const ctx = await resolveContext();
  if ("ok" in ctx) return ctx;

  const status = String(formData.get("status") ?? "").trim();
  const evidenceUrl = String(formData.get("evidence_url") ?? "").trim();

  const body: { status?: string; evidence_url?: string | null } = {};
  if (status) body.status = status;
  body.evidence_url = evidenceUrl || null;

  const result = await patchComplianceGate(ctx.userId, ctx.tenant, id, body);
  if (result.ok) revalidatePath("/admin/compliance");
  return result;
}
