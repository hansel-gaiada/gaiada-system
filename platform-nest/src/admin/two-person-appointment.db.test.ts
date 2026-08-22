// IAM-16 / D-9 — the two-person appointment to an elevated role.
//
// ⚠ THE TWO FAILURE DIRECTIONS ARE NOT SYMMETRIC, AND BOTH ARE PINNED BELOW.
//   TOO STRICT — nobody can ever be appointed to the platform tier again. That is an OUTAGE with no
//               way out except a seed run against production, and it is precisely the mistake the
//               Phase-3 readiness assessment refused to ship: closing the legacy door while the
//               replacement path did not work would brick the flow the rule exists to protect.
//   TOO LOOSE  — one principal appoints itself a second platform_admin and the "two-person" rule is
//               decoration. Invisible, and it defeats the whole ticket.
//
// So the positive control (a properly witnessed appointment SUCCEEDS) matters at least as much as the
// refusals here. A test file with only refusals would pass with the write path deleted entirely.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { withGlobal } from "../db";
import { assertGrantAllowed, type GrantSpec } from "./grant-write.service";
import { createRole, grantRole, createCompany, createUser } from "../testing/fixtures";
import type { PermissionGrant } from "../rbac/principal";

let tenant: string;
let platformAdminRole: string;
let ownerRole: string;
let managerRole: string;

// The people. Names describe the ROLE each plays in the rule, not a person.
let superadmin: string; // holds platform_admin
let holdingOwner: string; // holds owner
let secondSuperadmin: string; // also platform_admin — for the "two of the SAME tier" case
let candidate: string; // the appointee

/** Every key of a role's bundle, so the CEILING never becomes the thing under test here. The ceiling
 *  has its own suite; a ceiling refusal in this file would look exactly like a D-9 refusal and would
 *  make these assertions lie about what they prove. */
async function godPerms(roleId: string): Promise<PermissionGrant[]> {
  const { rows } = await withGlobal((c) =>
    c.query<{ key: string }>(
      `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1`,
      [roleId],
    ),
  );
  return rows.map((r) => ({ key: r.key, scopeType: "global" as const, scopeId: null }));
}

async function attempt(spec: Partial<GrantSpec> & { roleId: string }): Promise<void> {
  await withGlobal((c) =>
    assertGrantAllowed(c, {
      origin: "two_person_appointment",
      targetUserId: candidate,
      scopeType: "global",
      scopeId: null,
      onConflict: "untargeted",
      ...spec,
    } as GrantSpec),
  );
}

