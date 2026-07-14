"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";

interface ActionState {
  ok: boolean;
  error?: string;
}

// Mark one (or all, when id omitted) notifications read. Degrades gracefully —
// the backend mark-read route may not exist yet.
export async function markRead(id?: string): Promise<ActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Not signed in." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "No active company." };

  const path = id ? `/api/${tenant}/notifications/${id}/read` : `/api/${tenant}/notifications/read`;
  try {
    await platformFetch(path, userId, { method: "POST" });
    revalidatePath("/notifications");
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405)) {
      return { ok: false, error: "Not available yet — the backend endpoint is pending." };
    }
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// Form-action wrapper (ignores FormData) so the page can mark all read with a
// plain <form action={markAllReadAction}> and no client component.
export async function markAllReadAction(): Promise<void> {
  await markRead();
}
