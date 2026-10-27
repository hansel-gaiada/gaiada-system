// SCP-1q (SCP-Q23; docs/PERMISSION-CONTRACT.md §53.4 "A gap outside SCP", plan §8 row 1q and §10 "Self-promotion into a lead seat") —
// nobody can make themselves a head: not by editing a position they hold, and not by assigning themselves to a lead seat.
//
// Driven through `app.inject()` against real Postgres + a restarted test Cerbos. Before this change `position` · `update` had no
// self-DENY, so a company_admin (or HR, or the superadmin) could move the position they hold onto the Social Media unit, or attach
// `org_unit_lead` to it, and become a lead seat: a social approver (`loadSocialApproverIds`) and every other lead-seat authority.
//
// THE THREE ATTACKS, each tried as a plain member, a manager, a company_admin and an hr_manager (hr_people_ops), every one of whom
// holds a seat of their own, and each refused:
//   1. move my own lead seat onto the Social Media unit            (PATCH  positions/:id {unitNodeId})
//   2. attach org_unit_lead to my own seat on the Social Media unit (POST   positions/:id/roles), and detach a role from my seat
//   3. assign myself to the Social Media lead position              (POST   positions/:id/assign and /assignment-requests)
// After every attempt `loadSocialApproverIds` still does not list the person, and the rows are unchanged.
//
// THE CONTROLS (a test that only refuses proves nothing): ANOTHER company_admin, who does not hold the position, makes the very
// same edits and they succeed, and the person then IS a social approver. So the refusals above are the DENY, not a broken route.
// A company_admin and the superadmin who hold a seat edit another person's seat freely and are refused only on their own.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";
import { config } from "../config";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, addMembership, grantRole, grantLeadSeat } from "../testing/fixtures";
import { SOCIAL_UNITS, grantSocialSeat, seedSocialOrgTree } from "../testing/social-pipeline-fixtures";
import { loadSocialApproverIds } from "../modules/social/pipeline-authz";

const live = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const ROLES = ["member", "manager", "company_admin", "hr_manager"] as const;
type Tier = (typeof ROLES)[number];

