import "server-only";
// HR module data layer — cases (onboarding/offboarding/review/grievance/other),
// records (contract/document/note), leave (file/cancel/balances; deciding rides
// the existing automation-approvals decide endpoint — see lib/hrActions.ts),
// attendance (per-day upsert), and checklist templates. Backend is BUILT (see
// docs/FRONTEND-BFF-CONTRACT.md §10, `modules/hr/hr.controller.ts`) — every
// reader still DEGRADES gracefully (empty on 404/403) so this ships safely even
// against a company where the 'hr' module isn't enabled/served — same pattern
// as lib/it.ts and lib/pm.ts.
//
// BFF CONTRACT (already built, mounted /api/:t/modules/hr/*):
//   GET/POST   /api/:t/modules/hr/cases[?kind&status&subjectUserId]  -> HrCase[] / {id}
//   GET/PATCH/DELETE /api/:t/modules/hr/cases/:id                   -> HrCase | {ok}
//   POST       /api/:t/modules/hr/cases/:id/cancel                  -> {ok}
//   PATCH      /api/:t/modules/hr/cases/:id/checklist  {items}       -> {ok}
//   GET/POST   /api/:t/modules/hr/records[?subjectUserId&recordType] -> HrRecord[] / {id}
//   PATCH/DELETE /api/:t/modules/hr/records/:id                     -> {ok}
//   GET        /api/:t/modules/hr/records/export                    -> HrRecord[] (D4 high-assurance gate)
//   GET/POST   /api/:t/modules/hr/leave[?status&subjectUserId]       -> HrLeaveRequest[] / {id}
//   POST       /api/:t/modules/hr/leave/:id/cancel                  -> {ok}
//   GET        /api/:t/modules/hr/leave/balances[?subjectUserId&year] -> HrLeaveBalance[]
//   GET/POST   /api/:t/modules/hr/attendance[?subjectUserId&from&to] -> HrAttendance[] / {id}
//   GET/POST   /api/:t/modules/hr/checklist-templates[?kind]        -> ChecklistTemplate[] / {id}
//   POST       /api/:t/modules/hr/onboarding/instantiate {subjectUserId,kind} -> {id}
// Deciding leave: POST /api/:t/automation-approvals/:id/decide {decision,note?}
// (existing generic endpoint — see lib/hrActions.ts `decideHrLeave`).
import { platformFetch, PlatformError, type Me } from "./platform";
import { isElevated, can } from "./rbac";

// ---------------- Types ----------------
export type HrCaseKind = "onboarding" | "offboarding" | "review" | "grievance" | "other";
export const HR_CASE_KINDS: HrCaseKind[] = ["onboarding", "offboarding", "review", "grievance", "other"];
export type HrCaseStatus = "open" | "in_progress" | "done" | "cancelled";
export const HR_CASE_STATUSES: HrCaseStatus[] = ["open", "in_progress", "done", "cancelled"];

export interface ChecklistItem { label: string; done: boolean; doneBy?: string | null; doneAt?: string | null }
export interface ReviewDetails { period?: string; goals?: string; outcome?: string }

