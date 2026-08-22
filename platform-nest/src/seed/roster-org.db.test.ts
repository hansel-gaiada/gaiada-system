// The real Gaia Digital Agency roster and org chart (owner-supplied, 2026-08-23).
//
// WHY THIS SUITE EXISTS. Two failures here are invisible rather than loud, and both have a precedent
// in this directory:
//
//   1. A ROSTER ENTRY THAT IS WRONG STILL RENDERS. The old roster was nine invented names and nothing
//      complained for months, because a seeded person looks identical whether or not they exist. The
//      only way a wrong name surfaces is a human reading the org chart — so the names are pinned here
//      instead, where a diff shows up in review.
//   2. A VACANCY THAT GAINS A HOLDER IS A FABRICATED EMPLOYEE. The owner named 19 people and
//      described 10 more seats WITHOUT names ("Project Manager — still no name, just position now",
//      "3 others", "6 person under him"). The tempting fix for an empty-looking chart is to invent
//      names, and an invented employee is indistinguishable from a real one once seeded. The
//      assertion that those seats hold NOBODY is the guard against that.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise — and a skipped run proves nothing while
// looking exactly like a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { seedAgency } from "./agency";
import { STAFF, VACANCIES } from "./roster";

const AGENCY = "Gaia Digital Agency";

let tenantId: string;

async function q<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await adminPool().query<T>(sql, params);
  return rows;
}

