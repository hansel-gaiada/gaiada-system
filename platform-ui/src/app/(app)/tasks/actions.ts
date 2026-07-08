"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getFieldDefs } from "@/lib/entities";
import { parseCustomFields } from "@/lib/form";

export interface TaskFormState {
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

export async function createTaskInProject(
  projectId: string,
  _prev: TaskFormState | null,
  formData: FormData
): Promise<TaskFormState> {
  const resolved = await resolveTenant();
  if ("error" in resolved) return { error: resolved.error };
  const { userId, tenant } = resolved;

  const defs = await getFieldDefs(userId, tenant, "task");
  const customFields = parseCustomFields(formData, defs);
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "Title is required." };

  let id: string;
  try {
    const created = await platformFetch<{ id: string }>(`/api/${tenant}/projects/${projectId}/tasks`, userId, {
      method: "POST",
      body: JSON.stringify({ title, customFields }),
    });
    id = created.id;
  } catch (e) {
    if (e instanceof PlatformError) return { error: e.message };
    throw e;
  }

  revalidatePath("/tasks");
  redirect(id ? `/tasks/${id}` : "/tasks");
}

// NOTE: PATCH /api/:t/tasks/:id does not exist on the backend yet. This action
// is wired up so the UI degrades gracefully — it submits the update and, if the
// backend returns 404/405 (endpoint not found / not implemented), surfaces a
// friendly message instead of crashing. Remove this fallback once the backend
// ships task updates.
export async function updateTask(
  taskId: string,
  _prev: TaskFormState | null,
  formData: FormData
): Promise<TaskFormState> {
  const resolved = await resolveTenant();
  if ("error" in resolved) return { error: resolved.error };
  const { userId, tenant } = resolved;

  const defs = await getFieldDefs(userId, tenant, "task");
  const customFields = parseCustomFields(formData, defs);
  const title = String(formData.get("title") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim() || undefined;
  const priority = String(formData.get("priority") ?? "").trim() || undefined;
  const assigneeId = String(formData.get("assigneeId") ?? "").trim() || undefined;
  const dueDate = String(formData.get("dueDate") ?? "").trim() || undefined;
  if (!title) return { error: "Title is required." };

  try {
    await platformFetch(`/api/${tenant}/tasks/${taskId}`, userId, {
      method: "PATCH",
      body: JSON.stringify({ title, status, priority, assigneeId, dueDate, customFields }),
    });
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404 || e.status === 405) {
        return { error: "Editing tasks isn't available yet — the backend endpoint is pending." };
      }
      return { error: e.message };
    }
    throw e;
  }

  revalidatePath("/tasks");
  revalidatePath(`/tasks/${taskId}`);
  redirect(`/tasks/${taskId}`);
}
