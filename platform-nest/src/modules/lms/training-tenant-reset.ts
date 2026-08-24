// The training-tenant reset — "delete when finish", implemented as a bounded reset.
//
// Design: docs/blueprints/lms-foundation.md §9, and the migration header of
// 202608241550_lms_l2_general_track_and_training_tenant.sql which states the reasoning in the
// schema rather than only in prose.
//
// ── THIS FILE DELETES PRODUCTION ROWS. THE SAFETY IS STRUCTURAL, NOT PROCEDURAL ────────────────
// Four properties, each of which has to hold on its own:
//
//   1. THE TENANT IS RESOLVED, NEVER PASSED IN. `resolveTrainingTenant()` reads
//      `companies.is_training`, which a partial unique index limits to one row. There is no
//      parameter to get wrong. An interface that accepted a tenant id would be one typo from
//      clearing a real company, and no amount of care fixes an interface shaped like that.
//
//   2. THE TABLE SET IS AN ALLOW-LIST IN THE DATABASE, never derived. `lms_training_reset_tables`
//      is read at run time. The runner NEVER consults information_schema, and never falls back to
//      "everything with this tenant_id" — that is the 186-table cascade wearing a different hat,
//      and it grows teeth silently the next time a module adds a table.
//
//   3. TABLE NAMES ARE VALIDATED AGAINST THE ALLOW-LIST BEFORE INTERPOLATION. A table name cannot
//      be a bind parameter, so it is interpolated — which means the allow-list is also the
//      injection boundary. Every name is re-checked against a strict identifier pattern anyway,
//      because "it came from our own table" is exactly the reasoning that makes the next person
//      comfortable adding a code path where it did not.
//
//   4. EVERY RUN IS RECORDED, WITH PER-TABLE COUNTS. `lms_training_resets` is append-only. A total
//      would hide the table that matched zero rows when it should have matched hundreds — which is
//      how the RLS zero-row trap presents: the delete runs, affects nothing, and reports success.
//
// ── THE ZERO-ROW TRAP IS THE REAL RISK HERE, NOT OVER-DELETION ────────────────────────────────
// Each allow-listed table records the module scope its RLS policy demands. Open the wrong scope and
// the DELETE matches nothing and reports success, leaving a "reset" tenant full of the previous
// cohort's work. So the runner opens the scopes the allow-list asks for, and the caller is expected
// to read `rowCounts` rather than trust the absence of an error.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../db";
import { revokeGrantById } from "../../admin/grant-write.service";

/** Postgres identifier, conservatively. The allow-list is the boundary; this is the second lock. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

export interface ResetTable {
  tableName: string;
  moduleScope: string | null;
  rationale: string;
  deleteOrder: number;
}

export interface ResetPlan {
  tenantId: string;
  companyName: string;
  cohortId: string | null;
  tables: ResetTable[];
  /** Rows that WOULD be deleted, per table. Counted with the same scopes the delete will use. */
  rowCounts: Record<string, number>;
  /** Cohort members still holding grants in the training tenant. */
  liveMembers: number;
}

export interface ResetResult extends ResetPlan {
  mode: "dry_run" | "executed";
  deleted: Record<string, number>;
  grantsRevoked: number;
  resetRunId: string;
}

/**
 * The one training tenant, or nothing.
 *
 * `withGlobal` is correct here and is NOT the trap 0028's header warns about: `companies` is a core
 * table with no module predicate, and this reads no tenant-scoped row. The trap is
 * `set_config(..., true)` inside withGlobal, which is a no-op — there is no set_config here.
 */