describe.skipIf(!TEST_URL)("the real agency roster + org chart", () => {
  beforeAll(async () => {
    await initTestDb();
    const seeded = await seedAgency();
    tenantId = seeded.tenantId;
  }, 300_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("seeds a users row for every real person, on @gaiada.com", async () => {
    const real = STAFF.filter((s) => s.level !== "fixture");
    // 20 named people. If this number moves, someone edited the roster — which is fine, but it should
    // be a deliberate diff rather than a surprise.
    expect(real).toHaveLength(20);
    for (const s of real) {
      expect(s.email.endsWith("@gaiada.com"), `${s.email} is not on the company domain`).toBe(true);
      const rows = await q<{ name: string }>(`SELECT name FROM users WHERE email = $1`, [s.email]);
      expect(rows, `no users row for ${s.email}`).toHaveLength(1);
      expect(rows[0].name).toBe(s.name);
    }
  });

  it("🔴 the people the owner named, exactly — no invented staff", async () => {
    const emails = STAFF.filter((s) => s.level !== "fixture")
      .map((s) => s.email)
      .sort();
    expect(emails).toEqual(
      [
        // GM
        "edward@gaiada.com",
        // Web Dev
        "azlan@gaiada.com", "hansel@gaiada.com", "reva@gaiada.com", "fadhil@gaiada.com",
        "kadek.arie@gaiada.com", "gusde@gaiada.com", "tini@gaiada.com", "ruli@gaiada.com",
        // SEO
        "rai@gaiada.com", "fajri@gaiada.com", "welly@gaiada.com", "ika@gaiada.com",
        "maya@gaiada.com", "sophi@gaiada.com",
        // Creative
        "monic@gaiada.com", "andre@gaiada.com", "rifat@gaiada.com", "elmer@gaiada.com",
        // Social Media
        "radit@gaiada.com",
      ].sort(),
    );
  });

  it("🔴 gives every roster member a SEAT — 0109's position machinery was empty before this", async () => {
    for (const s of STAFF) {
      const rows = await q<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM position_assignments pa
           JOIN positions p ON p.id = pa.position_id
           JOIN users u ON u.id = pa.user_id
          WHERE pa.tenant_id = $1 AND u.email = $2 AND p.unit_node_id = $3 AND pa.valid_to IS NULL`,
        [tenantId, s.email, s.target],
      );
      expect(Number(rows[0].n), `${s.email} holds no seat in ${s.target}`).toBe(1);
    }
  });

  it("🔴 the ten unnamed openings exist as headcount, held by NOBODY", async () => {
    // The whole point: the chart shows the team's shape without inventing a single person.
    expect(VACANCIES.reduce((n, v) => n + v.count, 0)).toBe(10);
    for (const v of VACANCIES) {
      const seat = await q<{ id: string; headcount: number | null }>(
        `SELECT id, headcount FROM positions
          WHERE tenant_id = $1 AND unit_node_id = $2 AND title = $3`,
        [tenantId, v.target, v.title],
      );
      expect(seat, `seat "${v.title}" missing from ${v.target}`).toHaveLength(1);

      const held = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM position_assignments
          WHERE position_id = $1 AND valid_to IS NULL`,
        [seat[0].id],
      );
      // An opening is headcount MINUS holders, not a row of its own — "Creative" at d-creatives is one
      // seat with 3 named holders and a headcount of 6, i.e. Monic's "3 others". Asserting the
      // difference (rather than a hardcoded holder count of 0) is what makes this test correct for
      // both the colliding seat and the two that stand empty.
      expect(
        (seat[0].headcount ?? 0) - Number(held[0].n),
        `"${v.title}" in ${v.target} should have exactly ${v.count} opening(s) — if this is short, ` +
          `someone was invented to fill a seat the owner gave no name for`,
      ).toBe(v.count);
    }
  });

  it("the reporting chain the owner stated is derivable: Edward → Azlan → Hansel/PM → divisions", async () => {
    // Reporting is DERIVED from lead seats, not stored per person (0109 §2.1). So the assertion is
    // about which seats are marked lead, at which node — that IS the chain.
    const leads = await q<{ unit: string; email: string }>(
      `SELECT p.unit_node_id AS unit, u.email
         FROM positions p
         JOIN position_assignments pa ON pa.position_id = p.id AND pa.valid_to IS NULL
         JOIN users u ON u.id = pa.user_id
        WHERE p.tenant_id = $1 AND p.is_lead = true
        ORDER BY p.unit_node_id, u.email`,
      [tenantId],
    );
    const byUnit = new Map(leads.map((l) => [l.unit, l.email]));
    expect(byUnit.get("d-gm"), "Edward leads the GM node — the top of the agency").toBe("edward@gaiada.com");
    expect(byUnit.get("d-webdev"), "Azlan heads Web Dev, under the GM").toBe("azlan@gaiada.com");
    expect(byUnit.get("v-aimgr"), "Hansel leads the AI Manager division, under Azlan").toBe("hansel@gaiada.com");
    expect(byUnit.get("d-seo")).toBe("rai@gaiada.com");
    expect(byUnit.get("d-creatives")).toBe("monic@gaiada.com");
    expect(byUnit.get("d-social")).toBe("radit@gaiada.com");
  });

  it("heads and managers actually hold `manager`; ICs hold only `member`", async () => {
    // Before this change the seed granted flat `member` to everyone, so the agency had no managers at
    // all — every person the owner calls a manager could see the app and authorize nothing above an IC.
    const held = async (email: string) =>
      (
        await q<{ name: string }>(
          `SELECT r.name FROM user_roles ur
             JOIN roles r ON r.id = ur.role_id
             JOIN users u ON u.id = ur.user_id
            WHERE u.email = $1 AND ur.scope_type = 'company' AND ur.scope_id = $2::text
            ORDER BY r.name`,
          [email, tenantId],
        )
      ).map((r) => r.name);

    for (const email of ["edward@gaiada.com", "azlan@gaiada.com", "rai@gaiada.com", "monic@gaiada.com", "radit@gaiada.com"]) {
      expect(await held(email), `${email} leads a team and must hold manager`).toContain("manager");
    }
    // `member` stays granted alongside — several policies key off it, so manager is additive here.
    for (const email of ["fadhil@gaiada.com", "tini@gaiada.com", "ika@gaiada.com"]) {
      const roles = await held(email);
      expect(roles).toContain("member");
      expect(roles, `${email} is an IC — manager here would be an over-grant`).not.toContain("manager");
    }
  });

  it("🔴 no position confers an elevated tier — 0109's denied-role registry, observed not trusted", async () => {
    const rows = await q<{ name: string }>(
      `SELECT DISTINCT r.name
         FROM position_roles pr
         JOIN roles r ON r.id = pr.role_id
        WHERE pr.tenant_id = $1
          AND r.name IN ('platform_admin','group_executive','client','owner')`,
      [tenantId],
    );
    // trg_position_roles_guard would have REFUSED these inserts. This asserts the outcome rather than
    // trusting the trigger — and `owner` now exists as a roles row (IAM-14), so the guard is live
    // for the first time rather than matching a name with nothing behind it.
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("hansel@gaiada.com is BOTH a roster member and the platform superadmin", async () => {
    // The owner's "hansel can go either ways". He is seeded twice by two different paths — as
    // `users.superadmin` and as a roster row — and `ensureUser` resolves both to ONE account. If that
    // ever forked, there would be two Hansels: one with the seat, one with the platform tier.
    const rows = await q<{ id: string }>(`SELECT id FROM users WHERE email = 'hansel@gaiada.com'`);
    expect(rows, "two rows here means the seed forked his identity").toHaveLength(1);

    const roles = await q<{ name: string; scope_type: string }>(
      `SELECT r.name, ur.scope_type FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 ORDER BY r.name`,
      [rows[0].id],
    );
    expect(roles.map((r) => r.name)).toContain("platform_admin");
    expect(roles.map((r) => r.name)).toContain("manager");
  });

  it("the five @gaiada-creative.test seed ACTORS survive — departments.ts hard-fails without them", async () => {
    // Tidying these out of the roster looks like removing fake data. It breaks the department seed
    // ("seed actor (owner@gaiada-creative.test) not found"), task attribution, and a Keycloak test.
    for (const email of [
      "owner@gaiada-creative.test",
      "pm@gaiada-creative.test",
      "design@gaiada-creative.test",
      "copy@gaiada-creative.test",
      "approver@gaiada-creative.test",
    ]) {
      const rows = await q<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
      expect(rows, `seed actor ${email} is gone`).toHaveLength(1);
    }
  });
});
