import "server-only";
// Single source of truth for every backend path/shape the UI consumes.
// Follow-backend contract: only call endpoints verified to exist today.
// Missing detail endpoints are DERIVED from list endpoints or DEGRADE gracefully
// (never throw to the page) so pages can ship ahead of the backend.
import { platformFetch, PlatformError } from "./platform";

export interface Project {
  id: string;
  name: string;
  status: string;
  client_id: string | null;
  is_internal: boolean;
  owner_id: string | null;
  due_date: string | null;
  custom_fields: Record<string, unknown>;
}
export interface ProjectDetail extends Project {
  client_name: string | null;
  owner_name: string | null;
  start_date: string | null;
}
export interface Task {
  id: string;
  title: string;
  status: string | null;
  priority: string | null;
  assignee_id: string | null;
  due_date: string | null;
  project_id: string;
  project_name: string;
}
export interface TaskDetail extends Task {
  assignee_name: string | null;
  custom_fields: Record<string, unknown>;
}
export interface Member {
  user_id: string;
  name: string;
  email: string;
  title: string | null;
}
export interface FieldDef {
  key: string;
  label: string;
  data_type: "text" | "number" | "boolean" | "date" | "select";
  options: string[];
  required: boolean;
}
export interface Company {
  id: string;
  name: string;
  type: string | null;
  enabled_modules: string[];
  status: string;
}
export interface CompanyDetail extends Company {
  parent_company_id: string | null;
  settings: Record<string, unknown>;
}
export interface Campaign {
  id: string;
  name: string;
  status: string;
  project_id: string | null;
  budget_minor: number | null;
  currency: string | null;
}
export interface Brief {
  id: string;
  title: string;
  status: string;
  created_at: string;
}
export interface RollupRow {
  tenant_id: string;
  company: string;
  module: string;
  metric_key: string;
  numerator: number;
  denominator: number | null;
  currency: string | null;
  period: string;
}

// Absorbs both 404 (endpoint/entity not found) and 403 (module/feature not
// enabled for this tenant) so callers get a graceful fallback either way.
async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

// ---- Companies (list endpoint exists; no per-company detail endpoint yet) ----
export const listCompanies = (u: string) => platformFetch<Company[]>(`/api/companies`, u);

export async function getCompany(u: string, _t: string, id: string): Promise<Company | null> {
  const list = await listCompanies(u);
  return list.find((c) => c.id === id) ?? null;
}

// ---- Projects (list + detail endpoints both exist) ----
export const listProjects = (u: string, t: string) => platformFetch<Project[]>(`/api/${t}/projects`, u);
export const getProject = (u: string, t: string, id: string) => platformFetch<ProjectDetail>(`/api/${t}/projects/${id}`, u);

// ---- Tasks (list endpoints exist; detail endpoint may not, derive as fallback) ----
export const listTasks = (u: string, t: string) => platformFetch<Task[]>(`/api/${t}/tasks`, u);
export const listProjectTasks = (u: string, t: string, pid: string) => platformFetch<Task[]>(`/api/${t}/projects/${pid}/tasks`, u);

export async function getTask(u: string, t: string, id: string): Promise<TaskDetail | null> {
  try {
    return await platformFetch<TaskDetail>(`/api/${t}/tasks/${id}`, u);
  } catch (e) {
    if (!(e instanceof PlatformError && (e.status === 404 || e.status === 405))) throw e;
  }
  const list = await listTasks(u, t);
  const found = list.find((task) => task.id === id);
  if (!found) return null;
  return { ...found, custom_fields: {}, assignee_name: null };
}

// ---- Members (endpoint exists) ----
export const listMembers = (u: string, t: string) => platformFetch<Member[]>(`/api/${t}/members`, u);

// ---- Custom field definitions (endpoint may not exist yet) ----
export const getFieldDefs = (u: string, t: string, entityType: string) =>
  skipUnavailable(platformFetch<FieldDef[]>(`/api/${t}/custom-fields?entityType=${entityType}`, u), [] as FieldDef[]);

// ---- Agency module: campaigns (list endpoint exists; detail derived from list) ----
export const listCampaigns = (u: string, t: string) =>
  skipUnavailable(platformFetch<Campaign[]>(`/api/${t}/modules/agency/campaigns`, u), [] as Campaign[]);

export async function getCampaign(u: string, t: string, id: string): Promise<Campaign | null> {
  const list = await listCampaigns(u, t);
  return list.find((c) => c.id === id) ?? null;
}

// ---- Agency module: briefs (endpoint may not exist yet) ----
export const listBriefs = (u: string, t: string, cid: string) =>
  skipUnavailable(platformFetch<Brief[]>(`/api/${t}/modules/agency/campaigns/${cid}/briefs`, u), [] as Brief[]);

// ---- Rollups (endpoint exists) ----
export const getRollups = (u: string, period?: string) =>
  platformFetch<RollupRow[]>(`/api/rollups${period ? `?period=${period}` : ""}`, u);

// ---- Client-work: clients / deliverables / time entries (5c.2 — endpoints exist) ----
export interface Client { id: string; name: string; contact: Record<string, unknown>; status: string; custom_fields: Record<string, unknown> }
export interface Deliverable { id: string; project_id: string; client_id: string | null; name: string; status: string; due_date: string | null }
export interface TimeEntry { id: string; user_id: string; project_id: string; task_id: string | null; minutes: number; billable: boolean; entry_date: string; notes: string }

export const listClients = (u: string, t: string) =>
  skipUnavailable(platformFetch<Client[]>(`/api/${t}/clients`, u), [] as Client[]);
export const listDeliverables = (u: string, t: string, projectId?: string) =>
  skipUnavailable(platformFetch<Deliverable[]>(`/api/${t}/deliverables${projectId ? `?projectId=${projectId}` : ""}`, u), [] as Deliverable[]);
export const listTimeEntries = (u: string, t: string, q: { projectId?: string; mine?: boolean; userId?: string } = {}) =>
  skipUnavailable(
    platformFetch<TimeEntry[]>(
      `/api/${t}/time-entries?${new URLSearchParams({
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.mine ? { mine: "me" } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
      })}`,
      u,
    ),
    [] as TimeEntry[],
  );

// ---- Collaboration: comments + notifications (5c.3 — endpoints exist) ----
export interface Comment { id: string; author_id: string | null; author_name: string | null; body: string; parent_comment_id: string | null; created_at: string }
export interface NotificationItem { id: string; type: string; payload: Record<string, unknown>; read_at: string | null; created_at: string }

export const listComments = (u: string, t: string, entityType: string, entityId: string) =>
  skipUnavailable(platformFetch<Comment[]>(`/api/${t}/comments?entityType=${entityType}&entityId=${entityId}`, u), [] as Comment[]);
export const listNotifications = (u: string, t: string, unreadOnly = false) =>
  skipUnavailable(platformFetch<NotificationItem[]>(`/api/${t}/notifications${unreadOnly ? "?unread=true" : ""}`, u), [] as NotificationItem[]);

// ---- Files / attachments (5c.4 — endpoints exist) ----
export interface FileMeta { id: string; filename: string; content_type: string; byte_size: number; scrubbed: boolean; uploader_id: string | null; created_at: string }
export const listFiles = (u: string, t: string, entityType: string, entityId: string) =>
  skipUnavailable(platformFetch<FileMeta[]>(`/api/${t}/files?entityType=${entityType}&entityId=${entityId}`, u), [] as FileMeta[]);
