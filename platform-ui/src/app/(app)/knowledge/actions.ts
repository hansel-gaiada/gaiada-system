"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";

export interface ReviewActionState {
  ok: boolean;
  error?: string;
}

// NOTE: POST /api/:tenant/knowledge/sources/:id/review does not exist on the
// backend yet. This action is wired up so the UI degrades gracefully — on a
// 404/405 it surfaces a friendly message instead of crashing. Remove this
// fallback once the knowledge admin API ships review writes.
export async function reviewSource(
  sourceId: string,
  decision: "approved" | "rejected",
  _prev: ReviewActionState | null,
  _formData: FormData
): Promise<ReviewActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "No active company selected." };

  try {
    await platformFetch(`/api/${tenant}/knowledge/sources/${sourceId}/review`, userId, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404 || e.status === 405) {
        return { ok: false, error: "Reviewing sources isn't available yet — the knowledge admin API is pending." };
      }
      return { ok: false, error: e.message };
    }
    throw e;
  }

  revalidatePath("/knowledge");
  return { ok: true };
}
