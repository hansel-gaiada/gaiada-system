// P2-04 — the choke point, proven through the REAL endpoints (`app.inject`), not just units.
//
// Two things are pinned here, and they pull in opposite directions on purpose:
//
//   1. THE ONE INTENDED NEW REFUSAL — `target == caller` is now a clean 400 on BOTH legacy
//      writers (design §6.4, D-9's no-self-escalation). Nothing else about the legacy admin
//      surface changed, so every other case below is a "still works" case.
//
//   2. NO OVER-REFUSAL. A guard that breaks the working grant surface is its own outage — the
//      same both-directions discipline `global-only-role-scope.test.ts` was written with. So:
//      granting to somebody else still works, inviting with a role still works, and revoking
//      your OWN grant still works (a de-escalation is not an escalation; P2-02's structural
//      Cerbos DENY is scoped to `actions: ["create"]` for exactly this reason).
//
// The refusal is proven at the STORAGE layer too, not just by status code: a refused self-grant
// must leave no `user_roles` row behind, and a refused self-invite must not have half-onboarded
// anybody — that is why `inviteUser` resolves its target read-only BEFORE any write.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";
import { config } from "../config";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("P2-04 — GrantWriteService choke point, driven through the real endpoints", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin: string;
  let adminEmail: string;
  let target: string;
  let managerRole: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    tenant = await createCompany("P204 Co", ["agency"]);
    adminEmail = "p204-admin@a.test";
    admin = await createUser(adminEmail);
    target = await createUser("p204-target@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, target);

    // Deliberately the STRONGEST possible caller — a global platform_admin. If even they cannot
    // self-grant, no weaker caller can. (Same reasoning as global-only-role-scope.test.ts's own
    // persona choice.) It also proves the refusal is not an authorization artefact: this caller
    // passes `authorize(user:create)` with room to spare.
    const platformAdminRole = await createRole("platform_admin");
    await grantRole(admin, platformAdminRole, "global", null);
    managerRole = await createRole("manager");

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const assign = (targetUserId: string, roleId: string, scopeType = "company", scopeId?: string | null) =>
    app.inject({
      method: "POST",
      url: `/api/${tenant}/users/${targetUserId}/roles`,
      headers: asUser(admin),
      payload: { roleId, scopeType, scopeId: scopeId === undefined ? tenant : scopeId },
    });

  const grantCount = async (userId: string, roleId: string): Promise<number> => {
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_roles WHERE user_id = $1 AND role_id = $2`,
      [userId, roleId],
    );
    return Number(rows[0].n);
  };

  // ── 1. THE intended new refusal ─────────────────────────────────────────────────────────────
  describe("self-target is refused (the ONE behavioural change this ticket makes)", () => {
    it("assignRole: granting a role to YOURSELF is a clean 400, never a 500 and never a grant", async () => {
      const before = await grantCount(admin, managerRole);
      const res = await assign(admin, managerRole);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("self_grant_forbidden");
      expect(
        await grantCount(admin, managerRole),
        "the refusal must run BEFORE the insert — a 400 that still wrote the row would be the " +
          "escalation with extra steps",
      ).toBe(before);
    });

    it("inviteUser: inviting your OWN email WITH a role is a clean 400 and writes no grant", async () => {
      const before = await grantCount(admin, managerRole);
      const res = await app.inject({
        method: "POST",
        url: `/api/${tenant}/users`,
        headers: asUser(admin),
        payload: { name: "Self", email: adminEmail, roleId: managerRole },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("self_grant_forbidden");
      expect(await grantCount(admin, managerRole)).toBe(before);
    });

    it("inviteUser: the self-target refusal runs before ANY write — no membership churn, no activity", async () => {
      const activitiesBefore = await adminPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM activities WHERE target_entity_id = $1`,
        [admin],
      );
      const res = await app.inject({
        method: "POST",
        url: `/api/${tenant}/users`,
        headers: asUser(admin),
        payload: { name: "Self Again", email: adminEmail, roleId: managerRole },
      });
      expect(res.statusCode).toBe(400);
      const activitiesAfter = await adminPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM activities WHERE target_entity_id = $1`,
        [admin],
      );
      expect(
        activitiesAfter.rows[0].n,
        "a refused invite must leave NO half-applied state — the same property IAM-SEC-05 pinned " +
          "for the scope refusal, now holding for the self-target refusal too",
      ).toBe(activitiesBefore.rows[0].n);
    });
  });

  // ── 2. everything else on this surface is UNCHANGED ─────────────────────────────────────────
  describe("no over-refusal — the legacy admin surface still does what it did", () => {
    it("assignRole to SOMEBODY ELSE still succeeds and still bumps their session (D11)", async () => {
      const sv = async () => {
        const { rows } = await adminPool().query<{ session_version: number }>(
          `SELECT session_version FROM users WHERE id = $1`,
          [target],
        );
        return rows[0].session_version;
      };
      const before = await sv();
      const res = await assign(target, managerRole);
      expect(res.statusCode).toBe(201);
      expect((res.json() as { grantId: string }).grantId).toBeTruthy();
      expect(await sv()).toBe(before + 1);
    });

    it("inviteUser with an initial role still succeeds and the grant lands at company scope", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/${tenant}/users`,
        headers: asUser(admin),
        payload: { name: "Fresh Hire", email: "p204-fresh@a.test", roleId: managerRole },
      });
      expect([200, 201]).toContain(res.statusCode);
      const { id: newUserId } = res.json() as { id: string };
      const { rows } = await adminPool().query<{ scope_type: string; scope_id: string }>(
        `SELECT scope_type, scope_id FROM user_roles WHERE user_id = $1 AND role_id = $2`,
        [newUserId, managerRole],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].scope_type).toBe("company");
      expect(rows[0].scope_id).toBe(tenant);
    });

    it("inviteUser with NO role still succeeds (the roleId-less onboarding flow never touches the choke point)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/${tenant}/users`,
        headers: asUser(admin),
        payload: { name: "No Role", email: "p204-norole@a.test" },
      });
      expect([200, 201]).toContain(res.statusCode);
    });

    it("revoking your OWN grant still works — a de-escalation is not an escalation", async () => {
      // Give the admin a grant directly (fixture writer, not the endpoint), then have them revoke
      // it through the real endpoint. If the self-target refusal had been applied to revokes too,
      // this would 400 and an admin could never drop their own role.
      const selfRole = await createRole("p204_self_revocable");
      await grantRole(admin, selfRole, "company", tenant);
      const { rows } = await adminPool().query<{ id: string }>(
        `SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`,
        [admin, selfRole],
      );
      const res = await app.inject({
        method: "DELETE",
        url: `/api/${tenant}/users/${admin}/roles/${rows[0].id}`,
        headers: asUser(admin),
      });
      expect(res.statusCode).toBe(200);
      expect(await grantCount(admin, selfRole)).toBe(0);
    });

    it("revoking a grant id that belongs to a DIFFERENT user is still a 404 (the user_id pin survived the move)", async () => {
      const other = await createUser("p204-other@a.test");
      await addMembership(tenant, other);
      const r = await assign(other, managerRole);
      expect(r.statusCode).toBe(201);
      const { grantId } = r.json() as { grantId: string };
      const res = await app.inject({
        method: "DELETE",
        url: `/api/${tenant}/users/${target}/roles/${grantId}`, // wrong user for this grant id
        headers: asUser(admin),
      });
      expect(res.statusCode).toBe(404);
      expect(await grantCount(other, managerRole)).toBe(1); // and it is still there
    });

    it("an unknown roleId is still a 400 'unknown role', at the same point in the flow as before", async () => {
      const res = await assign(target, "11111111-1111-1111-1111-111111111111");
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("unknown role");
    });
  });
});
