import "server-only";
// Single source of truth for every backend path/shape the UI consumes.
// Follow-backend contract: only call endpoints verified to exist today.
// Missing detail endpoints are DERIVED from list endpoints or DEGRADE gracefully
// (never throw to the page) so pages can ship ahead of the backend.
import { platformFetch, PlatformError } from "./platform";
import { readResult, type ReadResult } from "./readResult";

export interface Project {
  id: string;
  name: string;
  status: string;
  client_id: string | null;
  is_internal: boolean;
  owner_id: string | null;
  // Owning department (org-structure node id). A project belongs to one
  // department; cross-department work still flows via task assignment. Null =
  // company-level / unassigned. BFF: GET returns it; POST/PATCH accept departmentId.
  department_id: string | null;
  // P4-H2: the AUTHORED range's two ends. `start_date` used to live only on ProjectDetail because
  // only the detail read selected it; the list now selects it too, so every consumer can draw the
  // authored range against the task-derived envelope (decision 12).
  start_date: string | null;
  due_date: string | null;
  custom_fields: Record<string, unknown>;
  // WD-28: unique per tenant, derived on creation + backfilled for legacy rows.
  shortCode: string | null;
}
export interface ProjectDetail extends Project {
  client_name: string | null;
  owner_name: string | null;
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
  // Business line (PV-D14). Only the detail endpoint returns it today; the list omits it.
  vertical?: string;
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

// ---- Companies (list endpoint exists; detail derived from list) ----
export const listCompanies = (u: string) => platformFetch<Company[]>(`/api/companies`, u);

export async function getCompany(u: string, _t: string, id: string): Promise<Company | null> {
  const list = await listCompanies(u);
  return list.find((c) => c.id === id) ?? null;
}

// D14-08 — `GET /api/companies/:companyId` now exists for real (`admin/company-crud.controller.ts`,
// built alongside D14-07's settings write below) and is the only reader that carries `settings`
// (`getCompany` above deliberately still derives from the list — untouched, other callers rely on
// that shape). Degrades to `null` on 404/403 so a caller missing the grant sees "unavailable", not
// a thrown error.
export async function getCompanyDetail(u: string, id: string): Promise<CompanyDetail | null> {
  try {
    return await platformFetch<CompanyDetail>(`/api/companies/${id}`, u);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

// Company CRUD — BFF contract (backend TODO, see docs/FRONTEND-BFF-CONTRACT.md):
//   POST  /api/companies                 body {name,type,parentCompanyId?,modules?,vertical?} -> { id }
//   PATCH /api/companies/:id              body (partial)                             -> { ok }
// Elevated / company.manage only (backend RLS is the real boundary).
export interface CompanyInput { name: string; type?: string | null; parentCompanyId?: string | null; modules?: string[]; status?: string; vertical?: string }
export const createCompany = (u: string, body: CompanyInput) =>
  platformFetch<{ id: string }>(`/api/companies`, u, { method: "POST", body: JSON.stringify(body) });
export const updateCompany = (u: string, id: string, body: Partial<CompanyInput>) =>
  platformFetch<{ ok: true }>(`/api/companies/${id}`, u, { method: "PATCH", body: JSON.stringify(body) });

// D14-07's namespaced settings write — the SAME `PATCH /api/companies/:id` above, but this is the
// only key `company-crud.controller.ts` accepts under `settings` (a validated, individually-merged
// path; never a blanket `settings` overwrite — see that controller's own header). Kept as its own
// typed call rather than widening `CompanyInput` so nothing else on this page can accidentally send
// an arbitrary `settings` blob through `updateCompany`.
export const updateApprovalRetryCount = (u: string, companyId: string, autoRetryCount: number) =>
  platformFetch<{ ok: true }>(`/api/companies/${companyId}`, u, {
    method: "PATCH",
    body: JSON.stringify({ settings: { automation: { approvalRetry: { autoRetryCount } } } }),
  });

// ---- Projects (list + detail endpoints both exist) ----
// CC-1: `clientId` may be a uuid or the reserved `"internal"` (projects with no client). Omitted is
// unchanged — every project. Filtering server-side matters beyond tidiness: the client page used to
// fetch every project in the tenant and narrow in the browser, which stops being a filter at volume.
export const listProjects = (u: string, t: string, clientId?: string) =>
  platformFetch<Project[]>(`/api/${t}/projects${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`, u);
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
// `includeService` adds the non-human accounts (automation, service rows) that the directory hides by default (PK-02).
export const listMembers = (u: string, t: string, opts?: { includeService?: boolean }) =>
  platformFetch<Member[]>(`/api/${t}/members${opts?.includeService ? "?includeService=1" : ""}`, u);

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
/** `owner_*` (CC-D10) are the staff member who owns the relationship; both null when unassigned.
 *  Optional so an older backend (pre-migration) still type-checks as "no owner". */
export interface Client {
  id: string; name: string; contact: Record<string, unknown>; status: string; custom_fields: Record<string, unknown>;
  owner_user_id?: string | null; owner_name?: string | null;
}
/** The contact keys the staff UI edits (platform-nest `client-input.ts` CONTACT_KEYS). */
export const CLIENT_CONTACT_KEYS = ["email", "phone", "address", "billingName", "billingEmail"] as const;
export type ClientContactKey = (typeof CLIENT_CONTACT_KEYS)[number];
export const CLIENT_CONTACT_LABELS: Record<ClientContactKey, string> = {
  email: "Primary email", phone: "Phone", address: "Address", billingName: "Billing contact", billingEmail: "Billing email",
};
export interface ClientNote { id: string; body: string; authorId: string | null; authorName: string | null; createdAt: string }
export interface ClientHistoryEntry {
  id: string; verb: string; occurredAt: string; actorId: string | null; actorName: string | null;
  metadata: { changes?: { field: string; before: string | null; after: string | null }[]; via?: string; [k: string]: unknown };
}
export interface Deliverable { id: string; project_id: string; client_id: string | null; name: string; status: string; due_date: string | null }
export interface TimeEntry { id: string; user_id: string; project_id: string; task_id: string | null; minutes: number; billable: boolean; entry_date: string; notes: string }

export const listClients = (u: string, t: string) =>
  skipUnavailable(platformFetch<Client[]>(`/api/${t}/clients`, u), [] as Client[]);
export async function getClient(u: string, t: string, id: string): Promise<Client | null> {
  const list = await listClients(u, t);
  return list.find((c) => c.id === id) ?? null;
}
// Client-work CRUD — BFF contract (backend TODO, see docs/FRONTEND-BFF-CONTRACT.md).
export const createClient = (u: string, t: string, body: { name: string; status?: string; contact?: Record<string, string>; ownerUserId?: string | null }) =>
  platformFetch<{ id: string }>(`/api/${t}/clients`, u, { method: "POST", body: JSON.stringify(body) });
/** `PATCH /api/:t/clients/:id`. `contact` is a KEY-LEVEL MERGE on the backend (CC-D10): a string sets
 *  that key, `null` deletes it, an omitted key is left alone — so send only what the form owns.
 *  `ownerUserId`: omitted = unchanged, `null` = no owner. */
export const updateClient = (u: string, t: string, id: string, body: { name?: string; status?: string; contact?: Record<string, string | null>; ownerUserId?: string | null }) =>
  platformFetch<{ id: string }>(`/api/${t}/clients/${id}`, u, { method: "PATCH", body: JSON.stringify(body) });
// CC-D10 — notes + history. PV3-05: both answer a `ReadResult`. They used to degrade 403 AND 404 to []
// (skipUnavailable), which showed a denied read as "No notes yet". `absentAsEmpty` keeps the one honest
// absence (a backend that does not serve the route); a 403 is `forbidden`, anything else `unavailable`.
export const listClientNotes = (u: string, t: string, id: string): Promise<ReadResult<ClientNote[]>> =>
  readResult(platformFetch<ClientNote[]>(`/api/${t}/clients/${id}/notes`, u), { absentAsEmpty: [] });
export const listClientHistory = (u: string, t: string, id: string): Promise<ReadResult<ClientHistoryEntry[]>> =>
  readResult(platformFetch<ClientHistoryEntry[]>(`/api/${t}/clients/${id}/history`, u), { absentAsEmpty: [] });
export const createClientNote = (u: string, t: string, id: string, body: string) =>
  platformFetch<{ id: string }>(`/api/${t}/clients/${id}/notes`, u, { method: "POST", body: JSON.stringify({ body }) });
export const deleteClientNote = (u: string, t: string, id: string, noteId: string) =>
  platformFetch<{ ok: true }>(`/api/${t}/clients/${id}/notes/${noteId}`, u, { method: "DELETE" });
export const deleteClient = (u: string, t: string, id: string) =>
  platformFetch<{ ok: true }>(`/api/${t}/clients/${id}`, u, { method: "DELETE" });

function deliverablesPath(t: string, projectId?: string, clientId?: string): string {
  const q = new URLSearchParams();
  if (projectId) q.set("projectId", projectId);
  // PV3-05: the backend has filtered on `clientId` all along (client-work.controller.ts); this reader
  // never sent it, so the client hub fetched the whole tenant and narrowed in the browser.
  if (clientId) q.set("clientId", clientId);
  const qs = q.toString();
  return `/api/${t}/deliverables${qs ? `?${qs}` : ""}`;
}
export const listDeliverables = (u: string, t: string, projectId?: string, clientId?: string) =>
  skipUnavailable(platformFetch<Deliverable[]>(deliverablesPath(t, projectId, clientId), u), [] as Deliverable[]);
/** One client's deliverables, server-filtered, with a refusal kept distinct from "none" (the client
 *  hub's Projects area). `listDeliverables` above folds 403/404 into [] and stays for its old callers. */
export const listClientDeliverables = (u: string, t: string, clientId: string): Promise<ReadResult<Deliverable[]>> =>
  readResult(platformFetch<Deliverable[]>(deliverablesPath(t, undefined, clientId), u), { absentAsEmpty: [] });
export const createDeliverable = (u: string, t: string, body: { name: string; projectId?: string; clientId?: string; dueDate?: string; status?: string }) =>
  platformFetch<{ id: string }>(`/api/${t}/deliverables`, u, { method: "POST", body: JSON.stringify(body) });
export const createTimeEntry = (u: string, t: string, body: { minutes: number; projectId?: string; taskId?: string; billable: boolean; entryDate: string; notes?: string }) =>
  platformFetch<{ id: string }>(`/api/${t}/time-entries`, u, { method: "POST", body: JSON.stringify(body) });
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
// WSUX-4 typed contract (platform-nest src/core/http.ts NotificationPayload,
// FRONTEND-BFF-CONTRACT §9(c)): every row's payload now guarantees {title, href}
// plus optional body/entityType/entityId/severity. Additive — legacy keys (e.g.
// commentId, decision, approvalId) may still ride alongside for callers that
// read them directly, so the interface stays a Record<string, unknown> superset
// rather than narrowing away fields older/other readers depend on.
export interface NotificationPayload extends Record<string, unknown> {
  title?: string;
  href?: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  severity?: "info" | "warning" | "critical";
}
export interface NotificationItem { id: string; type: string; payload: NotificationPayload; read_at: string | null; created_at: string }

export const listComments = (u: string, t: string, entityType: string, entityId: string) =>
  skipUnavailable(platformFetch<Comment[]>(`/api/${t}/comments?entityType=${entityType}&entityId=${entityId}`, u), [] as Comment[]);
export const listNotifications = (u: string, t: string, unreadOnly = false) =>
  skipUnavailable(platformFetch<NotificationItem[]>(`/api/${t}/notifications${unreadOnly ? "?unread=true" : ""}`, u), [] as NotificationItem[]);

// ---- Files / attachments (5c.4 — endpoints exist) ----
export interface FileMeta { id: string; filename: string; content_type: string; byte_size: number; scrubbed: boolean; uploader_id: string | null; created_at: string }
export const listFiles = (u: string, t: string, entityType: string, entityId: string) =>
  skipUnavailable(platformFetch<FileMeta[]>(`/api/${t}/files?entityType=${entityType}&entityId=${entityId}`, u), [] as FileMeta[]);
// Attach a file reference (metadata + optional URL). True binary/multipart upload
// is a documented follow-up — see docs/FRONTEND-BFF-CONTRACT.md.
export const attachFile = (u: string, t: string, body: { entityType: string; entityId: string; filename: string; url?: string; content_type?: string }) =>
  platformFetch<{ id: string }>(`/api/${t}/files`, u, { method: "POST", body: JSON.stringify(body) });
export const deleteFile = (u: string, t: string, id: string) =>
  platformFetch<{ ok: true }>(`/api/${t}/files/${id}`, u, { method: "DELETE" });

// Generic threaded comments on any entity (task comments already flow through
// lib/pm). Reused for projects, etc.
export const postComment = (u: string, t: string, entityType: string, entityId: string, body: string) =>
  platformFetch<{ id: string }>(`/api/${t}/comments?entityType=${entityType}&entityId=${entityId}`, u, { method: "POST", body: JSON.stringify({ body }) });