export interface HrCase {
  id: string;
  subjectUserId: string | null;
  subjectName?: string | null;
  kind: HrCaseKind;
  status: HrCaseStatus;
  title: string;
  details: { items?: ChecklistItem[] } & ReviewDetails & Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type HrRecordType = "contract" | "document" | "note";
export interface HrRecord {
  id: string;
  subjectUserId: string;
  subjectName?: string | null;
  recordType: HrRecordType;
  data: Record<string, unknown>;
  fileId?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type LeaveType = "vacation" | "sick" | "unpaid" | "other";
export const LEAVE_TYPES: LeaveType[] = ["vacation", "sick", "unpaid", "other"];
export type LeaveStatus = "pending" | "approved" | "denied" | "cancelled";

export interface HrLeaveRequest {
  id: string;
  subjectUserId: string;
  subjectName?: string | null;
  leaveType: LeaveType;
  startsOn: string; // yyyy-mm-dd
  endsOn: string;
  minutes: number; // canonical unit; a full day = 480 by convention
  note?: string | null;
  status: LeaveStatus;
  approvalId?: string | null; // the automation_approvals row (origin='hr') this rides on
  decidedBy?: string | null;
  decidedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrLeaveBalance {
  id: string;
  subjectUserId: string;
  subjectName?: string | null;
  year: number;
  leaveType: LeaveType;
  allocatedMinutes: number;
  usedMinutes: number;
}

export type AttendanceStatus = "present" | "remote" | "absent" | "leave";
export const ATTENDANCE_STATUSES: AttendanceStatus[] = ["present", "remote", "absent", "leave"];
export interface HrAttendance {
  id: string;
  subjectUserId: string;
  subjectName?: string | null;
  day: string; // yyyy-mm-dd
  status: AttendanceStatus;
  note?: string | null;
  recordedBy: string;
}

export interface ChecklistTemplateItem { label: string }
export interface ChecklistTemplate {
  id: string;
  kind: "onboarding" | "offboarding";
  name: string;
  items: ChecklistTemplateItem[];
  isDefault: boolean;
}

// Mirrors lib/it.ts / lib/pm.ts: absorb 404 (module not enabled/served here) and
// 403 (not authorized) into a graceful empty fallback.
async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

function qs(params: Record<string, string | number | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
}

// ---------------- Readers (single company) ----------------
// Two flavors per list: the degrading one (default export, used for personal/
// single-tenant reads — a company with the module off just looks empty, no
// envelope concept applies there per UX-2 §4.3) and a `raw*` sibling that lets
// a 403/404 THROW. `fanOutHr` (below) needs the raw form: a fan-out leg that
// fails must be tagged excluded-with-reason, never silently collapsed into an
// empty-but-"included" result — that would be exactly the silent-drop the
// inclusion envelope exists to prevent (owner decision 4, UX-2 §4).
const rawListCases = (u: string, t: string, q: { kind?: HrCaseKind; status?: HrCaseStatus; subjectUserId?: string } = {}) =>
  platformFetch<HrCase[]>(`/api/${t}/modules/hr/cases${qs(q)}`, u);
export const listCases = (u: string, t: string, q: { kind?: HrCaseKind; status?: HrCaseStatus; subjectUserId?: string } = {}) =>
  skipUnavailable(rawListCases(u, t, q), [] as HrCase[]);
export { rawListCases };

export async function getCase(u: string, t: string, id: string): Promise<HrCase | null> {
  try {
    return await platformFetch<HrCase>(`/api/${t}/modules/hr/cases/${id}`, u);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

export const listRecords = (u: string, t: string, q: { subjectUserId?: string; recordType?: HrRecordType } = {}) =>
  skipUnavailable(platformFetch<HrRecord[]>(`/api/${t}/modules/hr/records${qs(q)}`, u), [] as HrRecord[]);

export const exportRecords = (u: string, t: string, q: { subjectUserId?: string; recordType?: HrRecordType } = {}) =>
  skipUnavailable(platformFetch<HrRecord[]>(`/api/${t}/modules/hr/records/export${qs(q)}`, u), [] as HrRecord[]);

const rawListLeave = (u: string, t: string, q: { status?: LeaveStatus; subjectUserId?: string } = {}) =>
  platformFetch<HrLeaveRequest[]>(`/api/${t}/modules/hr/leave${qs(q)}`, u);
export const listLeave = (u: string, t: string, q: { status?: LeaveStatus; subjectUserId?: string } = {}) =>
  skipUnavailable(rawListLeave(u, t, q), [] as HrLeaveRequest[]);
export { rawListLeave };

export const listLeaveBalances = (u: string, t: string, q: { subjectUserId?: string; year?: number } = {}) =>
  skipUnavailable(platformFetch<HrLeaveBalance[]>(`/api/${t}/modules/hr/leave/balances${qs(q)}`, u), [] as HrLeaveBalance[]);

const rawListAttendance = (u: string, t: string, q: { subjectUserId?: string; from?: string; to?: string } = {}) =>
  platformFetch<HrAttendance[]>(`/api/${t}/modules/hr/attendance${qs(q)}`, u);
export const listAttendance = (u: string, t: string, q: { subjectUserId?: string; from?: string; to?: string } = {}) =>
  skipUnavailable(rawListAttendance(u, t, q), [] as HrAttendance[]);
export { rawListAttendance };

export const listChecklistTemplates = (u: string, t: string, q: { kind?: "onboarding" | "offboarding" } = {}) =>
  skipUnavailable(platformFetch<ChecklistTemplate[]>(`/api/${t}/modules/hr/checklist-templates${qs(q)}`, u), [] as ChecklistTemplate[]);

// ---------------- Pure helpers (unit-tested) ----------------
export function checklistProgress(c: Pick<HrCase, "details">): { done: number; total: number } {
  const items = c.details?.items ?? [];
  return { done: items.filter((i) => i.done).length, total: items.length };
}

// ---------------- Shared-service company scope (HR-staff company selector) ----------------
// Built directly from Me.serviceScopes per WSD-5 (the generic scope-pill
// primitive, ORG-13, isn't built yet). This is the TEAM/aggregate view's
// reachable set (leave queue, attendance roster, onboarding board, case list) —
// companies where the viewer holds hr.view (own company as hr_staff/hr_manager/
// company_admin, or full elevation) UNION any company served for the 'hr'
// module via a reconciler-materialized service assignment. Personal
// self-service (own leave/attendance/cases) is NOT gated by this — it always
// works against the active tenant regardless of hr.view (design §2.2 `member`
// self-service), so an empty result here only hides the team-facing surfaces.
export interface HrScopeCompany { id: string; name: string; role: "home" | "staff" | "manager" }

export function hrScopeCompanies(me: Me, tenant: string | null): HrScopeCompany[] {
  const map = new Map<string, HrScopeCompany>();
  const elevated = isElevated(me);
  for (const c of me.companies) {
    if (elevated || can(me, "hr.view", c.id)) {
      map.set(c.id, { id: c.id, name: c.name, role: "home" });
    }
  }
  for (const s of me.serviceScopes ?? []) {
    if (s.module !== "hr") continue;
    const role: HrScopeCompany["role"] = s.role === "manager" ? "manager" : "staff";
    const existing = map.get(s.companyId);
    if (!existing) map.set(s.companyId, { id: s.companyId, name: s.companyName, role });
    // A home grant + a service grant on the same company: keep "home" (it's
    // already a full member there) but note the higher of the two service roles.
    else if (existing.role === "staff" && role === "manager") existing.role = "manager";
  }
  // Always surface the active tenant first when it's part of the reachable set
  // (predictable default before "all"), else in insertion order.
  return [...map.values()].sort((a, b) => (a.id === tenant ? -1 : b.id === tenant ? 1 : 0));
}

// True when the served set is worth offering a selector at all (matches the
// existing canSwitchCompany / ScopePill §4.3 "single company -> static label" rule).
export function hasHrScopeChoice(companies: HrScopeCompany[]): boolean {
  return companies.length > 1;
}

// ---------------- Inclusion envelope (fan-out across the served-company scope) ----------------
// Same canonical shape UX-2 §4.2 specifies for every ALL-scope fan-out, kept
// local to HR (not the shared lib/envelope.ts primitive — ORG-13 hasn't shipped
// it) so a future swap onto the generic ScopePill is a pure rename.
export interface HrEnvelopeCompany {
  id: string; name: string; included: boolean; reason?: "no_access" | "not_served" | "suspended" | "error";
}
export interface HrEnvelope<T> { items: T[]; companies: HrEnvelopeCompany[] }

// Runs `fetchOne` against every company in scope and merges into one Envelope.
// A failing leg is NEVER silently dropped — it is tagged `included:false` with
// a reason and counted, so the UI can render "N more you can't view" instead of
// quietly shrinking the list (owner decision 4, UX-2). IMPORTANT: pass a `raw*`
// reader here, not the degrading default export — the degrading ones already
// swallow 403/404 into a successful `[]`, which would make every failing leg
// look identical to "no rows" and defeat the whole point of the envelope.
export async function fanOutHr<T>(
  companies: HrScopeCompany[],
  fetchOne: (companyId: string) => Promise<T[]>,
): Promise<HrEnvelope<T & { tenantId: string; tenantName: string }>> {
  const legs = await Promise.all(
    companies.map(async (c) => {
      try {
        const rows = await fetchOne(c.id);
        return { c, ok: true as const, rows: rows.map((r) => ({ ...r, tenantId: c.id, tenantName: c.name })) };
      } catch (e) {
        const reason: HrEnvelopeCompany["reason"] =
          e instanceof PlatformError && e.status === 403 ? "no_access" :
          e instanceof PlatformError && e.status === 404 ? "not_served" : "error";
        return { c, ok: false as const, rows: [], reason };
      }
    }),
  );
  return {
    items: legs.flatMap((l) => l.rows),
    companies: legs.map((l) => ({ id: l.c.id, name: l.c.name, included: l.ok, reason: l.ok ? undefined : l.reason })),
  };
}

// Resolves the requested `?company=` search param against the reachable scope,
// defaulting to "all" when the user has hr.view/serves more than one HR
// company (owner decision 4) and to that single company otherwise. An
// unreachable/unknown value falls back to the same default rather than
// silently widening scope to something the caller never asked to see.
export function resolveHrScopeParam(requested: string | undefined, companies: HrScopeCompany[]): "all" | string {
  const fallback: "all" | string = hasHrScopeChoice(companies) ? "all" : (companies[0]?.id ?? "all");
  if (!requested) return fallback;
  if (requested === "all") return fallback === "all" || companies.length > 1 ? "all" : fallback;
  return companies.some((c) => c.id === requested) ? requested : fallback;
}
