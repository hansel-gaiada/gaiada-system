import "server-only";
// Service-assignment data layer (ORG-13) — "connect a department/division to
// serve another company's module", per docs/superpowers/plans/
// 2026-07-17-backbone-program-plan.md ORG-7/ORG-7b and
// docs/FRONTEND-BFF-CONTRACT.md §2. Backend is BUILT (`service-assignments.
// controller.ts`) but the whole surface is gated end-to-end behind
// `SERVICE_ASSIGNMENTS_ENABLED` (default OFF) — every write 409s while off and
// every list reader here degrades to an empty result, matching the backend's
// own "byte-for-byte prior behavior while off" posture. `SERVICE_ASSIGNMENTS_
// ENABLED` in THIS file is the UI-side mirror of that same flag (so the
// Connect-service affordance / ServicedBlock / admin accept screen don't even
// render when the feature is off), not an independent gate — flipping one
// without the other just means the UI hides something the backend would 409
// anyway, never the reverse.
//
// BFF CONTRACT (§2, all mounted under /api/:t/org-structure/*):
//   POST   units/:nodeId/assignments[?dryRun=1] {targets,module,leadUserId?}
//          -> 201 {assignments:[{id,target,status}]} | dryRun: {dryRun:true,unit,items,companies}
//   POST   assignments/:id/accept                 -> 200 {ok,status:'active'}
//   DELETE assignments/:id                         -> 200 {ok,status:'revoked'}
//   PATCH  assignments/:id/suspend | /resume       -> 200 {ok,status}
//   PATCH  assignments/:id {nodeId}                -> 200 {ok,status,reconsentRequired} (re-link)
//   POST   assignments/:id/reconcile               -> 200 ReconcileResult
//   POST   reconcile                               -> 200 {results:ReconcileResult[]}
//   GET    assignments?direction=provided|served&companyIds=&status=
//          -> 200 Envelope<AssignmentSummary>
//   GET    service-units?companyIds=               -> 200 Envelope<ServiceUnitRow>
// Plus Me.serviceScopes (lib/platform.ts, additive) and
// GET /api/:t/members?includeService=1 (lib/entities.ts territory, not this file).
//
// AssignmentSummary field names are inferred from the contract doc's own prose
// (A8 denormalized unit_name/unit_kind/unit_status, A12 lead_user_id, the
// propose response's {id,target,status}) since the controller source itself
// wasn't in this ticket's read scope — treat as the UI-canonical shape per the
// doc's own convention, and reconcile against the live backend's actual field
// names on first real-backend wiring (flagged in the ORG-13 handoff).
import { platformFetch, PlatformError, type Me, type ServiceScope } from "./platform";
import { normalizeEnvelope, type Envelope, type EnvelopeCompany } from "./envelope";

export const SERVICE_ASSIGNMENTS_ENABLED = process.env.SERVICE_ASSIGNMENTS_ENABLED === "1";

// Known module keys a service assignment can target. Mirrors the owner-locked
// core-vs-module split (backbone plan §"Locked owner decisions") — hardcoded
// until WSA-3's `GET /api/modules` registry endpoint ships; swap then.
export const SERVICE_MODULE_OPTIONS = ["hr", "it", "pm", "billing", "clients", "knowledge", "automation-console"] as const;
export type ServiceModule = (typeof SERVICE_MODULE_OPTIONS)[number];

export type AssignmentStatus = "proposed" | "active" | "suspended" | "revoked";
export type UnitStatus = "active" | "orphaned";

export interface AssignmentSummary {
  id: string;
  providerTenantId: string;
  providerCompanyName?: string;
  targetTenantId: string;
  targetCompanyName?: string;
  unitId: string; // the org-structure node id (denormalized onto the row, A8)
  unitName: string;
  unitKind: string;
  unitStatus: UnitStatus;
  module: string;
  status: AssignmentStatus;
  leadUserId?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface ServiceUnitRow {
  unitId: string;
  nodeId: string;
  name: string;
  kind: string;
  status: UnitStatus;
  servedCompanyCount: number;
  modules: string[];
  providerTenantId: string;
}

export interface StaffPreviewRow {
  userId: string;
  name: string;
  email: string;
  role: "staff" | "manager";
}

export interface DryRunResult {
  dryRun: true;
  unit: { nodeId: string; name: string; kind: string };
  items: StaffPreviewRow[];
  companies: EnvelopeCompany[];
}

export interface ProposeResult {
  assignments: { id: string; target: string; status: AssignmentStatus }[];
}

export interface ReconcileResult {
  assignmentId: string;
  status: string;
  granted: number;
  revoked: number;
  orphaned: number;
  skipped: number;
  affectedUsers: number;
}

export interface ActionResult {
  ok: boolean;
  status?: string;
  reconsentRequired?: boolean;
  error?: string;
}

function qs(params: Record<string, string | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : "";
}

// The feature is OFF (409) or genuinely absent (404) or the caller lacks
// visibility (403) — every one of these means "nothing to show here", never a
// crash. Mirrors lib/hr.ts's `skipUnavailable`, plus 409 for the flag-off case.
async function degrade<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403 || e.status === 409)) return fallback;
    throw e;
  }
}

// ---------------- Readers (degrade to an empty envelope) ----------------

export async function listAssignments(
  u: string,
  t: string,
  q: { direction: "provided" | "served"; companyIds?: string[]; status?: AssignmentStatus },
): Promise<Envelope<AssignmentSummary>> {
  if (!SERVICE_ASSIGNMENTS_ENABLED) return { items: [], companies: [] };
  const path = `/api/${t}/org-structure/assignments${qs({ direction: q.direction, companyIds: q.companyIds?.join(","), status: q.status })}`;
  const raw = await degrade(platformFetch<unknown>(path, u), { items: [], companies: [] });
  return normalizeEnvelope<AssignmentSummary>(raw);
}

