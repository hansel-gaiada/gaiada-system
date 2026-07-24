"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can, type Capability } from "./rbac";
import { getPmTask, assignableUnits, listProjectStatuses, listTags, listTemplates, listDocVersions, getDocVersion, RECURRENCE_FREQS, type Assignee, type Priority, type TagColor, type RecurrenceFreq, type TaskRecurrence, type Template, type DocVersion, type DocVersionFull } from "./pm";
import { getFieldDefs } from "./entities";
import { parseCustomFields } from "./form";

// `spawned` (P2-06, design spec §8): set on a PATCH that just completed a
// recurring task and cloned its next occurrence — null/undefined otherwise.
export type PmResult = { ok: boolean; error?: string; id?: string; spawned?: { id: string; dueDate: string } | null };

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
    const res = await platformFetch<{ id?: string; ok?: boolean; spawned?: { id: string; dueDate: string } | null }>(`/api/${c.tenant}${path}`, c.userId, {
      method,
      ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
    });
    return { ok: true, id: res?.id, spawned: res?.spawned };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// Parse NewTaskForm's "Repeats" select + conditional "Ends" date into a
// TaskRecurrence (P2-06, design spec §8), or undefined when "None" is picked.
function parseRecurrence(formData: FormData): TaskRecurrence | undefined {
  const freq = String(formData.get("repeats") ?? "");
  if (!RECURRENCE_FREQS.includes(freq as RecurrenceFreq)) return undefined;
  const until = String(formData.get("repeatsUntil") ?? "").trim();
  return until ? { freq: freq as RecurrenceFreq, until } : { freq: freq as RecurrenceFreq };
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
// P2-05: `status` is now a ProjectStatus id (string) from the task's own
// project's registry — the board's status column key. Also the `movePick`
// callback for the dept board's union-by-label no-match popover.
export async function moveTask(taskId: string, status: string): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { status }, "pm.manage");
  revalTask(taskId);
  return r;
}

// Dept board (union-by-label, design spec §7 D-4): a drop targets a status
// LABEL; resolve it to the id in the card's OWN project. When that project has
// no same-label status, return a `pick` so the board opens the popover to choose
// from that project's statuses (committed via `moveTask`/`movePick`).
export async function moveTaskToStatusLabel(taskId: string, label: string): Promise<PmResult & { pick?: { options: { id: string; name: string }[] } }> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const task = await getPmTask(c.userId, c.tenant, taskId);
  if (!task) return { ok: false, error: "Task not found." };
  const statuses = await listProjectStatuses(c.userId, c.tenant, task.projectId);
  const match = statuses.find((s) => s.label === label);
  if (match) return moveTask(taskId, match.id);
  return { ok: false, pick: { options: statuses.map((s) => ({ id: s.id, name: s.label })) } };
}

// Drag-to-reschedule (P1-04 — dept Gantt). Middle-drag moves both dates,
// edge-drag resizes one; the Gantt computes the new start/due from the pixel
// delta and commits them here. Same shape as moveTask; gated on pm.manage
// (server RLS/Cerbos remains the real boundary). Nulls clear a date.
export async function rescheduleTask(taskId: string, startDate: string | null, dueDate: string | null): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { startDate, dueDate }, "pm.manage");
  revalTask(taskId);
  return r;
}

// Move-together / multiselect (P2-08, design spec §4 phase-2): the Gantt commits a whole set of
// bars (a dragged task's transitive dependents, and/or a shift-multiselected set) as one batch of
// sequential `rescheduleTask` calls — the locked contract has no bulk endpoint. "All or nothing"
// is visual only: on any failure the caller's `router.refresh()` reconciles the UI to whatever the
// server actually holds (some items may have committed, some not) rather than the batch being a
// real transaction. Returns the first failure's message; empty input is a no-op success.
export interface RescheduleItem { taskId: string; startDate: string | null; dueDate: string | null }
export async function batchReschedule(items: RescheduleItem[]): Promise<PmResult> {
  let firstError: string | undefined;
  for (const it of items) {
    const r = await rescheduleTask(it.taskId, it.startDate, it.dueDate);
    if (!r.ok && !firstError) firstError = r.error ?? "Couldn't reschedule.";
  }
  return firstError ? { ok: false, error: firstError } : { ok: true };
}