describe.skipIf(!TEST_URL)("IAM-16 · two-person appointment (D-9)", () => {
  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("Appointment Co");
    platformAdminRole = await createRole("platform_admin");
    ownerRole = await createRole("owner");
    managerRole = await createRole("manager");

    superadmin = await createUser("super@appoint.test");
    holdingOwner = await createUser("owner@appoint.test");
    secondSuperadmin = await createUser("super2@appoint.test");
    candidate = await createUser("candidate@appoint.test");

    await grantRole(superadmin, platformAdminRole, "global", null);
    await grantRole(secondSuperadmin, platformAdminRole, "global", null);
    await grantRole(holdingOwner, ownerRole, "company", tenant);
  }, 180_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("🔴 POSITIVE CONTROL — an owner requests, a superadmin decides, and the appointment is ALLOWED", async () => {
    // Without this passing, every refusal below is worthless. Note the direction: the SUPERADMIN
    // decides, because the ceiling requires the decider to hold what is granted and `owner` does not
    // carry platform_admin's keys. That is not a workaround — it is "nobody grants what they do not
    // hold" applied to the platform tier.
    await expect(
      attempt({
        roleId: platformAdminRole,
        requesterUserId: holdingOwner,
        actorUserId: superadmin,
        actorPerms: await godPerms(platformAdminRole),
        tenantId: tenant,
      }),
    ).resolves.not.toThrow();
  });

  it("and in the other direction too — D-9 names the PAIR, not which seat each holds", async () => {
    // Superadmin requests, owner decides. Allowed by the pair rule; the ceiling is satisfied here only
    // because godPerms is supplied, which is exactly why the ceiling is neutralised in this file.
    await expect(
      attempt({
        roleId: ownerRole,
        requesterUserId: superadmin,
        actorUserId: holdingOwner,
        actorPerms: await godPerms(ownerRole),
        tenantId: tenant,
      }),
    ).resolves.not.toThrow();
  });

  it("🔴 refuses when requester and decider are the SAME principal", async () => {
    await expect(
      attempt({
        roleId: platformAdminRole,
        requesterUserId: superadmin,
        actorUserId: superadmin,
        actorPerms: await godPerms(platformAdminRole),
        tenantId: tenant,
      }),
    ).rejects.toThrow(/appointment_not_two_person/);
  });

  it("🔴 refuses TWO PLATFORM ADMINS — the pair must span both tiers, not just be two people", async () => {
    // The heart of the rule. A "two distinct approvers" check satisfied by two holders of the SAME
    // role is a rule one compromised tier can satisfy alone once it has two holders — and appointing
    // more holders is what this flow DOES, so it would bootstrap its own weakening.
    await expect(
      attempt({
        roleId: platformAdminRole,
        requesterUserId: superadmin,
        actorUserId: secondSuperadmin,
        actorPerms: await godPerms(platformAdminRole),
        tenantId: tenant,
      }),
    ).rejects.toThrow(/appointment_pair_incomplete/);
  });

  it("🔴 refuses when the TARGET is also the requester — self-escalation via the unchecked seat", async () => {
    // `assertNotSelfTarget` already refuses the DECIDER targeting themselves. The requester is a
    // SECOND path to the same self-escalation and is not covered by it — this is the case that would
    // have slipped through had the rule only re-used the existing self-target check.
    await expect(
      attempt({
        roleId: platformAdminRole,
        targetUserId: holdingOwner,
        requesterUserId: holdingOwner,
        actorUserId: superadmin,
        actorPerms: await godPerms(platformAdminRole),
        tenantId: tenant,
      }),
    ).rejects.toThrow(/appointment_self_escalation/);
  });

  it("refuses when either half of the pair is missing entirely", async () => {
    await expect(
      attempt({
        roleId: platformAdminRole,
        actorUserId: superadmin,
        actorPerms: await godPerms(platformAdminRole),
        tenantId: tenant,
      }),
    ).rejects.toThrow(/appointment_unwitnessed/);
  });

  it("refuses a pair where neither party is elevated at all", async () => {
    const nobodyA = await createUser("nobody-a@appoint.test");
    const nobodyB = await createUser("nobody-b@appoint.test");
    await expect(
      attempt({
        roleId: platformAdminRole,
        requesterUserId: nobodyA,
        actorUserId: nobodyB,
        actorPerms: await godPerms(platformAdminRole),
        tenantId: tenant,
      }),
    ).rejects.toThrow(/appointment_pair_incomplete/);
  });

  it("the origin does NOT become a general-purpose bypass — scope validity still applies", async () => {
    // Being the path THROUGH the elevated fence is this origin's purpose; being the path through
    // everything else is not. `org_unit_lead` at company scope must still be refused here.
    const oul = await createRole("org_unit_lead");
    await expect(
      attempt({
        roleId: oul,
        scopeType: "company",
        scopeId: tenant,
        requesterUserId: holdingOwner,
        actorUserId: superadmin,
        actorPerms: await godPerms(platformAdminRole),
        tenantId: tenant,
      }),
    ).rejects.toThrow(/org_unit scope/);
  });

  it("a NON-elevated role appointed through this origin still needs the pair", async () => {
    // The origin is not a shortcut for ordinary grants either: it enforces D-9 on whatever it is
    // handed. A caller wanting to grant `manager` should use the ordinary surface.
    await expect(
      attempt({
        roleId: managerRole,
        scopeType: "company",
        scopeId: tenant,
        requesterUserId: superadmin,
        actorUserId: secondSuperadmin,
        actorPerms: await godPerms(managerRole),
        tenantId: tenant,
      }),
    ).rejects.toThrow(/appointment_pair_incomplete/);
  });
});
