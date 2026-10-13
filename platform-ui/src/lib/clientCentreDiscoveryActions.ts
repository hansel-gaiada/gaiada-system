"use server";
// Client Centre — "Fill from discovery answers" (PV6-04, CC-D6). Preview + run, over
// `GET .../clients/:id/centre/discovery` and `POST .../clients/:id/centre/fill-from-discovery`.
// Cerbos `client` read / update is the real authority; the preview degrades to "not available" on any
// 403/404 (module off, no converted lead) so the button simply does not show.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";

export interface DiscoveryPreview { available: boolean; fillable: string[] }
export interface DiscoveryFillOutcome {
  ok: boolean;
  error?: string;
  filled?: string[];
  skipped?: { key: string; reason: string }[];
}

async function ctx(): Promise<{ userId: string; tenant: string } | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const tenant = await getActiveTenant(await getMe(userId));
  return tenant ? { userId, tenant } : null;
}

export async function getDiscoveryPreviewAction(clientId: string): Promise<DiscoveryPreview> {
  const c = await ctx();
  if (!c) return { available: false, fillable: [] };
  try {
    return await platformFetch<DiscoveryPreview>(`/api/${c.tenant}/clients/${clientId}/centre/discovery`, c.userId);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 403 || e.status === 404)) return { available: false, fillable: [] };
    throw e;
  }
}

export async function fillFromDiscoveryAction(clientId: string): Promise<DiscoveryFillOutcome> {
  const c = await ctx();
  if (!c) return { ok: false, error: "Session expired — sign in again." };
  try {
    const r = await platformFetch<{ filled: string[]; skipped: { key: string; reason: string }[] }>(
      `/api/${c.tenant}/clients/${clientId}/centre/fill-from-discovery`, c.userId, { method: "POST" },
    );
    revalidatePath(`/clients/${clientId}/profile`, "layout");
    revalidatePath("/clients");
    return { ok: true, filled: r.filled, skipped: r.skipped };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}
