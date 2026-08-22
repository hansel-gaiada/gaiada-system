// IAM-SEC-02 / IAM-SEC-04 — a role may only be granted at a scope its own Cerbos condition
// can actually satisfy. Started as "the two elevated roles are global-only"; generalised
// 2026-08-12 once the widened hazard detector found the same shape pointing the other way.
//
// THE DEFECT THIS PINS (found by IAM-04-ROLLOUT-B12, 2026-08-11; fixed at the source in
// `admin-identity.controller.ts`'s `GLOBAL_ONLY_ROLES` guard):
//
// Both roles' Cerbos derived roles match ONLY `g.scopeType == "global"`, so a company-scoped grant
// of either confers nothing through the ROLE arm. But `assemblePrincipal()` resolves `perms` from
// `role_permissions` carrying the GRANT's own scope — so `platform_admin @ company:X` yields all
// 215 grantable permissions AT COMPANY X, which the `perm_*` derived roles honour. That is the
// permission arm granting what the role arm denies: the same defect class the IAM-04 pilot caught
// for `team_lead`×`pm_task`, but arising from a wildcard/unconditional rule rather than same-rule
// mixing — a shape `permission-arm-hazard-scan.test.ts` structurally cannot see.
//
// It was REACHABLE, not theoretical: `assignRole` is authorized by `user:create`, which
// `company_admin` holds — so a company admin could mint `platform_admin@their-own-company` and pick
// up the permissions their own bundle lacks, inside their own tenant. That also breaks D-9's
// no-self-escalation safeguard.
//
// Both directions are pinned below: the refusal, AND that legitimate grants still work — a guard
// that over-refuses would be its own outage.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";
import { config } from "../config";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("IAM-SEC-02/04 — a role is grantable only at scopes its Cerbos condition satisfies", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin: string;
  let target: string;
  let platformAdminRole: string;
  let groupExecRole: string;
  let managerRole: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    tenant = await createCompany("IAMSEC02 Co", ["agency"]);
    admin = await createUser("iamsec02-admin@a.test");
    target = await createUser("iamsec02-target@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, target);

    // The caller is a PLATFORM ADMIN, deliberately: the strongest possible caller. If even they
    // cannot mint a scoped elevated grant, no weaker caller can either.
    platformAdminRole = await createRole("platform_admin");
    groupExecRole = await createRole("group_executive");
    managerRole = await createRole("manager");
    await (await import("../testing/fixtures")).grantRole(admin, platformAdminRole, "global", null);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const assign = (roleId: string, scopeType: string, scopeId?: string | null) =>
    app.inject({
      method: "POST",
      url: `/api/${tenant}/users/${target}/roles`,
      headers: asUser(admin),
      payload: { roleId, scopeType, scopeId },
    });

  // ── the refusal: both elevated roles, every non-global scope ──────────────────────────────
  it("refuses platform_admin at company scope with a clean 400, never a 500 and never a grant", () => {
    return assign(platformAdminRole, "company", tenant).then((res) => {
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("global scope");
    });
  });

  it("🔴 IAM-15 — group_executive is refused at company scope by the FENCE now, not the scope guard", () => {
    // The refusal survives, but its REASON changed and that distinction is the point of this case.
    // Before: `ROLE_SCOPE_CONSTRAINTS` mapped the role to `["global"]`, so a company-scoped grant
    // failed the scope guard with "global scope". That entry is gone — the map is machine-checked
    // against derived_roles.yaml, which no longer defines the role, so keeping it would fail that
    // guard instead.
    //
    // What refuses it now is the elevated fence (IAM-16), which lists `group_executive` in
    // ELEVATED_TIER defensively precisely so that a re-created role cannot be granted from this
    // surface at ANY scope. Asserting the new message rather than deleting the case keeps a test on
    // the path a resurrected role would take.
    return assign(groupExecRole, "company", tenant).then((res) => {
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("elevated_role_forbidden");
    });
  });

  it("refuses platform_admin at project scope", () =>
    assign(platformAdminRole, "project", "11111111-1111-1111-1111-111111111111").then((res) => {
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("global scope");
    }));

  // ── IAM-SEC-04 (2026-08-12): the guard generalised beyond the two elevated roles ───────────
  //
  // The widened hazard detector swept all 68 kinds and found the SAME shape in the other direction:
  // `client`'s Cerbos condition is company-ONLY (`resource_portal.yaml`) and `org_unit_lead`'s is
  // org_unit-ONLY (`appraisal`, `report_document`). Nothing stopped a `company_admin` minting
  // `client@global` or `org_unit_lead@company` — inert today ONLY because those three kinds carry no
  // `perm_*` mirror yet, which is a property of where the rollout happens to be, not a safeguard.
  // `GLOBAL_ONLY_ROLES` became `ROLE_SCOPE_CONSTRAINTS` (role -> allowed scope types) to cover both
  // directions, and `permission-arm-hazard-scan.test.ts` re-derives that map from
  // `derived_roles.yaml` so it cannot drift from the policy it claims to mirror.
  it("refuses client at GLOBAL scope — its Cerbos condition is company-only", async () => {
    const clientRole = await createRole("client");
    const res = await assign(clientRole, "global", null);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("company scope");
  });

  it("still permits client at COMPANY scope — the scope it is actually for", async () => {
    const clientRole = await createRole("client");
    const res = await assign(clientRole, "company", tenant);
    expect([200, 201]).toContain(res.statusCode);
  });

  it("refuses org_unit_lead at COMPANY scope — its Cerbos condition is org_unit-only", async () => {
    const oul = await createRole("org_unit_lead");
    const res = await assign(oul, "company", tenant);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("org_unit scope");
  });

  // ── IAM-16 — THIS PIN WAS REVERSED (2026-08-23), AND THE REVERSAL IS THE TICKET ────────────
  // It used to read "still permits an elevated role at GLOBAL scope", holding open the door design
  // §6.3.6 described as remaining "until IAM-16's two-person appointment flow exists". That flow now
  // exists (`iam:appointment` + the `two_person_appointment` origin), so the door is shut and the
  // assertion is inverted rather than deleted — an inverted pin records that the behaviour changed
  // on purpose, where a deleted one would just look like lost coverage.
  //
  // ⚠ The refusal is only safe because appointment is reachable another way. Closing this with no
  // replacement path would have made appointing a second platform_admin impossible, which is the
  // failure the Phase-3 readiness assessment refused to ship.
  it("🔴 REFUSES an elevated role at GLOBAL scope — the legacy admin door is closed", async () => {
    const res = await assign(platformAdminRole, "global", null);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("elevated_role_forbidden");
  });

  it("still permits a NON-elevated role at company scope", () =>
    assign(managerRole, "company", tenant).then((res) => {
      expect([200, 201]).toContain(res.statusCode);
    }));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// IAM-SEC-05 (2026-08-12) — inviteUser's OWN optional initial-role grant, unguarded until now.
//
// THE DEFECT: `inviteUser` (`POST /:tenantId/users`) mints its optional initial role grant with a
// HARDCODED 'company' scope and only a role-EXISTENCE check — never `ROLE_SCOPE_CONSTRAINTS`. A
// `company_admin` (or any caller holding `user:create`) could invite an arbitrary target with
// `roleId` = platform_admin's/org_unit_lead's id and mint `platform_admin@company:X` /
// `org_unit_lead@company:X` — the exact IAM-SEC-02/04 self/other-escalation shape
// `ROLE_SCOPE_CONSTRAINTS` exists to make structurally impossible, reachable through the ONE writer
// that guard was never wired onto. Fixed by routing this grant through the SAME
// `assertRoleScopeAllowed()` helper `assignRole` calls (admin-identity.controller.ts) rather than a
// second hand-written check — see that file's comments.
//
// Both directions pinned below, same discipline as the block above: the refusal (400, no row at
// ALL — see the no-partial-state case), AND that a legitimate company-scoped invite-with-a-role
// still succeeds. A guard that breaks onboarding is its own outage.
describe.skipIf(!TEST_URL)("IAM-SEC-05 — inviteUser's optional role grant honours the SAME scope guard as assignRole", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin: string;
  let platformAdminRole: string;
  let orgUnitLeadRole: string;
  let clientRole: string;
  let managerRole: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    tenant = await createCompany("IAMSEC05 Co", ["agency"]);
    admin = await createUser("iamsec05-admin@a.test");
    await addMembership(tenant, admin);

    platformAdminRole = await createRole("platform_admin");
    orgUnitLeadRole = await createRole("org_unit_lead");
    clientRole = await createRole("client");
    managerRole = await createRole("manager");
    // The caller is a platform admin — deliberately the strongest possible caller, same reasoning
    // as the block above: if even they cannot mint a mis-scoped grant through inviteUser, no weaker
    // caller (e.g. a plain company_admin, who also holds user:create) can either.
    await (await import("../testing/fixtures")).grantRole(admin, platformAdminRole, "global", null);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  let seq = 0;
  const invite = (roleId: string | undefined, emailPrefix: string) => {
    const email = `${emailPrefix}-${seq++}@iamsec05.test`;
    return app
      .inject({
        method: "POST",
        url: `/api/${tenant}/users`,
        headers: asUser(admin),
        payload: { name: "Invitee", email, roleId },
      })
      .then((res) => ({ res, email }));
  };

  // ── the refusal, both mis-scopable roles ────────────────────────────────────────────────────
  it("refuses to invite-with platform_admin (company is the ONLY scope this endpoint can express) with a clean 400", async () => {
    const { res } = await invite(platformAdminRole, "invite-pa");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("global scope");
  });

  it("refuses to invite-with org_unit_lead — its Cerbos condition is org_unit-only, never company", async () => {
    const { res } = await invite(orgUnitLeadRole, "invite-oul");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("org_unit scope");
  });

  // ── no partial state on refusal: NOT EVEN the user/membership rows exist ────────────────────
  it("a refused invite leaves NO row at all — not the user, not the membership, not the grant", async () => {
    const { res, email } = await invite(platformAdminRole, "invite-nopartial");
    expect(res.statusCode).toBe(400);
    const users = await adminPool().query(`SELECT id FROM users WHERE email = $1`, [email]);
    expect(
      users.rows,
      "the scope check runs before any write in inviteUser specifically so a refusal can never " +
        "leave a user provisioned with a silently-dropped role, or any other half-applied state",
    ).toHaveLength(0);
  });

  // ── the happy path: a real, in-use flow must keep working ───────────────────────────────────
  it("still permits inviting with `client` — company is exactly the scope client's condition allows", async () => {
    const { res, email } = await invite(clientRole, "invite-client");
    expect([200, 201]).toContain(res.statusCode);
    const { id: userId } = res.json() as { id: string };
    const grant = await adminPool().query(
      `SELECT ur.scope_type, ur.scope_id FROM user_roles ur WHERE ur.user_id = $1 AND ur.role_id = $2`,
      [userId, clientRole],
    );
    expect(grant.rows).toHaveLength(1);
    expect(grant.rows[0].scope_type).toBe("company");
    expect(grant.rows[0].scope_id).toBe(tenant);
    const users = await adminPool().query(`SELECT id FROM users WHERE email = $1`, [email]);
    expect(users.rows).toHaveLength(1);
  });

  it("still permits inviting with a plain, non-constrained role (manager) at company scope", async () => {
    const { res } = await invite(managerRole, "invite-manager");
    expect([200, 201]).toContain(res.statusCode);
  });

  it("still permits inviting with NO role at all (the roleId-less onboarding flow)", async () => {
    const { res } = await invite(undefined, "invite-norole");
    expect([200, 201]).toContain(res.statusCode);
  });
});
