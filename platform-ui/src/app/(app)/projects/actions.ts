"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getFieldDefs } from "@/lib/entities";
import { parseCustomFields } from "@/lib/form";

export interface ProjectFormState {
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

export async function createProject(_prev: ProjectFormState | null, formData: FormData): Promise<ProjectFormState> {
  const resolved = await resolveTenant();
  if ("error" in resolved) return { error: resolved.error };
  const { userId, tenant } = resolved;

  const defs = await getFieldDefs(userId, tenant, "project");
  const customFields = parseCustomFields(formData, defs);
  const name = String(formData.get("name") ?? "").trim();
  const clientId = String(formData.get("clientId") ?? "").trim() || undefined;
  if (!name) return { error: "Name is required." };

  let id: string;
  try {
    const created = await platformFetch<{ id: string }>(`/api/${tenant}/projects`, userId, {
      method: "POST",
      body: JSON.stringify({ name, clientId, customFields }),
    });
    id = created.id;
  } catch (e) {
    if (e instanceof PlatformError) return { error: e.message };
    throw e;
  }

  revalidatePath("/projects");
  redirect(`/projects/${id}`);
}

export async function updateProject(projectId: string, _prev: ProjectFormState | null, formData: FormData): Promise<ProjectFormState> {
  const resolved = await resolveTenant();
  if ("error" in resolved) return { error: resolved.error };
  const { userId, tenant } = resolved;

  const defs = await getFieldDefs(userId, tenant, "project");
  const customFields = parseCustomFields(formData, defs);
  const name = String(formData.get("name") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim() || undefined;
  const clientId = String(formData.get("clientId") ?? "").trim() || undefined;
  const startDate = String(formData.get("startDate") ?? "").trim() || undefined;
  const dueDate = String(formData.get("dueDate") ?? "").trim() || undefined;
  if (!name) return { error: "Name is required." };

  try {
    await platformFetch(`/api/${tenant}/projects/${projectId}`, userId, {
      method: "PATCH",
      body: JSON.stringify({ name, status, clientId, startDate, dueDate, customFields }),
    });
  } catch (e) {
    if (e instanceof PlatformError) return { error: e.message };
    throw e;
  }

  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}`);
}
