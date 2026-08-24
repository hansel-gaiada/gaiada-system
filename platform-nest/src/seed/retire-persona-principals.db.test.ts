// `seed:retire-persona-principals` — make the seeded personas disappear from the ERP.
//
// ⚠ THE GUARD IS THE FEATURE. This script makes people vanish from every surface at once, so the
// tests that matter are the two refusals:
//
//   1. It must REFUSE while a persona still owns anything. Retiring first would orphan that work AND
//      hide it — a soft-deleted principal drops out of the very surfaces you would use to notice.
//      That is strictly worse than leaving the ghost visible.
//   2. It must REFUSE to touch a real employee. The target list is the reassignment map's keys, so a
//      bug in that map is the realistic route to retiring a live account, and the domain check is
//      what stands between the two.
//
// The happy path is asserted last and deliberately last: "it retired someone" proves nothing about
// whether it retired the right someone.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, createProject } from "../testing/fixtures";
import { retirePersonaPrincipals } from "./retire-persona-principals";
import { REASSIGN } from "./reassign-retired";
import { STAFF } from "./roster";

const AGENCY = "Gaia Digital Agency";
let tenantId: string;
let personaId: string;

async function deletedAt(email: string): Promise<string | null> {
  const r = await adminPool().query<{ deleted_at: string | null }>(
    `SELECT deleted_at FROM users WHERE email = $1`,
    [email],
  );
  return r.rows[0]?.deleted_at ?? null;
}

describe.skipIf(!TEST_URL)("seed:retire-persona-principals", () => {
  beforeAll(async () => {
    await initTestDb();
    tenantId = await createCompany(AGENCY, ["agency", "pm", "hr", "reports"]);
    for (const s of STAFF) await createUser(s.email, s.name, s.title);
    // Every persona in the map, so the script's own target list is exercised rather than a subset.
    //
    // ⚠ Six of them are ALREADY in STAFF as `level: "fixture"` — the `@gaiada-creative.test` actors
    // plus `exec@gaiada.test` — so creating them again violates the global unique on `users.email`.
    // That overlap is the point rather than an inconvenience: the roster carries the fixture actors
    // precisely so `REAL_EMAILS` can exclude them, which is why they are both "in STAFF" and
    // "retirable personas".
    const seeded = new Set(STAFF.map((s) => s.email));
    for (const email of Object.keys(REASSIGN)) {
      if (seeded.has(email)) continue;
      await createUser(email, `Persona ${email}`, "Seeded");
    }
    personaId = (
      await adminPool().query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, ["gede@gaia.test"])
    ).rows[0].id;
  }, 240_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("🔴 REFUSES while a persona still owns work, and names it", async () => {
    // A project owned by the persona = the reassignment has not run. Retiring here would hide it.
    const projectId = await createProject(tenantId, "Still-owned project", personaId);

    await expect(retirePersonaPrincipals({ dryRun: true })).rejects.toThrow(/still owned by a persona/);
    await expect(retirePersonaPrincipals({ dryRun: true })).rejects.toThrow(/gede@gaia\.test/);
    // Even the *confirm* path must refuse — the guard is not a dry-run nicety.
    await expect(retirePersonaPrincipals({ dryRun: false })).rejects.toThrow(/still owned by a persona/);
    expect(await deletedAt("gede@gaia.test"), "a refused run must retire nobody").toBeNull();

    await adminPool().query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  it("🔴 REFUSES to retire anything on the real company domain", async () => {
    // Simulates the realistic failure: a real address finds its way into REASSIGN's keys. Asserted
    // against the live map so the guard cannot drift away from what it guards.
    const realKeys = Object.keys(REASSIGN).filter((e) => e.endsWith("@gaiada.com"));
    expect(realKeys, "REASSIGN must not have real staff as retirement targets").toEqual([]);

    const staffBefore = await deletedAt("edward@gaiada.com");
    await retirePersonaPrincipals({ dryRun: true });
    expect(await deletedAt("edward@gaiada.com"), "real staff must be untouched").toBe(staffBefore);
  });

  it("dry run reports the targets and retires nobody", async () => {
    const r = await retirePersonaPrincipals({ dryRun: true });
    expect(r.targets.length).toBe(Object.keys(REASSIGN).length);
    expect(r.retired).toBe(0);
    expect(await deletedAt("gede@gaia.test")).toBeNull();
  });

  it("retires every persona and no one else", async () => {
    const r = await retirePersonaPrincipals({ dryRun: false });
    expect(r.retired).toBe(Object.keys(REASSIGN).length);

    for (const email of Object.keys(REASSIGN)) {
      expect(await deletedAt(email), `${email} must be retired`).not.toBeNull();
    }
    // The assertion that matters more: nobody real went with them.
    for (const s of STAFF.filter((x) => x.level !== "fixture").slice(0, 5)) {
      expect(await deletedAt(s.email), `${s.email} is real staff and must NOT be retired`).toBeNull();
    }
  });

  it("is idempotent — a second run retires nobody new", async () => {
    const r = await retirePersonaPrincipals({ dryRun: false });
    expect(r.retired).toBe(0);
    expect(r.targets.every((t) => t.alreadyRetired)).toBe(true);
  });
});