// ---- board axis moves (P1-03 — Board unifies status/assignee/priority/division drag) ----
export async function setTaskPriority(taskId: string, priority: Priority): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { priority }, "pm.manage");
  revalTask(taskId);
  return r;
}

// Assignee-axis drag: keeps the existing assignee's kind/refId/refName, only swaps who's
// responsible (the "__unassigned" sentinel column isn't a valid drop target — a task can't be
// dragged into "no assignee" this way).
export async function reassignResponsible(taskId: string, responsibleId: string): Promise<PmResult> {
  if (responsibleId === "__unassigned") return { ok: false, error: "Drop on a specific person to reassign — open the task to unassign." };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const [current, { members }] = await Promise.all([
    getPmTask(c.userId, c.tenant, taskId),
    assignableUnits(c.userId, c.tenant),
  ]);
  if (!current) return { ok: false, error: "Task not found." };
  const responsibleName = members.find((m) => m.id === responsibleId)?.name ?? responsibleId;
  const assignee: Assignee = current.assignee
    ? { ...current.assignee, responsibleId, responsibleName }
    : { kind: "person", refId: responsibleId, refName: responsibleName, responsibleId, responsibleName };
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { assignee }, "pm.manage");
  revalTask(taskId);
  return r;
}

// Division-axis drag: sets assignee={kind:"division",...} with the resolved responsible person.
// `responsibleId` is optional at the TYPE level only so this matches Board's generic `move`
// signature (other axes never pass it) — at runtime it's always required for a real commit;
// Board itself guarantees it's supplied (either the current responsible already belongs to the
// target division, or the drop popover's pick) before ever calling this. The "__no_division"
// sentinel column is never a valid drop target (there's no division to resolve a responsible
// person against) — open the task to clear a division assignment instead.
export async function setDivisionAssignee(taskId: string, divisionId: string, responsibleId?: string): Promise<PmResult> {
  if (divisionId === "__no_division") return { ok: false, error: "Can't drag off a division here — open the task to change its assignee." };
  if (!responsibleId) return { ok: false, error: "Pick a responsible person for this division." };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const { units, members } = await assignableUnits(c.userId, c.tenant);
  const division = units.find((u) => u.kind === "division" && u.id === divisionId);
  const refName = division?.name ?? divisionId;
  const responsibleName = members.find((m) => m.id === responsibleId)?.name ?? responsibleId;
  const assignee: Assignee = { kind: "division", refId: divisionId, refName, responsibleId, responsibleName };
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { assignee }, "pm.manage");
  revalTask(taskId);
  return r;
}
export async function setTaskProgress(taskId: string, progress: number): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { progress });
  revalTask(taskId);
  return r;
}
export async function setTaskStatus(taskId: string, status: string): Promise<PmResult> {
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

// ---- recurring tasks (P2-06, design spec §8) ----
// The Undo action on the "Next occurrence created…" toast: a spawned child
// always lives in its parent's own project (the spawn never changes project),
// so callers bind `projectId` ahead of time (e.g.
// `undoRecurrenceSpawn.bind(null, task.projectId)`) and invoke with just the
// spawned task's id once the PATCH response reveals it.
export async function undoRecurrenceSpawn(projectId: string, spawnedTaskId: string): Promise<PmResult> {
  return deleteTask(spawnedTaskId, projectId);
}
// Form-friendly: delete then leave the (now-gone) task page for its project.
export async function deleteTaskAction(taskId: string, projectId: string): Promise<void> {
  await deleteTask(taskId, projectId);
  redirect(`/projects/${projectId}`);
}

// P3-03: resolve the "create from template" tag CHIPS (plain labels — a
// template is tenant-wide, so it can't carry project-scoped tag ids) against
// THIS project's own tag registry, creating any label that doesn't already
// exist there (same "materialize on first use" spirit as custom statuses).
// Case-insensitive match so re-picking a template twice doesn't spawn
// duplicate tags differing only in case.
async function resolveTagLabels(userId: string, tenant: string, projectId: string, labels: string[]): Promise<string[]> {
  if (labels.length === 0) return [];
  const registry = await listTags(userId, tenant, projectId);
  const ids: string[] = [];
  for (const label of labels) {
    const existing = registry.find((tg) => tg.label.toLowerCase() === label.toLowerCase());
    if (existing) { ids.push(existing.id); continue; }
    const r = await createTag(projectId, label, "bronze");
    if (r.ok && r.id) { ids.push(r.id); registry.push({ id: r.id, label, color: "bronze" }); }
  }
  return ids;
}

export async function createPmTask(projectId: string, formData: FormData): Promise<PmResult> {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };
  const c = await ctx();
  const customFields = "error" in c ? {} : parseCustomFields(formData, await getFieldDefs(c.userId, c.tenant, "pm_task"));
  const subtasks = formData.getAll("subtasks").map(String).filter((s) => s.trim() !== "");
  const tagLabels = formData.getAll("tagLabels").map(String).filter((s) => s.trim() !== "");
  const estimateMinutesRaw = String(formData.get("estimateMinutes") ?? "").trim();
  const tags = "error" in c ? [] : await resolveTagLabels(c.userId, c.tenant, projectId, tagLabels);
  const body = {
    projectId,
    title,
    priority: String(formData.get("priority") ?? "normal"),
    dueDate: String(formData.get("dueDate") ?? "") || undefined,
    milestoneId: String(formData.get("milestoneId") ?? "") || undefined,
    description: String(formData.get("description") ?? "") || undefined,
    assignee: parseAssignee(formData),
    customFields,
    recurrence: parseRecurrence(formData),
    estimateMinutes: estimateMinutesRaw ? Number(estimateMinutesRaw) : undefined,
    subtasks: subtasks.length ? subtasks : undefined,
    tags: tags.length ? tags : undefined,
  };
  const r = await send(`/pm/tasks`, "POST", body, "pm.manage");
  revalidatePath(`/projects/${projectId}`);
  return r;
}