export async function listServiceUnits(
  u: string,
  t: string,
  q: { companyIds?: string[] } = {},
): Promise<Envelope<ServiceUnitRow>> {
  if (!SERVICE_ASSIGNMENTS_ENABLED) return { items: [], companies: [] };
  const path = `/api/${t}/org-structure/service-units${qs({ companyIds: q.companyIds?.join(",") })}`;
  const raw = await degrade(platformFetch<unknown>(path, u), { items: [], companies: [] });
  return normalizeEnvelope<ServiceUnitRow>(raw);
}

// Assignments for one specific unit (a department/division node), from either
// side — a pure client-side filter over listAssignments (no dedicated backend
// filter-by-unit route exists; the list endpoint filters by direction/company
// only). Used by the Connect-service panel and the department ServicedBlock.
export async function listAssignmentsForUnit(
  u: string,
  t: string,
  nodeId: string,
  direction: "provided" | "served" = "provided",
): Promise<AssignmentSummary[]> {
  const env = await listAssignments(u, t, { direction });
  return env.items.filter((a) => a.unitId === nodeId);
}

// ---------------- Writers (throw PlatformError on failure — the caller is an
// explicit user action, e.g. inside the Connect-service dialog, and needs the
// real error message, not a silent empty result) ----------------

export async function dryRunConnectService(
  u: string,
  t: string,
  nodeId: string,
  body: { targets: string[]; module: string; leadUserId?: string },
): Promise<DryRunResult> {
  return platformFetch<DryRunResult>(
    `/api/${t}/org-structure/units/${nodeId}/assignments?dryRun=1`,
    u,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function proposeConnectService(
  u: string,
  t: string,
  nodeId: string,
  body: { targets: string[]; module: string; leadUserId?: string },
): Promise<ProposeResult> {
  return platformFetch<ProposeResult>(
    `/api/${t}/org-structure/units/${nodeId}/assignments`,
    u,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function acceptAssignment(u: string, t: string, id: string): Promise<{ ok: true; status: "active" }> {
  return platformFetch(`/api/${t}/org-structure/assignments/${id}/accept`, u, { method: "POST" });
}

export async function revokeAssignment(u: string, t: string, id: string): Promise<{ ok: true; status: "revoked" }> {
  return platformFetch(`/api/${t}/org-structure/assignments/${id}`, u, { method: "DELETE" });
}

export async function suspendAssignment(u: string, t: string, id: string): Promise<{ ok: true; status: string }> {
  return platformFetch(`/api/${t}/org-structure/assignments/${id}/suspend`, u, { method: "PATCH" });
}

export async function resumeAssignment(u: string, t: string, id: string): Promise<{ ok: true; status: string }> {
  return platformFetch(`/api/${t}/org-structure/assignments/${id}/resume`, u, { method: "PATCH" });
}

export async function relinkAssignment(
  u: string,
  t: string,
  id: string,
  nodeId: string,
): Promise<{ ok: true; status: string; reconsentRequired: boolean }> {
  return platformFetch(`/api/${t}/org-structure/assignments/${id}`, u, {
    method: "PATCH",
    body: JSON.stringify({ nodeId }),
  });
}

export async function reconcileAssignment(u: string, t: string, id: string): Promise<ReconcileResult> {
  return platformFetch(`/api/${t}/org-structure/assignments/${id}/reconcile`, u, { method: "POST" });
}

export async function reconcileProvider(u: string, t: string): Promise<{ results: ReconcileResult[] }> {
  return platformFetch(`/api/${t}/org-structure/reconcile`, u, { method: "POST" });
}

// ---------------- Pure helpers (unit-tested) ----------------

// Maps an assignment's lifecycle onto the inclusion-envelope vocabulary for
// "is this unit CURRENTLY serving this company" — active is the only
// included state; every other status is excluded-with-reason (never a blanket
// drop). `unitStatus==='orphaned'` overrides even an active assignment: the
// underlying org node is gone/changed kind, so nothing is really being served
// no matter what the assignment row still says.
export function assignmentInclusion(a: Pick<AssignmentSummary, "status" | "unitStatus">): { included: boolean; reason?: EnvelopeCompany["reason"] } {
  if (a.unitStatus === "orphaned") return { included: false, reason: "error" };
  switch (a.status) {
    case "active": return { included: true };
    case "suspended": return { included: false, reason: "suspended" };
    case "proposed": return { included: false, reason: "not_served" };
    case "revoked": return { included: false, reason: "not_served" };
    default: return { included: false, reason: "error" };
  }
}

// Companies a user SERVES (staff/manager via a reconciler-materialized grant),
// annotated with which module — feeds the company-switcher badge ("Viceroy ·
// via HR"). Mirrors lib/hr.ts's hrScopeCompanies but generic across modules,
// keyed by companyId with the FIRST module found (a company served via more
// than one module shows its first grant; good enough for a badge, not a
// scope-selector — surfaces that need the full set read `me.serviceScopes`
// directly, e.g. lib/hr.ts already does for module='hr').
export function servedCompanyBadge(me: Me, companyId: string): string | null {
  const scope = (me.serviceScopes ?? []).find((s) => s.companyId === companyId);
  return scope ? `via ${scope.module.toUpperCase()}` : null;
}

export function servedScopesByCompany(serviceScopes: ServiceScope[] | undefined): Map<string, ServiceScope[]> {
  const map = new Map<string, ServiceScope[]>();
  for (const s of serviceScopes ?? []) {
    const list = map.get(s.companyId) ?? [];
    list.push(s);
    map.set(s.companyId, list);
  }
  return map;
}
