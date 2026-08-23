// The HR people file — `employees` rows for the real roster.
//
// ⚠ NOTHING HAS EVER WRITTEN TO THIS TABLE. Migration 0109 created it in IAM Phase 2 (P2-01, "the
// HR-owned people file") and it has stood empty since: `grep "INSERT INTO employees"` over `src/`
// finds only tests. So the estate has users, and now seats, but no HR record of anyone — which is
// why `employment_status`, `hire_date` and the whole JML surface have had nothing real to act on.
//
// ── WHY THIS IS SEPARATE FROM `seed:roster-access` ────────────────────────────────────────────────
// Access and employment are different claims. A bot, an automation principal or a contractor can
// hold a role without being an employee, and an employee can exist with `pending_start` before any
// account is created (0109 makes `user_id` nullable for exactly that). Folding HR records into the
// access seed would assert "everyone with a login is an employee", which is false by design in this
// estate — `principal-kinds` is explicit that automation/bot principals are ordinary `users` rows.
//
// ⚠ THE HR WALL IS A THIRD GUC, AND FORGETTING IT WRITES ZERO ROWS SILENTLY. `employees` composes
// its policy as `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr')`. A
// `withTenants([t], fn)` with no `{ modules: ["hr"] }` leaves `app.scopes` unset, every row fails
// the predicate, and the INSERT reports success having written nothing. That is this program's
// signature failure mode and the reason every call below passes the option explicitly.
import { withTenants, withGlobal, closePool } from "../db";
import { config } from "../config";
import { STAFF } from "./roster";

const AGENCY_NAME = "Gaia Digital Agency";

export interface EmployeeFilesResult {
  tenantId: string;
  created: string[];
  existing: string[];
  skippedNoUser: string[];
}

export async function seedEmployeeFiles(): Promise<EmployeeFilesResult> {
  const site = config.originSite;

  const t = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  if (!t.rows[0]) {
    throw new Error(
      `seedEmployeeFiles: no company named "${AGENCY_NAME}". Refusing to create one — same by-name ` +
        `fork hazard as migration 202608230612.`,
    );
  }
  const tenantId = t.rows[0].id;

  const created: string[] = [];
  const existing: string[] = [];
  const skippedNoUser: string[] = [];

  // Real staff only. The `fixture` level is the `@gaiada-creative.test` seed actors — giving them HR
  // files would put five invented people into a table HR reads as the record of who works here.
  for (const s of STAFF.filter((x) => x.level !== "fixture")) {
    const u = await withGlobal((c) =>
      c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [s.email]),
    );
    if (!u.rows[0]) {
      // Not an error: this seed can legitimately run before `seed:roster-access`. Recorded rather
      // than silently passed over, because "0 created" with no explanation reads as success.
      skippedNoUser.push(s.email);
      continue;
    }
    const userId = u.rows[0].id;

    const done = await withTenants(
      [tenantId],
      async (c) => {
        // ux_employees_tenant_user is PARTIAL (`WHERE user_id IS NOT NULL`) because a plain
        // UNIQUE(tenant_id, user_id) never fires while user_id IS NULL — 0109's own note about the
        // null-defeats-unique trap. Every row here HAS a user_id, so the index applies and
        // ON CONFLICT can name it.
        const r = await c.query<{ id: string }>(
          `INSERT INTO employees (tenant_id, user_id, display_name, work_email, employment_status, origin_site)
           VALUES ($1, $2, $3, $4, 'active', $5)
           ON CONFLICT (tenant_id, user_id) WHERE user_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [tenantId, userId, s.name, s.email, site],
        );
        return (r.rowCount ?? 0) > 0;
      },
      // ⚠ Without this the INSERT writes nothing and still succeeds. See the header.
      { modules: ["hr"] },
    );

    if (done) created.push(s.email);
    else existing.push(s.email);
  }

  return { tenantId, created, existing, skippedNoUser };
}

async function main(): Promise<void> {
  const r = await seedEmployeeFiles();
  console.log(`tenant:            ${r.tenantId}`);
  console.log(`employee files created:  ${r.created.length}`);
  for (const e of r.created) console.log(`  + ${e}`);
  console.log(`already had one:         ${r.existing.length}`);
  if (r.skippedNoUser.length) {
    console.log(`SKIPPED (no users row):  ${r.skippedNoUser.length} — run seed:roster-access first`);
    for (const e of r.skippedNoUser) console.log(`  ! ${e}`);
  }
  console.log(
    "\nNOTE: hire_date and manager_user_id are left NULL on purpose. `manager_user_id` is an OVERRIDE\n" +
      "of the org chart (0109 design §2.1), not the reporting line — the chart already answers that\n" +
      "from the lead seats. And a hire date nobody supplied would be a fabricated HR record.",
  );
  await closePool();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();