// ---- task templates (P3-03) ----
export interface TemplateInput {
  title: string;
  description?: string;
  priority?: Priority;
  estimateMinutes?: number;
  subtasks?: string[];
  tagLabels?: string[];
}
export type TemplatesResult = { ok: boolean; error?: string; templates: Template[] };

// Client components (NewTaskForm) call this directly on mount to populate the
// "Template" picker — no page prop-threading needed, same pattern Gantt.tsx
// already uses for batchReschedule/addDependency.
export async function listTaskTemplates(): Promise<TemplatesResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error, templates: [] };
  const templates = await listTemplates(c.userId, c.tenant, "task");
  return { ok: true, templates };
}
export async function createTaskTemplate(input: TemplateInput): Promise<PmResult> {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Title is required." };
  return send(`/pm/templates`, "POST", { kind: "task", ...input, title }, "pm.manage");
}
export async function updateTaskTemplate(templateId: string, patch: Partial<TemplateInput>): Promise<PmResult> {
  return send(`/pm/templates/${templateId}`, "PATCH", patch, "pm.manage");
}
export async function deleteTaskTemplate(templateId: string): Promise<PmResult> {
  return send(`/pm/templates/${templateId}`, "DELETE", undefined, "pm.manage");
}
// Bound with the current task's fields from TaskDetailView — a plain form
// action (no navigation on success, same "fire and forget" shape as
// deleteTaskAction's sibling writes); the template list itself is refetched
// client-side (listTaskTemplates) so no revalidatePath target applies here.
export async function saveTaskAsTemplateAction(input: TemplateInput): Promise<void> {
  await createTaskTemplate(input);
}

// ---- duplicate task (P3-03) ----
export async function duplicateTask(taskId: string): Promise<PmResult> {
  return send(`/pm/tasks/${taskId}/duplicate`, "POST", {});
}
// Form-friendly: duplicate then land on the new task's own standalone page
// (detail may be reached from either the standalone /tasks/:id mount or a
// department console's nested mount — the standalone path always resolves).
export async function duplicateTaskAction(taskId: string): Promise<void> {
  const r = await duplicateTask(taskId);
  if (r.ok && r.id) redirect(`/tasks/${r.id}`);
  revalTask(taskId);
}

// ---- custom fields (P2-03, D17 framework reuse) ----
export async function updateTaskCustomFields(taskId: string, formData: FormData): Promise<PmResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const defs = await getFieldDefs(c.userId, c.tenant, "pm_task");
  const customFields = parseCustomFields(formData, defs);
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { customFields });
  revalTask(taskId);
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

