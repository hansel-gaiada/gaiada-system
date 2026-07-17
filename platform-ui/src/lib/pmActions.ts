"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can, type Capability } from "./rbac";
import type { Assignee, TaskStatus } from "./pm";

export type PmResult = { ok: boolean; error?: string; id?: string };

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

// `cap` gates management actions on a capability against the active company;
// omit it for execution/collaboration writes any member may perform. Backend
// RLS/Cerbos remains the real boundary — this is defence-in-depth.
async function send(path: string, method: string, bodyObj?: unknown, cap?: Capability): Promise<PmResult> {
  const c = await ctx();
  if ("error" in c) return { error: c.error, ok: false };
  if (cap && !can(c.me, cap, c.tenant)) return { ok: false, error: "You don't have permission for this action." };
  try {
    const res = await platformFetch<{ id?: string; ok?: boolean }>(`/api/${c.tenant}${path}`, c.userId, {
      method,
      ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
    });
    return { ok: true, id: res?.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// Parse the AssigneePicker's hidden fields into an Assignee (or null when unset).
function parseAssignee(formData: FormData): Assignee | null {
  const kind = String(formData.get("assigneeKind") ?? "");
  const refId = String(formData.get("assigneeRefId") ?? "");
  const responsibleId = String(formData.get("responsibleId") ?? "");
  if (!kind || !refId || !responsibleId) return null;
  return {
    kind: kind as Assignee["kind"],
    refId,
    refName: String(formData.get("assigneeRefName") ?? refId),
    responsibleId,
    responsibleName: String(formData.get("responsibleName") ?? responsibleId),
  };
}

function revalTask(taskId: string) {
  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/tasks");
  revalidatePath("/projects", "layout");
}

// ---- task mutations ----
export async function moveTask(taskId: string, status: TaskStatus): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { status }, "pm.manage");
  revalTask(taskId);
  return r;
}
export async function setTaskProgress(taskId: string, progress: number): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { progress });
  revalTask(taskId);
  return r;
}
export async function setTaskStatus(taskId: string, status: TaskStatus): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { status });
  revalTask(taskId);
  return r;
}
export async function toggleSubtask(taskId: string, subtaskId: string): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { toggleSubtask: subtaskId });
  revalTask(taskId);
  return r;
}
export async function addSubtask(taskId: string, title: string): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { addSubtask: title });
  revalTask(taskId);
  return r;
}
export async function setAssignee(taskId: string, formData: FormData): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { assignee: parseAssignee(formData) }, "pm.manage");
  revalTask(taskId);
  return r;
}
export async function updateTaskMeta(taskId: string, formData: FormData): Promise<PmResult> {
  const body = {
    status: String(formData.get("status") ?? "") || undefined,
    priority: String(formData.get("priority") ?? "") || undefined,
    dueDate: String(formData.get("dueDate") ?? "") || undefined,
    milestoneId: formData.get("milestoneId") != null ? String(formData.get("milestoneId")) : undefined,
    description: formData.get("description") != null ? String(formData.get("description")) : undefined,
  };
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", body);
  revalTask(taskId);
  return r;
}

export async function deleteTask(taskId: string, projectId: string): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "DELETE", undefined, "pm.manage");
  revalidatePath("/tasks");
  revalidatePath(`/projects/${projectId}`);
  return r;
}
// Form-friendly: delete then leave the (now-gone) task page for its project.
export async function deleteTaskAction(taskId: string, projectId: string): Promise<void> {
  await deleteTask(taskId, projectId);
  redirect(`/projects/${projectId}`);
}

export async function createPmTask(projectId: string, formData: FormData): Promise<PmResult> {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };
  const body = {
    projectId,
    title,
    priority: String(formData.get("priority") ?? "normal"),
    dueDate: String(formData.get("dueDate") ?? "") || undefined,
    milestoneId: String(formData.get("milestoneId") ?? "") || undefined,
    description: String(formData.get("description") ?? "") || undefined,
    assignee: parseAssignee(formData),
  };
  const r = await send(`/pm/tasks`, "POST", body, "pm.manage");
  revalidatePath(`/projects/${projectId}`);
  return r;
}

// ---- dependencies ----
export async function addDependency(taskId: string, blockerId: string): Promise<PmResult> {
  if (!blockerId) return { ok: false, error: "Pick a task." };
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { addDependency: blockerId }, "pm.manage");
  revalTask(taskId);
  return r;
}
export async function removeDependency(taskId: string, blockerId: string): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { removeDependency: blockerId }, "pm.manage");
  revalTask(taskId);
  return r;
}

// ---- time tracking ----
export async function logTime(taskId: string, formData: FormData): Promise<PmResult> {
  const userId = await getSessionUserId();
  const minutes = Math.round(Number(formData.get("hours") ?? 0) * 60);
  if (!minutes || minutes <= 0) return { ok: false, error: "Enter time in hours (e.g. 1.5)." };
  const body = {
    userId,
    minutes,
    spentOn: String(formData.get("spentOn") ?? "") || undefined,
    billable: formData.get("billable") === "on" || formData.get("billable") === "true",
    note: String(formData.get("note") ?? ""),
  };
  const r = await send(`/pm/tasks/${taskId}/time`, "POST", body);
  revalTask(taskId);
  return r;
}

// ---- comments ----
export async function postTaskComment(taskId: string, body: string): Promise<PmResult> {
  const r = await send(`/comments?entityType=task&entityId=${taskId}`, "POST", { body });
  revalTask(taskId);
  return r;
}

// ---- AI tracker ----
export async function runTracker(taskId: string): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}/tracker/run`, "POST", {});
  revalTask(taskId);
  revalidatePath("/notifications");
  return r;
}
export async function confirmSuggestion(taskId: string, id: string): Promise<PmResult> {
  const r = await send(`/pm/suggestions/${id}/confirm`, "POST", {}, "pm.manage");
  revalTask(taskId);
  return r;
}
export async function dismissSuggestion(taskId: string, id: string): Promise<PmResult> {
  const r = await send(`/pm/suggestions/${id}/dismiss`, "POST", {}, "pm.manage");
  revalTask(taskId);
  return r;
}

// ---- project owner / milestones / docs ----
export async function setProjectOwner(projectId: string, formData: FormData): Promise<PmResult> {
  const r = await send(`/pm/projects/${projectId}`, "PATCH", { owner: parseAssignee(formData) }, "pm.manage");
  revalidatePath(`/projects/${projectId}`);
  return r;
}
export async function addMilestone(projectId: string, name: string, dueDate: string): Promise<PmResult> {
  const r = await send(`/pm/projects/${projectId}/milestones`, "POST", { name, dueDate: dueDate || null }, "pm.manage");
  revalidatePath(`/projects/${projectId}`);
  return r;
}
export async function saveDoc(projectId: string, title: string, body: string, docId?: string): Promise<PmResult> {
  const r = docId
    ? await send(`/pm/projects/${projectId}/docs/${docId}`, "PATCH", { title, body }, "pm.manage")
    : await send(`/pm/projects/${projectId}/docs`, "POST", { title, body }, "pm.manage");
  revalidatePath(`/projects/${projectId}`);
  return r;
}