export async function resolveTrainingTenant(): Promise<{ id: string; name: string } | null> {
  const r = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE is_training AND deleted_at IS NULL`,
    ),
  );
  if (r.rows.length > 1) {
    // Cannot happen while ux_companies_one_training exists. Checked anyway: if the index is ever
    // dropped, the failure this prevents is clearing two companies instead of one.
    throw new Error(
      `${r.rows.length} companies are flagged is_training. There must be exactly one — refusing to ` +
      `guess which one to clear.`,
    );
  }
  return r.rows[0] ?? null;
}

/** The allow-list, validated. Read fresh on every run so a change is never stale in a cache. */
export async function loadResetAllowList(): Promise<ResetTable[]> {
  const r = await withGlobal((c) =>
    c.query<{ table_name: string; module_scope: string | null; rationale: string; delete_order: number }>(
      `SELECT table_name, module_scope, rationale, delete_order
         FROM lms_training_reset_tables WHERE is_active ORDER BY delete_order, table_name`,
    ),
  );
  for (const row of r.rows) {
    if (!SAFE_IDENT.test(row.table_name)) {
      throw new Error(`allow-list entry is not a safe identifier: ${JSON.stringify(row.table_name)}`);
    }
    if (row.module_scope !== null && !SAFE_IDENT.test(row.module_scope)) {
      throw new Error(`allow-list module scope is not a safe identifier: ${JSON.stringify(row.module_scope)}`);
    }
  }
  return r.rows.map((row) => ({
    tableName: row.table_name,
    moduleScope: row.module_scope,
    rationale: row.rationale,
    deleteOrder: row.delete_order,
  }));
}

/**
 * Count what a reset would clear, table by table, using the SAME scopes the delete will use.
 *
 * Deliberately not one query with one broad scope: a count taken under a scope the delete will not
 * hold is a number about a different world, and it would report "0 rows to clear" for exactly the
 * tables the delete is about to miss.
 */
async function countPerTable(tenantId: string, tables: ResetTable[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const modules = t.moduleScope ? [t.moduleScope, "lms"] : ["lms"];
    out[t.tableName] = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t.tableName}`);
        return Number(r.rows[0].n);
      },
      { modules },
    );
  }
  return out;
}

export async function planTrainingReset(cohortId?: string | null): Promise<ResetPlan> {
  const tenant = await resolveTrainingTenant();
  if (!tenant) {
    throw new Error(
      "no company is flagged is_training. Nothing to reset — and nothing will be guessed at. " +
      "Set companies.is_training on the training company first.",
    );
  }
  const tables = await loadResetAllowList();
  const rowCounts = await countPerTable(tenant.id, tables);
  const liveMembers = await withTenants(
    [tenant.id],
    async (c) => {
      const r = await c.query<{ n: string }>(
        cohortId
          ? `SELECT count(*)::text AS n FROM lms_cohort_members WHERE cohort_id = $1 AND access_revoked_at IS NULL`
          : `SELECT count(*)::text AS n FROM lms_cohort_members WHERE access_revoked_at IS NULL`,
        cohortId ? [cohortId] : [],
      );
      return Number(r.rows[0].n);
    },
    { modules: ["lms"] },
  );
  return {
    tenantId: tenant.id, companyName: tenant.name, cohortId: cohortId ?? null,
    tables, rowCounts, liveMembers,
  };
}

/**
 * Run the reset.
 *
 * `execute: false` (the default) plans, counts, records a `dry_run` row and deletes NOTHING. The
 * default is the safe one on purpose: a destructive runner whose default is to destroy will
 * eventually be invoked by somebody who meant to look first.
 */