// ---- comment reactions (P3-09) ----
// Self-scoped, member-level (no `pm.manage` cap) — reacting is collaboration,
// not management. The DELETE targets only the CALLING user's own row (backend
// contract); a comment id belonging to a different entity than the current
// page still works fine (the client passes only commentId + emoji, no taskId).
export async function addReaction(commentId: string, emoji: string): Promise<PmResult> {
  return send(`/comments/${commentId}/reactions`, "POST", { emoji });
}
export async function removeReaction(commentId: string, emoji: string): Promise<PmResult> {
  return send(`/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`, "DELETE");
}

// ---- task followers (P3-09) ----
// Self-scoped, member-level (no `pm.manage` cap) — following a task is a
// personal subscription, not a management action.
export async function followTask(taskId: string): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}/follow`, "POST", {});
  revalTask(taskId);
  return r;
}
export async function unfollowTask(taskId: string): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}/follow`, "DELETE");
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

// ---- tags (P2-02 — per-project registry, design spec §6) ----
export async function setTaskTags(taskId: string, tags: string[]): Promise<PmResult> {
  const r = await send(`/pm/tasks/${taskId}`, "PATCH", { tags });
  revalTask(taskId);
  return r;
}
function revalTags(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects", "layout");
  revalidatePath("/tasks");
}
export async function createTag(projectId: string, label: string, color: TagColor): Promise<PmResult> {
  const l = label.trim();
  if (!l) return { ok: false, error: "Tag name is required." };
  const r = await send(`/pm/projects/${projectId}/tags`, "POST", { label: l, color }, "pm.manage");
  revalTags(projectId);
  return r;
}
export async function updateTag(projectId: string, tagId: string, patch: { label?: string; color?: TagColor }): Promise<PmResult> {
  const body: Record<string, unknown> = {};
  if (patch.label !== undefined) body.label = patch.label.trim();
  if (patch.color !== undefined) body.color = patch.color;
  const r = await send(`/pm/projects/${projectId}/tags/${tagId}`, "PATCH", body, "pm.manage");
  revalTags(projectId);
  return r;
}
// DELETE guard (design spec §6): the backend 409s with { inUse:true } unless
// `?force=1` is set; the caller (TagManager) shows an inline confirm and
// re-calls with `force: true` — same shape callers already expect from `send`
// plus the extra `inUse` flag so the UI can distinguish "blocked, needs
// confirm" from a real failure.
export async function deleteTag(projectId: string, tagId: string, force = false): Promise<PmResult & { inUse?: boolean }> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "pm.manage", c.tenant)) return { ok: false, error: "You don't have permission for this action." };
  try {
    await platformFetch<{ ok?: boolean }>(`/api/${c.tenant}/pm/projects/${projectId}/tags/${tagId}${force ? "?force=1" : ""}`, c.userId, { method: "DELETE" });
    revalTags(projectId);
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 409) return { ok: false, inUse: true, error: "This tag is in use — remove again to delete it anyway." };
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

