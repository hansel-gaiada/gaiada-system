// ORG-7b — `GET /api/me` `serviceScopes`: companies the caller has SERVICE (reconciler-
// materialized) access into, for the UX-2 company-selector "served companies" badging (§4.4:
// "the department's serviceScopes-derived served-company set"). Read-only, additive to Me.
//
// Deliberately does NOT trust the `managed_by` marker alone as the liveness signal (A2: managed_by
// is a marker, "NOT the single source of liveness... AUTHORITATIVE liveness is the claims count").
// A grant's managed_by column is stamped once at creation and never updated afterward, so if a
// SECOND assignment's claim is the one still keeping an old grant alive (the first assignment
// having since been suspended), trusting managed_by directly would misreport which assignment(s)
// back it. Instead: use user_roles.managed_by only to size the CANDIDATE target-tenant set (cheap,
// global, no RLS needed), then re-derive the actual live scopes from service_grant_claims joined to
// service_assignments.status='active' — the exact artifacts service-reconciler.ts itself treats as
// authoritative — under RLS scoped to those candidate targets.
//
// Hardening (architect gate, pre-flip): the candidate set above is sized from user_roles alone —
// a marker that is stamped once and never updated (see above), so a grant can go stale (its
// backing company_memberships row torn down or suspended by some path other than the
// reconciler's own clear-managed_by-on-full-suspend sequence) while managed_by stays NOT NULL.
// Passing that raw candidate set to withTenants() would widen the RLS tenant GUC to include
// that stale company for the lifetime of the call, BEFORE the sa.status='active' SQL filter
// below ever runs -- the widening is in what the GUC permits the connection to see, not just in
// what this query happens to return. Fix: INTERSECT the candidates with `liveCompanyIds` (the
// caller's live company_memberships, i.e. principal.companies -- assembled independently in
// rbac/principal.ts) before it is ever used to size the GUC. The resulting targetIds is
// therefore always a subset of the caller's own already-authorized tenant set.
import { withGlobal, withTenants } from "../db";
import { config } from "../config";

export interface ServiceScope {
  companyId: string;
  companyName: string;
  assignmentId: string;
  module: string;
  unitName: string;
  role: "staff" | "manager";
}

export async function getServiceScopes(userId: string | null, liveCompanyIds: string[]): Promise<ServiceScope[]> {
  if (!config.serviceAssignmentsEnabled || !userId) return [];

  const candidates = await withGlobal((c) =>
    c.query<{ scope_id: string }>(
      `SELECT DISTINCT scope_id FROM user_roles
       WHERE user_id = $1 AND managed_by IS NOT NULL AND scope_type = 'company' AND scope_id IS NOT NULL`,
      [userId],
    ),
  );
  // Intersect with the caller's live company memberships (principal.companies) — see the file
  // header. A stale managed_by grant whose backing membership is gone can no longer widen the
  // GUC below beyond what the caller is already independently authorized into.
  const liveSet = new Set(liveCompanyIds);
  const targetIds = candidates.rows.map((r) => r.scope_id).filter((id) => liveSet.has(id));
  if (!targetIds.length) return [];

  // Re-verify under RLS scoped to exactly the candidate targets (sa_select's dual-side policy
  // permits the target to see its own served-by rows). Only claims backed by a currently-'active'
  // assignment count — this is the authoritative liveness check, not the managed_by marker above.
  const rows = await withTenants(targetIds, (c) =>
    c.query<{
      company_id: string;
      module_key: string;
      unit_name: string;
      role_name: string;
      assignment_id: string;
    }>(
      `SELECT DISTINCT sa.target_tenant_id AS company_id, sa.module_key, sa.unit_name,
              r.name AS role_name, sa.id AS assignment_id
       FROM service_grant_claims sgc
       JOIN service_assignments sa ON sa.id = sgc.assignment_id
       JOIN user_roles ur ON ur.id = sgc.user_role_id
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND sa.target_tenant_id = ANY($2::uuid[]) AND sa.status = 'active'`,
      [userId, targetIds],
    ),
  );
  if (!rows.rows.length) return [];

  const companyIds = [...new Set(rows.rows.map((r) => r.company_id))];
  const companies = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [companyIds],
    ),
  );
  const nameById = new Map(companies.rows.map((r) => [r.id, r.name]));

  return rows.rows.map((r) => ({
    companyId: r.company_id,
    companyName: nameById.get(r.company_id) ?? "",
    assignmentId: r.assignment_id,
    module: r.module_key,
    unitName: r.unit_name,
    role: r.role_name.endsWith("_manager") ? "manager" : "staff",
  }));
}
