import "server-only";
// Admin-SECTION data layer — Users & Roles, Identity Links, Modules & Custom
// Fields, Compliance Gates, Audit. Distinct from lib/admin.ts (the Systems
// console layer for bot/gateway/hub/agents/knowledge/automation status).
//
// Contract (see docs/superpowers/plans/2026-07-05-erp-ui-plan-4-admin-identity-fullstack.md,
// "Admin-API contract"): most write paths + a few extra reads are pending on
// the backend. Every read call here DEGRADES gracefully on 404/405
// (skipMissing / a fallback shape) but propagates 403 (not authorized) so
// pages can render the "limited to administrators" state; writes use
// gracefulWrite ({ok,error}) so pages can ship ahead of the backend and light
// up automatically once each endpoint lands.
import { platformFetch, PlatformError } from "./platform";
import { listMembers } from "./entities";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  title: string | null;
  status: string;
  roles: { grantId: string; role: string; scopeType: string; scopeId: string | null }[];
}

export interface RoleRow {
  id: string;
  name: string;
  company_id: string | null;
}

export interface IdentityLink {
  id: string;
  user_id: string;
  user_name: string | null;
  provider: string;
  external_id: string;
  verified_at: string | null;
}

export interface ComplianceGate {
  id: string;
  key: string;
  title: string;
  description: string;
  status: string;
  evidence_url: string | null;
}

export interface AuditEntry {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  verb: string;
  target_entity_type: string;
  target_entity_id: string | null;
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

export interface AuditFilters {
  verb?: string;
  actorId?: string;
  entityType?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface AdminActionState {
  ok: boolean;
  error?: string;
}

// Absorbs 404 (endpoint not found) and 405 (method not implemented yet —
// some write endpoints 405 until the backend lands the route at all). Does
// NOT absorb 403 (not authorized) — that must propagate so pages can render
// the "limited to administrators" state instead of a silently-empty list.
async function skipMissing<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405)) return fallback;
    throw e;
  }
}

// Shared shape for the graceful write actions (assign/revoke role, verify/
// unlink identity, module toggle, field-def CRUD, compliance-gate patch,
// session revoke). Never throws — pages render {ok,error} directly.
async function gracefulWrite(p: Promise<unknown>): Promise<AdminActionState> {
  try {
    await p;
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404 || e.status === 405) {
        return { ok: false, error: "Not available yet — the backend endpoint is pending." };
      }
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

// ---- Users & Roles ----
export async function listUsers(u: string, t: string): Promise<UserRow[]> {
  try {
    return await platformFetch<UserRow[]>(`/api/${t}/users`, u);
  } catch (e) {
    if (!(e instanceof PlatformError && (e.status === 404 || e.status === 405))) throw e;
  }
  const members = await listMembers(u, t);
  return members.map((m) => ({
    id: m.user_id,
    name: m.name,
    email: m.email,
    title: m.title,
    status: "active",
    roles: [],
  }));
}

export const listRoles = (u: string) => skipMissing(platformFetch<RoleRow[]>(`/api/roles`, u), [] as RoleRow[]);

export const assignRole = (
  u: string,
  t: string,
  userId: string,
  body: { roleId: string; scopeType: string; scopeId?: string },
) => gracefulWrite(platformFetch(`/api/${t}/users/${userId}/roles`, u, { method: "POST", body: JSON.stringify(body) }));

export const revokeRole = (u: string, t: string, userId: string, grantId: string) =>
  gracefulWrite(platformFetch(`/api/${t}/users/${userId}/roles/${grantId}`, u, { method: "DELETE" }));

// Real endpoint (D11 session revocation) — app-level, not tenant-scoped, not
// under /api. Still routed through gracefulWrite for a uniform action shape.
export const revokeSession = (u: string, userId: string) =>
  gracefulWrite(platformFetch(`/admin/users/${userId}/revoke`, u, { method: "POST" }));

// ---- Identity links ----
export const listIdentityLinks = (u: string, t: string) =>
  skipMissing(platformFetch<IdentityLink[]>(`/api/${t}/identity-links`, u), [] as IdentityLink[]);

export const verifyIdentityLink = (u: string, t: string, id: string) =>
  gracefulWrite(platformFetch(`/api/${t}/identity-links/${id}/verify`, u, { method: "POST" }));

export const unlinkIdentity = (u: string, t: string, id: string) =>
  gracefulWrite(platformFetch(`/api/${t}/identity-links/${id}`, u, { method: "DELETE" }));

// ---- Modules ----
export const setModuleEnabled = (u: string, t: string, module: string, enabled: boolean) =>
  gracefulWrite(
    platformFetch(`/api/${t}/company/modules`, u, { method: "PATCH", body: JSON.stringify({ module, enabled }) }),
  );

// ---- Custom field definitions (create is real; update/delete degrade) ----
export const createFieldDef = (
  u: string,
  t: string,
  body: { entityType: string; key: string; label: string; data_type: string; options?: string[]; required?: boolean },
) => gracefulWrite(platformFetch(`/api/${t}/custom-fields`, u, { method: "POST", body: JSON.stringify(body) }));

export const updateFieldDef = (u: string, t: string, id: string, body: Record<string, unknown>) =>
  gracefulWrite(platformFetch(`/api/${t}/custom-fields/${id}`, u, { method: "PATCH", body: JSON.stringify(body) }));

export const deleteFieldDef = (u: string, t: string, id: string) =>
  gracefulWrite(platformFetch(`/api/${t}/custom-fields/${id}`, u, { method: "DELETE" }));

// ---- Compliance gates ----
// The six launch gates from docs/superpowers/plans/2026-07-05-CHECKLIST.md —
// rendered as a real, useful checklist now; status persistence degrades
// until the backend table exists.
export const GATE_TEMPLATE: ComplianceGate[] = [
  {
    id: "G.1",
    key: "G.1",
    title: "Lawful basis + DPIA/LIA",
    description: "Lawful basis established and DPIA/LIA completed (not employee consent).",
    status: "open",
    evidence_url: null,
  },
  {
    id: "G.2",
    key: "G.2",
    title: "Monitoring notice + per-individual opt-out",
    description: "Monitoring notice issued and a working per-individual opt-out is in place.",
    status: "open",
    evidence_url: null,
  },
  {
    id: "G.3",
    key: "G.3",
    title: "Retention TTL + auto-purge",
    description: "Retention TTL configured with automatic purge enforced.",
    status: "open",
    evidence_url: null,
  },
  {
    id: "G.4",
    key: "G.4",
    title: "Day-one gate (crypto-shred + scrubber) passed",
    description: "The technical day-one gate — crypto-shred store and PAN/KTP scrubber — has passed.",
    status: "open",
    evidence_url: null,
  },
  {
    id: "G.5",
    key: "G.5",
    title: "WA ToS risk acceptance recorded",
    description: "WhatsApp Terms of Service risk acceptance has been recorded.",
    status: "open",
    evidence_url: null,
  },
  {
    id: "G.6",
    key: "G.6",
    title: "Legal counsel engaged (jurisdiction/PCI)",
    description: "Legal counsel engaged on jurisdiction and PCI considerations.",
    status: "open",
    evidence_url: null,
  },
];

export async function listComplianceGates(u: string, t: string): Promise<ComplianceGate[]> {
  try {
    return await platformFetch<ComplianceGate[]>(`/api/${t}/compliance-gates`, u);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405)) return GATE_TEMPLATE;
    throw e;
  }
}

