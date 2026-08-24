// `seed:purge-retired-history` — delete the personal history that could not be transferred.
//
// ⚠ THIS SCRIPT DELETES HR AND REPORTING HISTORY ON A LIVE ESTATE, so the test that matters is not
// "does it delete the duplicate". It is the REFUSAL: given a row the mapped employee does NOT already
// have an equivalent of, the run must abort rather than delete it, because such a row can still be
// moved and moving beats disposing. A version that deleted everything belonging to a retired persona
// would pass a naive test and be one reassignment bug away from destroying history that had somewhere
// to go — with no way to tell afterwards.
//
// Both directions are pinned, refusal first, and the duplicate case is only exercised after the
// movable row is removed — so "it deleted something" can never be mistaken for "it deleted the right
// thing".
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import { withTenants } from "../db";
import { purgeRetiredHistory } from "./purge-retired-history";
import { STAFF } from "./roster";

const AGENCY = "Gaia Digital Agency";
const SHARED_DAY = "2026-08-01"; // both the persona and the real employee have this one
const PERSONA_ONLY_DAY = "2026-08-02"; // only the persona has this one — must NOT be deleted

let tenantId: string;
let retiredId: string;
let targetId: string;

async function insertCheckin(userId: string, day: string): Promise<void> {
  await withTenants(
    [tenantId],
    (c) =>
      c.query(
        `INSERT INTO report_checkins (tenant_id, user_id, checkin_date, status, origin_site)
         VALUES ($1, $2, $3::date, 'submitted', 'test')`,
        [tenantId, userId, day],
      ),
    { modules: ["reports"] },
  );
}

async function checkinDays(userId: string): Promise<string[]> {
  const r = await adminPool().query<{ d: string }>(
    `SELECT to_char(checkin_date, 'YYYY-MM-DD') AS d FROM report_checkins WHERE user_id = $1 ORDER BY 1`,
    [userId],
  );
  return r.rows.map((x) => x.d);
}

describe.skipIf(!TEST_URL)("seed:purge-retired-history", () => {
  beforeAll(async () => {
    await initTestDb();
    tenantId = await createCompany(AGENCY, ["agency", "hr", "reports", "pm"]);
    // Every mapping TARGET must exist or the script refuses before it classifies anything.
    for (const s of STAFF) await createUser(s.email, s.name, s.title);
    targetId = (
      await adminPool().query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, ["reva@gaiada.com"])
    ).rows[0].id;
    // `gede@gaia.test` -> `reva@gaiada.com` is one of the mappings.
    retiredId = await createUser("gede@gaia.test", "Gede Pratama", "Frontend Developer");

    await insertCheckin(targetId, SHARED_DAY); // the real employee's own row
    await insertCheckin(retiredId, SHARED_DAY); // redundant — reva already has this day
    await insertCheckin(retiredId, PERSONA_ONLY_DAY); // NOT redundant — reva has no row that day
  }, 240_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("🔴 REFUSES the whole run when a row is not a duplicate, and deletes nothing", async () => {
    // The assertion this file exists for. A movable row must abort the run — and critically, the
    // abort must happen before ANY delete, which is why the duplicate is still present afterwards.
    await expect(purgeRetiredHistory({ dryRun: false })).rejects.toThrow(/are NOT duplicates/);
    expect(await checkinDays(retiredId), "an aborted run must not have deleted the duplicate either").toEqual([
      SHARED_DAY,
      PERSONA_ONLY_DAY,
    ]);
  });

  it("🔴 names the offending table and mapping in the refusal", async () => {
    // A refusal that does not say WHICH row blocked it sends the reader back to the database to
    // find out, and the usual response to an unexplained refusal is to reach for a force flag.
    await expect(purgeRetiredHistory({ dryRun: true })).rejects.toThrow(/report_checkins/);
    await expect(purgeRetiredHistory({ dryRun: true })).rejects.toThrow(/seed:reassign-retired first/);
  });

  it("deletes ONLY the proven duplicate once the movable row is gone", async () => {
    // Simulates the reassignment having moved the movable row: reassign it to the target by hand.
    await adminPool().query(
      `UPDATE report_checkins SET user_id = $2 WHERE user_id = $1 AND checkin_date = $3::date`,
      [retiredId, targetId, PERSONA_ONLY_DAY],
    );

    const r = await purgeRetiredHistory({ dryRun: true });
    expect(r.movable, "nothing should be movable now").toEqual([]);
    expect(r.duplicates.some((d) => d.where.startsWith("report_checkins"))).toBe(true);
    expect(await checkinDays(retiredId), "a dry run must delete nothing").toEqual([SHARED_DAY]);

    const done = await purgeRetiredHistory({ dryRun: false });
    expect(done.deleted).toBe(1);
    expect(await checkinDays(retiredId), "the persona's redundant row is gone").toEqual([]);
    // The real employee keeps BOTH: their own row and the one moved to them. A script that deleted
    // by day rather than by owner would have taken these too.
    expect(await checkinDays(targetId)).toEqual([SHARED_DAY, PERSONA_ONLY_DAY]);
  });

  it("is idempotent — a second run finds nothing left", async () => {
    const r = await purgeRetiredHistory({ dryRun: false });
    expect(r.deleted).toBe(0);
    expect(r.duplicates).toEqual([]);
  });
});
