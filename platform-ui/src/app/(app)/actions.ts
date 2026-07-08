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
