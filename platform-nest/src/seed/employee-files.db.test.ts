// `seed:employee-files` — the HR people file for the real roster.
//
// ⚠ THE ASSERTION THIS FILE EXISTS FOR IS THE MODULE-GUC ONE. `employees` composes its RLS as
// `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr')`. Omit `{ modules: ["hr"] }`
// and the INSERT writes ZERO ROWS and reports success — so a broken seed and a working one produce
// the identical console output. Counting rows back through a reader that ALSO forgets the GUC would
// be doubly blind: it would read zero and agree.
//
// So the suite reads the table two ways on purpose — once correctly, once without the module scope —
// and asserts they DISAGREE. That difference is the proof the wall is real and that the writes went
// through it rather than around it.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import { withTenants } from "../db";
import { seedEmployeeFiles } from "./employee-files";
import { STAFF } from "./roster";

const AGENCY = "Gaia Digital Agency";
const REAL = STAFF.filter((s) => s.level !== "fixture");

let tenantId: string;

describe.skipIf(!TEST_URL)("seed:employee-files — the HR people file", () => {
  beforeAll(async () => {
    await initTestDb();
    tenantId = await createCompany(AGENCY, ["agency", "hr", "reports", "assistant"]);
  }, 180_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("skips cleanly when nobody has a users row yet, and SAYS so", async () => {
    // This seed can legitimately run before roster-access. Silence here would read as success.
    const r = await seedEmployeeFiles();
    expect(r.created).toEqual([]);
    expect(r.skippedNoUser.length).toBe(REAL.length);
  });

  it("🔴 writes one employees row per real staff member once the users exist", async () => {
    for (const s of REAL) await createUser(s.email, s.name, s.title);

    const r = await seedEmployeeFiles();
    expect(r.created.length, "expected one HR file per real staff member").toBe(REAL.length);
    expect(r.skippedNoUser).toEqual([]);

    // Read through the HR wall, correctly.
    const n = await withTenants(
      [tenantId],
      (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM employees WHERE tenant_id = $1`, [tenantId]),
      { modules: ["hr"] },
    );
    expect(Number(n.rows[0].n)).toBe(REAL.length);
  });

  it("🔴 the HR module wall is REAL — the same read without `modules: [hr]` returns zero", async () => {
    // The teeth. If this ever returns the same count as the read above, the module GUC is no longer
    // gating `employees`, and every "it worked" in this file becomes unfalsifiable.
    const blind = await withTenants([tenantId], (c) =>
      c.query<{ n: string }>(`SELECT count(*)::text AS n FROM employees WHERE tenant_id = $1`, [tenantId]),
    );
    expect(
      Number(blind.rows[0].n),
      "a read without the hr module scope returned rows — app_module_allowed('hr') is not gating " +
        "this table, so the seed's writes prove nothing about the wall",
    ).toBe(0);
  });

  it("excludes the seed ACTORS — an HR file is a claim that someone works here", async () => {
    const rows = await withTenants(
      [tenantId],
      (c) => c.query<{ work_email: string }>(`SELECT work_email FROM employees WHERE tenant_id = $1`, [tenantId]),
      { modules: ["hr"] },
    );
    const emails = rows.rows.map((r) => r.work_email);
    for (const fixture of ["owner@gaiada-creative.test", "pm@gaiada-creative.test", "exec@gaiada.test"]) {
      expect(emails, `${fixture} is a seed actor, not an employee`).not.toContain(fixture);
    }
    expect(emails).toContain("edward@gaiada.com");
  });

  it("leaves hire_date and manager_user_id NULL — neither was supplied, and inventing them is worse", async () => {
    const rows = await withTenants(
      [tenantId],
      (c) =>
        c.query<{ hire_date: string | null; manager_user_id: string | null }>(
          `SELECT hire_date, manager_user_id FROM employees WHERE tenant_id = $1`,
          [tenantId],
        ),
      { modules: ["hr"] },
    );
    for (const r of rows.rows) {
      expect(r.hire_date, "a fabricated hire date is worse than an absent one").toBeNull();
      // 0109 §2.1: manager_user_id is an OVERRIDE of the org chart, not the reporting line. The chart
      // already answers reporting from the lead seats; filling this in would create a second source
      // of truth that diverges on the first promotion.
      expect(r.manager_user_id).toBeNull();
    }
  });

  it("is idempotent — a second run creates nothing and reports them as existing", async () => {
    const r = await seedEmployeeFiles();
    expect(r.created).toEqual([]);
    expect(r.existing.length).toBe(REAL.length);

    const n = await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM employees`);
    expect(Number(n.rows[0].n), "a duplicate row means the partial unique index did not apply").toBe(REAL.length);
  });
});
