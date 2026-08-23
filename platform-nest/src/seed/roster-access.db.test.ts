// `seed:roster-access` — the targeted alternative to running the whole showcase seed.
//
// ⚠ THE ASSERTION THAT MATTERS MOST IS A NEGATIVE ONE. This script exists because production is a
// deliberately CLEAN estate (3 companies, 53 users, and zero clients/projects/tasks/invoices), and
// `seed:agency` would have injected a full demo vertical into it just to give nineteen people a
// `users` row. So the suite pins what it does NOT create at least as hard as what it does — a future
// edit that quietly starts seeding a client here would defeat the entire point of the file.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedRosterAccess } from "./roster-access";
import { STAFF } from "./roster";

const AGENCY = "Gaia Digital Agency";

let tenantId: string;

async function n(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await adminPool().query<{ n: string }>(sql, params);
  return Number(rows[0].n);
}

describe.skipIf(!TEST_URL)("seed:roster-access — access only, no business data", () => {
  beforeAll(async () => {
    await initTestDb();
    // Only the agency company. Nothing else — that IS the production shape this script targets.
    tenantId = await createCompany(AGENCY, ["agency", "hr", "reports", "assistant"]);
  }, 180_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("🔴 gives every roster member a users row, a MEMBERSHIP and a role grant", async () => {
    const r = await seedRosterAccess();
    expect(r.tenantId).toBe(tenantId);

    for (const s of STAFF) {
      const u = await adminPool().query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [s.email]);
      expect(u.rows, `no users row for ${s.email}`).toHaveLength(1);

      // The membership is the piece most easily forgotten: `inTenant` is built from
      // company_memberships, so a role grant without one is denied by almost every policy.
      const m = await n(
        `SELECT count(*)::text AS n FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, u.rows[0].id],
      );
      expect(m, `${s.email} has a role but no membership — inTenant would be false everywhere`).toBe(1);

      const g = await n(
        `SELECT count(*)::text AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1 AND r.name = 'member' AND ur.scope_type = 'company' AND ur.scope_id = $2`,
        [u.rows[0].id, tenantId],
      );
      expect(g, `${s.email} holds no member grant`).toBe(1);
    }
  });

  it("grades manager grants by level — heads get it, ICs do not", async () => {
    const holds = async (email: string) =>
      n(
        `SELECT count(*)::text AS n FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
          WHERE u.email = $1 AND r.name = 'manager'`,
        [email],
      );
    for (const e of ["edward@gaiada.com", "azlan@gaiada.com", "rai@gaiada.com", "monic@gaiada.com", "radit@gaiada.com"]) {
      expect(await holds(e), `${e} leads a team and must hold manager`).toBe(1);
    }
    for (const e of ["fadhil@gaiada.com", "tini@gaiada.com", "ika@gaiada.com"]) {
      expect(await holds(e), `${e} is an IC — manager here would be an over-grant`).toBe(0);
    }
  });

  it("🔴 creates NO business data — this is the whole reason the script exists", async () => {
    // If any of these ever becomes non-zero, someone has turned this back into `seed:agency` and the
    // clean production estate it was written to protect is no longer protected.
    for (const table of ["clients", "projects", "tasks", "invoices", "deliverables"]) {
      const count = await n(`SELECT count(*)::text AS n FROM ${table}`);
      expect(count, `${table} is not empty — roster-access must not seed business data`).toBe(0);
    }
  });

  it("creates no company beyond the one it was pointed at", async () => {
    // `seed:agency` would have created the holding, the resort, four venues and catering. This must
    // touch none of that — the holding backbone is a separate concern with its own migration.
    expect(await n(`SELECT count(*)::text AS n FROM companies WHERE deleted_at IS NULL`)).toBe(1);
  });

  it("is idempotent — a second run adds nothing", async () => {
    const before = {
      users: await n(`SELECT count(*)::text AS n FROM users`),
      memberships: await n(`SELECT count(*)::text AS n FROM company_memberships`),
      grants: await n(`SELECT count(*)::text AS n FROM user_roles`),
      seats: await n(`SELECT count(*)::text AS n FROM position_assignments`),
    };
    const r = await seedRosterAccess();
    expect(r.usersCreated).toEqual([]);
    expect(r.membershipsAdded).toBe(0);
    expect(r.memberGrants).toBe(0);
    expect(r.managerGrants).toBe(0);

    expect(await n(`SELECT count(*)::text AS n FROM users`)).toBe(before.users);
    expect(await n(`SELECT count(*)::text AS n FROM company_memberships`)).toBe(before.memberships);
    expect(await n(`SELECT count(*)::text AS n FROM user_roles`)).toBe(before.grants);
    expect(await n(`SELECT count(*)::text AS n FROM position_assignments`)).toBe(before.seats);
  });

  it("🔴 refuses outright if the agency company is absent, rather than creating one", async () => {
    // A missing company means this is not the estate the script was written for. Creating one would
    // fork it exactly the way the resort was forked (migration 202608230612) — the same class of bug,
    // and the reason this guard is here at all.
    await adminPool().query(`UPDATE companies SET name = 'Renamed Away' WHERE id = $1`, [tenantId]);
    await expect(seedRosterAccess()).rejects.toThrow(/Refusing to create one/);
    await adminPool().query(`UPDATE companies SET name = $1 WHERE id = $2`, [AGENCY, tenantId]);
  });
});