describe.skipIf(!TEST_URL || !live)("SCP-1q — nobody edits a position they hold, so nobody makes themselves a head", () => {
  let app: NestFastifyApplication;
  let T: string;
  let leadRoleId: string;
  let headUser: string;
  let socialLeadPosition: string;
  let admin2: string;

  /** Per tier: the person, a LEAD seat on Web Dev (attack 1), a no-role seat on Social Media (attack 2). */
  const actor = {} as Record<Tier, { user: string; webSeat: string; socialSeat: string }>;

  const approvers = () => withTenants([T], (c) => loadSocialApproverIds(c, T));
  const unitOf = async (positionId: string) =>
    (await withTenants([T], (c) => c.query<{ unit_node_id: string }>(`SELECT unit_node_id FROM positions WHERE id = $1`, [positionId]))).rows[0].unit_node_id;
  const titleOf = async (positionId: string) =>
    (await withTenants([T], (c) => c.query<{ title: string }>(`SELECT title FROM positions WHERE id = $1`, [positionId]))).rows[0].title;
  const roleRows = async (positionId: string) =>
    (await withTenants([T], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM position_roles WHERE position_id = $1`, [positionId]))).rows[0].n;

  const patch = (actorId: string, positionId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/${T}/positions/${positionId}`, headers: asUser(actorId), payload });
  const attach = (actorId: string, positionId: string) =>
    app.inject({
      method: "POST", url: `/api/${T}/positions/${positionId}/roles`, headers: asUser(actorId),
      payload: { roleId: leadRoleId, scopeKind: "own_unit" },
    });
  const detach = (actorId: string, positionId: string) =>
    app.inject({ method: "DELETE", url: `/api/${T}/positions/${positionId}/roles/${leadRoleId}`, headers: asUser(actorId) });

  /** The house refusal: 403 with the `not authorized` message (the same shape the self-assign DENY answers). */
  const expectRefused = (res: { statusCode: number; body: string }) => {
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("not authorized");
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.positionSyncEnabled = true;

    T = await createCompany("Self Edit Co", ["hr", "reports"]);
    await seedSocialOrgTree(T);
    leadRoleId = await createRole("org_unit_lead");

    admin2 = await createUser("pse-admin2@a.test");
    await addMembership(T, admin2);
    await grantRole(admin2, await createRole("company_admin"), "company", T);

    app = await buildApp();
    // Build the org closure through the real pipeline (a PUT of the seeded tree), as production does.
    const structure = (
      await withTenants([T], (c) => c.query<{ structure: unknown }>(`SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [T]))
    ).rows[0].structure;
    const put = await app.inject({ method: "PUT", url: `/api/${T}/org-structure`, headers: asUser(admin2), payload: structure as object });
    expect(put.statusCode).toBe(200);

    // The company's real Social Media head, and the lead position the attackers try to join.
    headUser = await createUser("pse-head@a.test");
    await addMembership(T, headUser);
    socialLeadPosition = await grantSocialSeat(T, SOCIAL_UNITS.socialMedia, headUser);

    for (const tier of ROLES) {
      const user = await createUser(`pse-${tier}@a.test`);
      await addMembership(T, user);
      await grantRole(user, await createRole(tier), "company", T);
      actor[tier] = {
        user,
        webSeat: await grantSocialSeat(T, SOCIAL_UNITS.webDev, user), // a lead seat on ANOTHER unit
        socialSeat: await grantLeadSeat(T, SOCIAL_UNITS.socialMedia, user, { noRole: true }), // a staff seat on Social Media
      };
    }
  });

  afterAll(async () => {
    config.positionSyncEnabled = false;
    await app?.close();
    await teardownTestDb();
  });

  it("the starting point: the Social Media head is the only social approver, and no attacker is", async () => {
    expect(await approvers()).toEqual([headUser]);
  });

  for (const tier of ROLES) {
    describe(`as a ${tier} who holds a seat`, () => {
      it("1. moving their own lead seat onto the Social Media unit is refused, and they do not become an approver", async () => {
        const a = actor[tier];
        expectRefused(await patch(a.user, a.webSeat, { unitNodeId: SOCIAL_UNITS.socialMedia }));
        expect(await unitOf(a.webSeat)).toBe(SOCIAL_UNITS.webDev);
        expect(await approvers()).not.toContain(a.user);
      });

      it("1b. editing any other field of their own seat (title, is_lead) is refused too", async () => {
        const a = actor[tier];
        const before = await titleOf(a.webSeat);
        expectRefused(await patch(a.user, a.webSeat, { title: "Self-promoted", isLead: true }));
        expect(await titleOf(a.webSeat)).toBe(before);
      });

      it("2. attaching org_unit_lead to their own seat on the Social Media unit is refused, and they do not become an approver", async () => {
        const a = actor[tier];
        expect(await roleRows(a.socialSeat)).toBe("0");
        expectRefused(await attach(a.user, a.socialSeat));
        expect(await roleRows(a.socialSeat)).toBe("0");
        expect(await approvers()).not.toContain(a.user);
      });

      it("2b. detaching a role from their own seat is refused too, and the row stays", async () => {
        const a = actor[tier];
        expect(await roleRows(a.webSeat)).toBe("1");
        expectRefused(await detach(a.user, a.webSeat));
        expect(await roleRows(a.webSeat)).toBe("1");
      });

      it("3. assigning themselves to the Social Media lead position, directly or by a request, is refused", async () => {
        const a = actor[tier];
        expectRefused(
          await app.inject({
            method: "POST", url: `/api/${T}/positions/${socialLeadPosition}/assign`, headers: asUser(a.user), payload: { userId: a.user },
          }),
        );
        expectRefused(
          await app.inject({
            method: "POST", url: `/api/${T}/positions/${socialLeadPosition}/assignment-requests`, headers: asUser(a.user),
            payload: { userId: a.user, justification: "I would like to lead" },
          }),
        );
        expect(await approvers()).toEqual([headUser]);
      });
    });
  }

  describe("the controls: the DENY is not a blanket refusal", () => {
    it("ANOTHER company_admin moves a person's lead seat onto Social Media, and that person becomes an approver (the attack was real)", async () => {
      const victim = await createUser("pse-ctl1@a.test");
      await addMembership(T, victim);
      const seat = await grantSocialSeat(T, SOCIAL_UNITS.webDev, victim);
      expect(await approvers()).not.toContain(victim);
      const res = await patch(admin2, seat, { unitNodeId: SOCIAL_UNITS.socialMedia });
      expect(res.statusCode).toBe(200);
      expect(await unitOf(seat)).toBe(SOCIAL_UNITS.socialMedia);
      expect(await approvers()).toContain(victim);
    });

    it("ANOTHER company_admin attaches org_unit_lead to a person's Social Media seat, and that person becomes an approver", async () => {
      const victim = await createUser("pse-ctl2@a.test");
      await addMembership(T, victim);
      const seat = await grantLeadSeat(T, SOCIAL_UNITS.socialMedia, victim, { noRole: true });
      expect(await approvers()).not.toContain(victim);
      const res = await attach(admin2, seat);
      expect(res.statusCode).toBe(201);
      expect(await roleRows(seat)).toBe("1");
      expect(await approvers()).toContain(victim);
    });

    it("ANOTHER company_admin detaches that role again (and the person stops being an approver)", async () => {
      const victim = await createUser("pse-ctl3@a.test");
      await addMembership(T, victim);
      const seat = await grantSocialSeat(T, SOCIAL_UNITS.socialMedia, victim);
      expect(await approvers()).toContain(victim);
      const res = await detach(admin2, seat);
      expect(res.statusCode).toBe(200);
      expect(await approvers()).not.toContain(victim);
    });

    it("a company_admin who holds a seat edits ANOTHER person's seat freely, and is refused only on their own", async () => {
      const holder = actor.company_admin;
      const other = await grantLeadSeat(T, SOCIAL_UNITS.creatives, await createUser("pse-ctl4@a.test"), { noRole: true });
      expect((await patch(holder.user, other, { title: "Edited by another admin" })).statusCode).toBe(200);
      expect(await titleOf(other)).toBe("Edited by another admin");
      expectRefused(await patch(holder.user, holder.webSeat, { title: "Edited by me" }));
    });

    it("the SUPERADMIN who holds a seat is refused on their own seat, the wildcard included, and edits another's", async () => {
      const sa = await createUser("pse-superadmin@a.test");
      await addMembership(T, sa);
      await grantRole(sa, await createRole("platform_admin"), "global", null);
      const mine = await grantLeadSeat(T, SOCIAL_UNITS.creatives, sa, { noRole: true });
      const theirs = await grantLeadSeat(T, SOCIAL_UNITS.creatives, await createUser("pse-ctl5@a.test"), { noRole: true });
      expectRefused(await patch(sa, mine, { unitNodeId: SOCIAL_UNITS.socialMedia }));
      expectRefused(await attach(sa, mine));
      expect(await unitOf(mine)).toBe(SOCIAL_UNITS.creatives);
      expect((await patch(sa, theirs, { title: "Edited by the superadmin" })).statusCode).toBe(200);
    });

    it("an ended assignment is not a hold: someone whose seat closed may edit that position again (open means no valid_to)", async () => {
      const former = await createUser("pse-former@a.test");
      await addMembership(T, former);
      await grantRole(former, await createRole("company_admin"), "company", T);
      const seat = await grantLeadSeat(T, SOCIAL_UNITS.creatives, former, { noRole: true, ended: true });
      expect((await patch(former, seat, { title: "No longer mine" })).statusCode).toBe(200);
    });

    it("a nonexistent position is a 404, as before (the holder lookup does not change the answer or leak existence)", async () => {
      const res = await patch(admin2, "00000000-0000-4000-8000-000000000000", { title: "x" });
      expect(res.statusCode).toBe(404);
    });
  });

  it("the list tells each viewer which seats they hold, and only that (heldByMe)", async () => {
    const a = actor.company_admin;
    const res = await app.inject({ method: "GET", url: `/api/${T}/positions`, headers: asUser(a.user) });
    expect(res.statusCode).toBe(200);
    const byId = new Map(res.json().positions.map((p: { id: string; heldByMe: boolean }) => [p.id, p.heldByMe]));
    expect(byId.get(a.webSeat)).toBe(true);
    expect(byId.get(a.socialSeat)).toBe(true);
    expect(byId.get(socialLeadPosition)).toBe(false);
    expect(byId.get(actor.member.webSeat)).toBe(false);
    // no holder id is ever listed
    expect(res.body).not.toContain("holderIds");
  });
});