export async function runTrainingReset(
  opts: { execute?: boolean; cohortId?: string | null; requestedBy?: string | null } = {},
): Promise<ResetResult> {
  const execute = opts.execute ?? false;
  const plan = await planTrainingReset(opts.cohortId);
  const resetRunId = newId();
  const deleted: Record<string, number> = {};
  let grantsRevoked = 0;

  // File the run BEFORE doing anything. A crash mid-delete must leave a record that a reset was
  // attempted; a row written only on success describes a world where resets never fail.
  await withTenants(
    [plan.tenantId],
    (c) => c.query(
      `INSERT INTO lms_training_resets (id, tenant_id, cohort_id, mode, requested_by, row_counts)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [resetRunId, plan.tenantId, plan.cohortId, execute ? "executed" : "dry_run",
       opts.requestedBy ?? null, JSON.stringify(plan.rowCounts)],
    ),
    { modules: ["lms"] },
  );

  if (execute) {
    // ORG-6, and the order is not cosmetic: REVOKE FIRST. A trainee who still holds a grant while
    // the tables are being cleared can write new rows into the tenant mid-reset, and the run would
    // then report a clean tenant that is not clean. Revoking first makes the window empty.
    grantsRevoked = await revokeCohortAccess(plan.tenantId, plan.cohortId);

    for (const t of plan.tables) {
      const modules = t.moduleScope ? [t.moduleScope, "lms"] : ["lms"];
      deleted[t.tableName] = await withTenants(
        [plan.tenantId],
        async (c) => {
          // The tenant predicate is enforced by RLS, not by this WHERE clause — FORCE RLS means the
          // app role cannot see another tenant's rows at all. The table name is interpolated
          // because a table name cannot be a bind parameter; it came from the allow-list and was
          // re-validated against SAFE_IDENT in loadResetAllowList().
          const r = await c.query(`DELETE FROM ${t.tableName}`);
          return r.rowCount ?? 0;
        },
        { modules },
      );
    }

    await withTenants(
      [plan.tenantId],
      (c) => c.query(
        `UPDATE lms_training_resets SET row_counts = $2, grants_revoked = $3, finished_at = now()
          WHERE id = $1`,
        [resetRunId, JSON.stringify(deleted), grantsRevoked],
      ),
      { modules: ["lms"] },
    );

    if (plan.cohortId) {
      await withTenants(
        [plan.tenantId],
        (c) => c.query(
          `UPDATE lms_cohorts SET status = 'reset', reset_at = now(),
                                  closed_at = COALESCE(closed_at, now()), updated_at = now()
            WHERE id = $1`,
          [plan.cohortId],
        ),
        { modules: ["lms"] },
      );
    }
  } else {
    await withTenants(
      [plan.tenantId],
      (c) => c.query(`UPDATE lms_training_resets SET finished_at = now() WHERE id = $1`, [resetRunId]),
      { modules: ["lms"] },
    );
  }

  return { ...plan, mode: execute ? "executed" : "dry_run", deleted, grantsRevoked, resetRunId };
}

/**
 * Revoke every cohort member's access to the training tenant.
 *
 * Both halves, because either alone leaves a working door: the `user_roles` grants scoped to this
 * tenant, and the `company_memberships` row that puts the tenant in their company switcher. ORG-6:
 * a half-disposed environment that leaves live grants behind is worse than not disposing at all.
 *
 * `withGlobal` for the writes: `user_roles` and `company_memberships` are core tables with no
 * module predicate, and the tenant is pinned in each WHERE clause.
 */
export async function revokeCohortAccess(tenantId: string, cohortId: string | null): Promise<number> {
  const members = await withTenants(
    [tenantId],
    async (c) => {
      const r = await c.query<{ id: string; subject_user_id: string }>(
        cohortId
          ? `SELECT id, subject_user_id FROM lms_cohort_members
              WHERE cohort_id = $1 AND access_revoked_at IS NULL`
          : `SELECT id, subject_user_id FROM lms_cohort_members WHERE access_revoked_at IS NULL`,
        cohortId ? [cohortId] : [],
      );
      return r.rows;
    },
    { modules: ["lms"] },
  );
  if (!members.length) return 0;

  const userIds = members.map((m) => m.subject_user_id);
  await withGlobal(async (c) => {
    // ⚠ ROUTED THROUGH THE CHOKE POINT, not a bespoke DELETE. P2-04 makes
    // `src/admin/grant-write.service.ts` the ONLY production file permitted to contain a
    // `user_roles` write, and `user-roles-writer-guard.test.ts` sweeps `src/` on every run to
    // enforce it. That guard caught the first version of this function, which is the guard
    // working: a bespoke revoke here is exactly how a teardown path forgets a rule the choke
    // point already encodes.
    const grants = await c.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM user_roles
        WHERE scope_type = 'company' AND scope_id = $1 AND user_id = ANY($2::uuid[])`,
      [tenantId, userIds],
    );
    for (const g of grants.rows) await revokeGrantById(c, g.id, g.user_id);
  });

  // ⚠ THE MEMBERSHIP DELETE MUST NOT RUN UNDER withGlobal, and the first version of this function
  //   did. `company_memberships` carries FORCE RLS with a tenant_isolation policy (0001, hardened
  //   in 0004), so with no tenant GUC set the DELETE matches ZERO rows and reports success — and
  //   the membership is the OTHER door: it is what puts the training tenant in somebody's company
  //   switcher. Revoking the roles alone leaves the company visible and reachable, which is the
  //   half-disposed state ORG-6 calls worse than not disposing at all.
  //
  //   `user_roles` above genuinely has no RLS, which is why that half worked and this one did not —
  //   two tables, one function, opposite requirements. It was caught by an assertion about the
  //   REAL company's membership surviving, not by anything failing.
  await withTenants(
    [tenantId],
    (c) => c.query(`DELETE FROM company_memberships WHERE user_id = ANY($1::uuid[])`, [userIds]),
  );

  // Stamp AFTER the revocation, never before. `access_revoked_at` is what a later run trusts to
  // mean "this person no longer has a door into the training tenant", and a stamp written first
  // would make a failed revocation look complete.
  await withTenants(
    [tenantId],
    (c) => c.query(
      `UPDATE lms_cohort_members SET access_revoked_at = now() WHERE id = ANY($1::uuid[])`,
      [members.map((m) => m.id)],
    ),
    { modules: ["lms"] },
  );
  return members.length;
}
