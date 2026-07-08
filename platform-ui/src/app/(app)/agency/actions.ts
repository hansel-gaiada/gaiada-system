"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";

export interface CampaignFormState {
  error?: string;
}

export interface BriefFormState {
  error?: string;
}

async function resolveTenant(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

export async function createCampaign(_prev: CampaignFormState | null, formData: FormData): Promise<CampaignFormState> {
  const resolved = await resolveTenant();
  if ("error" in resolved) return { error: resolved.error };
  const { userId, tenant } = resolved;

  const name = String(formData.get("name") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();
  if (!name) return { error: "Name is required." };
  if (!projectId) return { error: "Project is required." };

  let id: string;
  try {
    const created = await platformFetch<{ id: string }>(`/api/${tenant}/modules/agency/campaigns`, userId, {
      method: "POST",
      body: JSON.stringify({ name, projectId }),
    });
    id = created.id;
  } catch (e) {
    if (e instanceof PlatformError) return { error: e.message };
    throw e;
  }

  revalidatePath("/agency");
  redirect(`/agency/${id}`);
}

// NOTE: the briefs endpoints (GET/POST .../campaigns/:id/briefs) do not exist on the
// backend yet. This action is wired ahead of the backend so the UI is ready the moment
// it lands — until then it degrades to a friendly message on 404/405.
export async function createBrief(campaignId: string, _prev: BriefFormState | null, formData: FormData): Promise<BriefFormState> {
  const resolved = await resolveTenant();
  if ("error" in resolved) return { error: resolved.error };
  const { userId, tenant } = resolved;

  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!title) return { error: "Title is required." };

  try {
    await platformFetch(`/api/${tenant}/modules/agency/campaigns/${campaignId}/briefs`, userId, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405)) {
      return { error: "Creating briefs isn't available yet — the backend endpoint is pending." };
    }
    if (e instanceof PlatformError) return { error: e.message };
    throw e;
  }

  revalidatePath(`/agency/${campaignId}`);
  redirect(`/agency/${campaignId}`);
}
