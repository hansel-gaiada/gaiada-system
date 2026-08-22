// IAM-14 · the `owner` role (D-8) — Phase 3's first ticket.
//
// ⚠ WHAT THIS SUITE IS GUARDING. `owner` is described by its own design as "the highest-risk role in
// the system — real, non-technical people", and it is the FIRST permission-native role: it has ZERO
// Cerbos rules, so its `role_permissions` rows ARE its reach. There is no policy to re-read if the
// bundle is wrong, and no rule that would deny an over-broad key. The bundle is the whole boundary.
//
// The two failure directions are not symmetric, and both are pinned below:
//   TOO NARROW — an owner cannot run their own company. Visible, annoying, harmless.
//   TOO BROAD  — an owner reaches the client portal or platform credentials. Invisible, and it is a
//                trust-boundary breach rather than a permission surplus.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise — and a skipped run of this file proves
// nothing while looking identical to a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import bundles from "./role-permission-bundles.json";

async function keysFor(role: string): Promise<string[]> {
  const { rows } = await adminPool().query<{ key: string }>(
    `SELECT p.key
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = $1
      ORDER BY p.key`,
    [role],
  );
  return rows.map((r) => r.key);
}

describe.skipIf(!TEST_URL)("IAM-14 · the owner role", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("exists as exactly ONE global role row — not one per company", async () => {
    const { rows } = await adminPool().query<{ n: string; company_id: string | null }>(
      `SELECT count(*)::text AS n, company_id FROM roles WHERE name = 'owner' GROUP BY company_id`,
    );
    // A per-company `owner` row would mean one bundle to maintain per company, which is how `roles`
    // previously accumulated ten `manager` rows (0073).
    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBeNull();
    expect(Number(rows[0].n)).toBe(1);
  });

  it("🔴 the DB bundle matches company_admin EXACTLY — the envelope cannot be short or long", async () => {
    const owner = await keysFor("owner");
    const admin = await keysFor("company_admin");
    expect(owner.length, "owner has no bundle at all — migration did not run").toBeGreaterThan(0);
    expect(
      owner,
      "owner's envelope diverged from company_admin's. It is defined AS company_admin's (D-8: " +
        "everything business + role authoring, no platform controls) precisely so it cannot drift — " +
        "if this fails, either the migration's INSERT..SELECT changed or someone hand-edited rows.",
    ).toEqual(admin);
  });

  it("the JSON artifact agrees with the database — two expressions of one rule", async () => {
    // The generator derives owner from company_admin too. If these disagree, one of them was
    // hand-edited, and for this role a hand-edit is exactly what must not survive review.
    expect(bundles.roles.owner).toEqual(bundles.roles.company_admin);
    expect(await keysFor("owner")).toEqual([...bundles.roles.owner].sort());
  });

  it("🔴 does NOT reach the client portal — the staff/client trust boundary", async () => {
    const owner = await keysFor("owner");
    const portal = owner.filter((k) => k.startsWith("portal."));
    expect(
      portal,
      "an owner reaching portal.* is the leak path design §7 calls a TRUST boundary rather than a " +
        "permission sum: the client-facing surface is not a bigger version of the staff one. This is " +
        "the single most important assertion in this file.",
    ).toEqual([]);
  });

  it("🔴 does NOT reach platform/operator surfaces", async () => {
    const owner = new Set(await keysFor("owner"));
    // Checked individually rather than by prefix: these were the non-obvious members of the 19 keys
    // platform_admin holds and company_admin does not, and a prefix rule would have missed them.
    for (const forbidden of [
      "social.platform_app.admin", // platform OAuth credentials, not a business asset
      "social.platform_app.read",
      "core.rollup.read", // cross-company operator view
      "core.service_assignment.reconcile", // the shared-service reconciler
    ]) {
      expect(owner.has(forbidden), `owner must not hold ${forbidden}`).toBe(false);
    }
  });

  it("does not hold SELF-scoped actions as a role — those belong to a person, not an owner", async () => {
    const owner = new Set(await keysFor("owner"));
    // reports.appraisal.* / checkin.submit are things a person does about themselves. Granting them
    // via `owner` would let an owner submit or finalise appraisals as an authority rather than as a
    // participant — a different act with the same name.
    for (const selfScoped of ["reports.appraisal.submit", "reports.appraisal.finalize", "reports.checkin.submit"]) {
      expect(owner.has(selfScoped), `${selfScoped} is self-scoped and must not ride the owner role`).toBe(false);
    }
  });

  it("DOES carry role authoring and positions — D-5/D-8's 'author roles in owned companies'", async () => {
    const owner = new Set(await keysFor("owner"));
    // The positive control for the four refusals above: an envelope that reached nothing would pass
    // every one of them and be useless.
    for (const needed of [
      "core.role_grant.create",
      "core.role_grant.revoke",
      "core.role_grant.decide_override",
      "core.position.create",
      "core.position.assign",
    ]) {
      expect(owner.has(needed), `owner must be able to ${needed} — D-8 says role authoring`).toBe(true);
    }
  });

  it("carries NO relationship-class permission — Ruling 3, enforced twice", async () => {
    const { rows } = await adminPool().query<{ key: string }>(
      `SELECT p.key
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.company_id IS NULL AND r.name = 'owner' AND p.class = 'relationship'`,
    );
    // 0093's trigger would have refused the INSERT; this asserts the outcome rather than trusting it.
    expect(rows.map((r) => r.key)).toEqual([]);
  });

  it("platform_admin is UNCHANGED and still strictly broader — owner sits beside it, not above", async () => {
    const owner = new Set(await keysFor("owner"));
    const platform = await keysFor("platform_admin");
    expect(platform.length).toBeGreaterThan(owner.size);
    // The point of D-6's "collapse" was to remove a duplicate NAME, never the capability. This pins
    // that the platform tier still exists and still exceeds owner, so a future reading of "collapse"
    // cannot quietly erode it.
    const ownerExceedsPlatform = [...owner].filter((k) => !platform.includes(k));
    expect(ownerExceedsPlatform, "owner reached something platform_admin cannot").toEqual([]);
  });
});