// ---- custom statuses (P2-05, design spec §7) ----
export interface StatusInput { label: string; color: string; isDone: boolean; isBlocked: boolean; wipLimit?: number }
// Patch shape for a single status: any field, plus a nullable wipLimit (null
// clears the limit) and an explicit position (reorder writes it).
export interface StatusPatch { label?: string; color?: string; isDone?: boolean; isBlocked?: boolean; wipLimit?: number | null; position?: number }
function revalStatuses(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects", "layout");
  revalidatePath("/departments", "layout");
  revalidatePath("/tasks");
}
export async function createStatus(projectId: string, input: StatusInput): Promise<PmResult> {
  const label = input.label.trim();
  if (!label) return { ok: false, error: "Status name is required." };
  const r = await send(`/pm/projects/${projectId}/statuses`, "POST", { ...input, label }, "pm.manage");
  revalStatuses(projectId);
  return r;
}
export async function updateStatus(projectId: string, statusId: string, patch: StatusPatch): Promise<PmResult> {
  const body: Record<string, unknown> = { ...patch };
  if (typeof body.label === "string") body.label = (body.label as string).trim();
  const r = await send(`/pm/projects/${projectId}/statuses/${statusId}`, "PATCH", body, "pm.manage");
  revalStatuses(projectId);
  return r;
}
// Reorder = PATCH each status's new position (the locked contract has no bulk
// endpoint — statuses/:sid PATCH is the only writer). The client sends the full
// desired id order; each row gets its index as `position`.
export async function reorderStatuses(projectId: string, orderedIds: string[]): Promise<PmResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "pm.manage", c.tenant)) return { ok: false, error: "You don't have permission for this action." };
  try {
    for (let i = 0; i < orderedIds.length; i++) {
      await platformFetch(`/api/${c.tenant}/pm/projects/${projectId}/statuses/${orderedIds[i]}`, c.userId, {
        method: "PATCH",
        body: JSON.stringify({ position: i }),
      });
    }
    revalStatuses(projectId);
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}
// Guarded delete (locked contract): DELETE → 400 { inUse:n } unless `?moveTo=<sid>`.
// The editor already knows the in-use count (rendered from the task list) so it
// passes `moveTo` proactively; a bare delete that comes back 400 is the safety
// net (surfaced as an inline message).
export async function deleteStatus(projectId: string, statusId: string, moveTo?: string): Promise<PmResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "pm.manage", c.tenant)) return { ok: false, error: "You don't have permission for this action." };
  try {
    await platformFetch(`/api/${c.tenant}/pm/projects/${projectId}/statuses/${statusId}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ""}`, c.userId, { method: "DELETE" });
    revalStatuses(projectId);
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 400) return { ok: false, error: "This status has tasks — pick where to move them first." };
      return { ok: false, error: e.message };
    }
    throw e;
  }
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

// ---- doc version history (P3-11) ----
// `DocHistory` is a client component and `pm.ts` is server-only ("use server"
// / server-only readers), so it can only reach these lists/reads through
// server actions here — same "no client runtime-import of pm.ts" rule every
// other client PM component already follows (types only).
export async function fetchDocVersions(docId: string): Promise<{ ok: boolean; error?: string; versions: DocVersion[] }> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error, versions: [] };
  const versions = await listDocVersions(c.userId, c.tenant, docId);
  return { ok: true, versions };
}
export async function fetchDocVersion(docId: string, v: number): Promise<{ ok: boolean; error?: string; version: DocVersionFull | null }> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error, version: null };
  const version = await getDocVersion(c.userId, c.tenant, docId, v);
  return { ok: true, version };
}
export async function restoreDocVersion(docId: string, v: number): Promise<PmResult> {
  const r = await send(`/pm/docs/${docId}/versions/${v}/restore`, "POST", {}, "pm.manage");
  // No project id is threaded through here (the locked contract's restore path
  // is project-agnostic, `/pm/docs/:docId/...`) — revalidate the whole Projects
  // subtree so whichever workspace the doc lives in picks up the new version.
  revalidatePath("/projects", "layout");
  return r;
}

// ---- doc templates (P3-11) — reuse the P3-01/P3-03 template endpoints with
// kind=doc; "apply" is purely client-side (prefill title/body from the picked
// template), so only create + list are needed here (update/delete already
// exist as the generic updateTaskTemplate/deleteTaskTemplate — they PATCH/
// DELETE by id regardless of kind).
export interface DocTemplateInput { title: string; body: string }
export async function listDocTemplates(): Promise<TemplatesResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error, templates: [] };
  const templates = await listTemplates(c.userId, c.tenant, "doc");
  return { ok: true, templates };
}
export async function createDocTemplate(input: DocTemplateInput): Promise<PmResult> {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Title is required." };
  return send(`/pm/templates`, "POST", { kind: "doc", title, body: input.body }, "pm.manage");
}

// ---- duplicate project (P3-04) ----
export async function duplicateProject(projectId: string, name: string): Promise<PmResult> {
  const nameStr = name.trim();
  if (!nameStr) return { ok: false, error: "Project name is required." };
  return send(`/pm/projects/${projectId}/duplicate`, "POST", { name: nameStr }, "pm.manage");
}
// Form-friendly: duplicate then navigate to the new project's workspace
export async function duplicateProjectAction(projectId: string, name: string): Promise<void> {
  const r = await duplicateProject(projectId, name);
  if (r.ok && r.id) redirect(`/projects/${r.id}`);
  revalidatePath(`/projects/${projectId}`);
}
