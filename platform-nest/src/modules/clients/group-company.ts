// PV3-04 (PV-D2): the same-root rule for `clients.group_company_id`.
//
// ── WHY THIS LIVES IN THE APP ───────────────────────────────────────────────────────────────────
// `companies` is a GLOBAL table with no row-level security, so the foreign key on
// `clients.group_company_id` proves only that the company exists — an FK check runs as the table owner,
// outside RLS, and would accept a company of another group. Whether the target is one of OUR companies
// (same `root_company_id` as the client's own tenant) has to be asked of `companies` itself, through
// `withGlobal`, exactly as `resolveGithubOrgTenant` (core/github-org-tenant.ts) does for the GitHub org.
//
// ── ORDER, AND WHO MAY ASK ──────────────────────────────────────────────────────────────────────
// This runs only AFTER the caller has been authorized (`isPlatformOperator`, admin/elevated.ts) — the
// controller checks that first, so a caller who may not touch the field gets a 403 and never learns
// whether the target company exists or which group it belongs to (the validation-preempts-authz trap).
//
// Each refusal is a 400 whose message IS the typed code, with `field: "groupCompanyId"`.
import { BadRequestException } from "@nestjs/common";
import { withGlobal } from "../../db";

export type GroupCompanyRefusal = "group_company_self" | "group_company_not_found" | "group_company_other_root";

export type GroupCompanyCheck =
  | { ok: true; id: string; name: string }
  | { ok: false; code: GroupCompanyRefusal };

/** Resolve `targetId` against the client's tenant. Pure of side effects; the caller decides whether to throw. */
export async function checkGroupCompany(tenantId: string, targetId: string): Promise<GroupCompanyCheck> {
  // A company is never its own client (PV-D10): refused before any query, and again by the table CHECK.
  if (targetId === tenantId) return { ok: false, code: "group_company_self" };
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string; name: string; same_root: boolean }>(
      `SELECT tgt.id, tgt.name,
              (tgt.root_company_id IS NOT NULL AND tgt.root_company_id = own.root_company_id) AS same_root
         FROM companies tgt, companies own
        WHERE tgt.id = $1 AND own.id = $2
          AND tgt.deleted_at IS NULL AND own.deleted_at IS NULL`,
      [targetId, tenantId],
    ),
  );
  // A missing row (either id does not resolve to a live company) is "not found"; a live company with a
  // different root is its own code, so an operator can tell a typo from a cross-group link.
  if (!rows[0]) return { ok: false, code: "group_company_not_found" };
  if (!rows[0].same_root) return { ok: false, code: "group_company_other_root" };
  return { ok: true, id: rows[0].id, name: rows[0].name };
}

/** `checkGroupCompany`, throwing the typed 400 on refusal. Returns the company's name for the History diff. */
export async function assertGroupCompany(tenantId: string, targetId: string): Promise<{ id: string; name: string }> {
  const r = await checkGroupCompany(tenantId, targetId);
  if (!r.ok) throw new BadRequestException({ message: r.code, field: "groupCompanyId" });
  return { id: r.id, name: r.name };
}
