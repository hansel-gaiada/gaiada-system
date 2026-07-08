"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { platformFetch, PlatformError } from "@/lib/platform";

export interface RecomputeState {
  ok: boolean;
  error?: string;
}

// No redirect here — the page stays put after a recompute, so (unlike the
// task/project actions) this can be wrapped fully in try/catch without
// worrying about swallowing Next's redirect control-flow exception.
export async function recompute(
  tenantId: string,
  _prev: RecomputeState | null,
  _formData?: FormData
): Promise<RecomputeState> {
  try {
    const userId = await getSessionUserId();
    if (!userId) return { ok: false, error: "Session expired — sign in again." };
    await platformFetch(`/api/${tenantId}/rollups/recompute`, userId, { method: "POST", body: JSON.stringify({}) });
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    return { ok: false, error: "That recompute didn't go through — please try again." };
  }
  revalidatePath("/rollups");
  return { ok: true };
}
