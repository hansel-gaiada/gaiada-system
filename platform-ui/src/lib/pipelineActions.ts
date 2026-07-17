"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";

export type PipelineResult = { ok: boolean; error?: string };

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

/** Decide an INTERNAL pipeline gate (PM review / approval). Gated on approvals.decide; the backend
 *  Cerbos policy is the real boundary. Client-side gates (PRD sign / scope / feedback) are decided
 *  in the client portal, not here. */
export async function decideGateAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "approvals.decide", c.tenant)) return { ok: false, error: "You don't have permission to decide gates." };
  const gateId = String(formData.get("gateId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const note = String(formData.get("note") ?? "");
  if (!gateId || !decision) return { ok: false, error: "gateId and decision required." };
  try {
    await platformFetch(`/api/${c.tenant}/pipeline/gates/${gateId}/decide`, c.userId, {
      method: "POST",
      body: JSON.stringify({ decision, note: note || undefined }),
    });
    revalidatePath("/pipeline");
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}