export const patchComplianceGate = (
  u: string,
  t: string,
  id: string,
  body: { status?: string; evidence_url?: string | null },
) => gracefulWrite(platformFetch(`/api/${t}/compliance-gates/${id}`, u, { method: "PATCH", body: JSON.stringify(body) }));

// ---- Audit ----
interface ActivityRow {
  id: string;
  actor_id?: string | null;
  actor_name?: string | null;
  verb?: string;
  action?: string;
  target_entity_type?: string;
  entity_type?: string;
  target_entity_id?: string | null;
  entity_id?: string | null;
  occurred_at?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

function toAuditEntry(row: ActivityRow): AuditEntry {
  return {
    id: row.id,
    actor_id: row.actor_id ?? null,
    actor_name: row.actor_name ?? null,
    verb: row.verb ?? row.action ?? "",
    target_entity_type: row.target_entity_type ?? row.entity_type ?? "",
    target_entity_id: row.target_entity_id ?? row.entity_id ?? null,
    occurred_at: row.occurred_at ?? row.created_at ?? "",
    metadata: row.metadata,
  };
}

// Pure — filters an already-fetched list of audit rows client-side. Used by
// getAudit's activity-endpoint fallback, and independently testable.
export function applyAuditFilters(rows: AuditEntry[], filters: AuditFilters): AuditEntry[] {
  return rows.filter((row) => {
    if (filters.verb && row.verb !== filters.verb) return false;
    if (filters.actorId && row.actor_id !== filters.actorId) return false;
    if (filters.entityType && row.target_entity_type !== filters.entityType) return false;
    if (filters.since && row.occurred_at < filters.since) return false;
    if (filters.until && row.occurred_at > filters.until) return false;
    return true;
  });
}

export async function getAudit(u: string, t: string, filters: AuditFilters = {}): Promise<AuditEntry[]> {
  const qs = new URLSearchParams();
  if (filters.verb) qs.set("verb", filters.verb);
  if (filters.actorId) qs.set("actorId", filters.actorId);
  if (filters.entityType) qs.set("entityType", filters.entityType);
  if (filters.since) qs.set("since", filters.since);
  if (filters.until) qs.set("until", filters.until);
  if (filters.limit) qs.set("limit", String(filters.limit));

  try {
    return await platformFetch<AuditEntry[]>(`/api/${t}/audit?${qs.toString()}`, u);
  } catch (e) {
    if (!(e instanceof PlatformError && (e.status === 404 || e.status === 405))) throw e;
  }
  const rows = await skipMissing(
    platformFetch<ActivityRow[]>(`/api/${t}/activity?limit=${filters.limit ?? 50}`, u),
    [] as ActivityRow[],
  );
  return applyAuditFilters(rows.map(toAuditEntry), filters);
}
