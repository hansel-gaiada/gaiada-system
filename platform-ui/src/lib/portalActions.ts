"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";

// WS11 client-portal write actions: the client signs their PRD / scope gate and submits feedback.
// The portal BFF enforces client-role + run ownership; these are the client's own actions (no staff
// capability gate). Errors are swallowed into a redirect-friendly revalidate (form actions return void).
async function ctx(): Promise<{ userId: string; tenant: string } | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const me: Me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return null;
  return { userId, tenant };
}

/** Client decides one of THEIR client-side gates (sign the PRD, or approve/request-changes feedback). */
export async function portalDecideGate(formData: FormData): Promise<void> {
  const c = await ctx();
  if (!c) return;
  const gateId = String(formData.get("gateId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const note = String(formData.get("note") ?? "");
  if (!gateId || !decision) return;
  try {
    await platformFetch(`/api/${c.tenant}/portal/gates/${gateId}/decide`, c.userId, {
      method: "POST",
      body: JSON.stringify({ decision, note: note || undefined }),
    });
  } catch (e) {
    if (!(e instanceof PlatformError)) throw e;
  }
  revalidatePath("/portal");
}

/** Client signs the Scope Agreement (the `client` party) for one of their runs. */
export async function portalScopeSign(formData: FormData): Promise<void> {
  const c = await ctx();
  if (!c) return;
  const runId = String(formData.get("runId") ?? "");
  const gateId = String(formData.get("gateId") ?? "");
  const signerName = String(formData.get("signerName") ?? "");
  if (!runId) return;
  try {
    await platformFetch(`/api/${c.tenant}/portal/runs/${runId}/scope-sign`, c.userId, {
      method: "POST",
      body: JSON.stringify({ gateId: gateId || undefined, signerName: signerName || undefined }),
    });
  } catch (e) {
    if (!(e instanceof PlatformError)) throw e;
  }
  revalidatePath("/portal");
}
