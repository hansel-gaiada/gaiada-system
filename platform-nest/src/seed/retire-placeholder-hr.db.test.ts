// `seed:retire-placeholder-hr` — remove the HR files of people who never existed.
//
// ⚠ THE ASSERTIONS THAT MATTER ARE THE ONES ABOUT WHAT IT DOES *NOT* DELETE. This is a destructive
// script pointed at an HR table on a live estate, so the interesting failure is not "it left a ghost"
// but "it removed a real employee". Both directions are pinned, and the real-staff assertion comes
// first.
//
// ⚠ It also pins the module-scope guard. `employees` is FORCE RLS *and* gated on
// `app_module_allowed('hr')`, so a read without `{ modules: ["hr"] }` returns ZERO rows — and for a
// cleanup script "0 candidates" is the most dangerous possible false negative, because it looks
// exactly like success. The script refuses on an empty read rather than reporting a clean sweep.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import { withTenants } from "../db";
import { retirePlaceholderHr } from "./retire-placeholder-hr";
import { STAFF } from "./roster";

const AGENCY = "Gaia Digital Agency";
const REAL = STAFF.filter((s) => s.level !== "fixture");
let tenantId: string;

async function insertEmployee(email: string, name: string): Promise<void> {
  const uid = await createUser(email, name, "Whatever");
  await withTenants(
    [tenantId],
    (c) =>
      c.query(
        `INSERT INTO employees (tenant_id, user_id, display_name, work_email, employment_status, origin_site)
         VALUES ($1,$2,$3,$4,'active','test')`,
        [tenantId, uid, name, email],
      ),
    { modules: ["hr"] },
  );
}
async function emails(): Promise<string[]> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<{ work_email: string }>(`SELECT work_email FROM employees WHERE tenant_id = $1`, [tenantId]),
    { modules: ["hr"] },
  );
  return r.rows.map((x) => x.work_email).sort();
}

describe.skipIf(!TEST_URL)("seed:retire-placeholder-hr", () => {
  beforeAll(async () => {
    await initTestDb();
    tenantId = await createCompany(AGENCY, ["agency", "hr", "reports", "assistant"]);
    // Three real staff and three ghosts — the production shape in miniature.
    for (const s of REAL.slice(0, 3)) await insertEmployee(s.email, s.name);
    await insertEmployee("gede@gaia.test", "Gede Pratama");
    await insertEmployee("owner@gaiada-creative.test", "Ayu (Owner)");
    await insertEmployee("exec@gaiada.test", "Gaiada Exec");
  }, 180_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("🔴 dry run by default — it reports candidates and deletes NOTHING", async () => {
    const before = await emails();
    const r = await retirePlaceholderHr({ dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.deleted).toBe(0);
    expect(r.candidates.map((c) => c.email).sort()).toEqual([
      "exec@gaiada.test",
      "gede@gaia.test",
      "owner@gaiada-creative.test",
    ]);
    expect(await emails(), "a dry run must not change the table").toEqual(before);
  });

  it("🔴 deletes ONLY the ghosts — every real staff HR file survives", async () => {
    const r = await retirePlaceholderHr({ dryRun: false });
    expect(r.deleted).toBe(3);

    const left = await emails();
    // The assertion that matters most: removing a real employee is far worse than leaving a ghost.
    for (const s of REAL.slice(0, 3)) {
      expect(left, `${s.email} is real staff and must NOT have been deleted`).toContain(s.email);
    }
    for (const ghost of ["gede@gaia.test", "owner@gaiada-creative.test", "exec@gaiada.test"]) {
      expect(left, `${ghost} should be gone`).not.toContain(ghost);
    }
    expect(left.length).toBe(3);
  });

  it("is idempotent — a second run finds nothing to do", async () => {
    const r = await retirePlaceholderHr({ dryRun: false });
    expect(r.candidates).toEqual([]);
    expect(r.deleted).toBe(0);
  });

  it("🔴 refuses on an EMPTY read rather than reporting a clean sweep", async () => {
    // Simulates the module-scope mistake: if the read comes back empty, the script must not conclude
    // "nothing to clean". Emptied here by deleting the remaining rows, which is the only way to reach
    // a genuinely empty table in this fixture.
    await withTenants([tenantId], (c) => c.query(`DELETE FROM employees WHERE tenant_id = $1`, [tenantId]), {
      modules: ["hr"],
    });
    await expect(retirePlaceholderHr({ dryRun: true })).rejects.toThrow(/read ZERO employees rows/);
  });
});
