// SCP-1r (plan decision SCP-D7, applying owner ruling SCP-Q23; docs/PERMISSION-CONTRACT.md §53.4) -- nobody renames, re-types, moves
// or deletes an org unit they hold a live lead seat on, so nobody makes themselves a Social Media or GM approver by editing the tree.
//
// Driven through `app.inject()` against real Postgres + a restarted test Cerbos (a skip is not a pass). Before this change a
// company_admin who led some OTHER unit could rename it "Social Media" through `PUT /api/:tenantId/org-structure` (or re-type a
// division named "GM" into a department) and become one of the four approvers alone, seat unchanged: the approvers' units are found
// BY NAME (`socialApproverUnitIds`, `gmUnitIds`).
//
// THE ATTACKS, each by a company_admin who holds a lead seat, and each refused with the house 403 (`not authorized`), the stored tree
// unchanged and `loadSocialApproverIds` still not listing them:
//   1. rename the unit they lead to "Social Media"
//   2. re-type the division they lead (named "GM") into a department, so it reads as the GM unit
//   3. move (re-parent) the unit they lead
//   4. delete the unit they lead, alone or inside a deleted parent
// THE CONTROLS (a test that only refuses proves nothing): ANOTHER company_admin, who leads nothing, makes the same edits and they
// succeed, and the person then IS an approver (so the attack was real); the leader edits a unit they do not lead, and edits that
// leave their own unit alone (assignee, a new child, a re-order), freely; a staff seat without the lead role row, an ended seat and
// a retired position are not a live lead seat; the superadmin who leads a unit is refused the same way, the wildcard included.
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

type N = { id: string; name: string; kind: string; assigneeId?: string | null; assigneeName?: string | null; children?: N[] };

/** A division that is NOT yet a department, named like the GM unit: re-typing it is the "reads as the GM unit" attack. */
const SHADOW_GM = "dv-gm-shadow";
const NEW_NODE = (id: string, name: string, kind: string): N => ({ id, name, kind, assigneeId: null, assigneeName: null, children: [] });

function find(root: N, id: string): N | null {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}
function parentOf(root: N, id: string): N | null {
  for (const c of root.children ?? []) {
    if (c.id === id) return root;
    const f = parentOf(c, id);
    if (f) return f;
  }
  return null;
}
const detach = (root: N, id: string): N => {
  const p = parentOf(root, id)!;
  const node = find(root, id)!;
  p.children = p.children!.filter((c) => c.id !== id);
  return node;
};

describe.skipIf(!TEST_URL || !live)("SCP-1r -- nobody renames, re-types, moves or deletes a unit they lead", () => {
  let app: NestFastifyApplication;
  let T: string;
  let admin2: string; // another company_admin: leads nothing
  let headUser: string; // the company's real Social Media head
  let leader: string; // a company_admin who leads Web Dev, and the shadow GM division inside it
  let leaderOnlyOnShadow: string;

  const stored = async (): Promise<N> =>
    (await withTenants([T], (c) => c.query<{ structure: { root: N } }>(`SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [T]))).rows[0].structure.root;
  const approvers = () => withTenants([T], (c) => loadSocialApproverIds(c, T));

  /** PUT the stored tree with `edit` applied, as `actorId`. */
  const putEdited = async (actorId: string, edit: (root: N) => void) => {
    const root = await stored();
    edit(root);
    return app.inject({ method: "PUT", url: `/api/${T}/org-structure`, headers: asUser(actorId), payload: { root } });
  };
  /** The house refusal: 403 with the `not authorized` message, as every Cerbos denial answers. */
  const expectRefused = (res: { statusCode: number; body: string }) => {
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("not authorized");
  };
  /** Refused, and nothing moved: the stored tree is byte-for-byte what it was. */
  const expectUntouched = async (before: N) => expect(await stored()).toEqual(before);

  const newAdmin = async (email: string, role = "company_admin"): Promise<string> => {
    const id = await createUser(email);
    await addMembership(T, id);
    await grantRole(id, await createRole(role), "company", T);
    return id;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    T = await createCompany("Unit Self Edit Co", ["hr", "reports"]);
    await seedSocialOrgTree(T);
    app = await buildApp();

    admin2 = await newAdmin("use-admin2@a.test");

    // The starting tree, through the real pipeline (a PUT, which also builds the closure): the seeded tree plus a division named
    // like the GM unit under Web Dev, a unit with children to move, and a unit pair for the delete-a-parent case.
    const seeded = await stored();
    find(seeded, SOCIAL_UNITS.webDev)!.children = [NEW_NODE(SHADOW_GM, "GM", "division"), NEW_NODE("dv-frontend", "Frontend", "division")];
    find(seeded, SOCIAL_UNITS.creatives)!.children = [NEW_NODE("dv-studio", "Studio", "division")];
    const put = await app.inject({ method: "PUT", url: `/api/${T}/org-structure`, headers: asUser(admin2), payload: { root: seeded } });
    expect(put.statusCode).toBe(200);

    headUser = await createUser("use-head@a.test");
    await addMembership(T, headUser);
    await grantSocialSeat(T, SOCIAL_UNITS.socialMedia, headUser);

    leader = await newAdmin("use-leader@a.test");
    await grantSocialSeat(T, SOCIAL_UNITS.webDev, leader); // a lead seat on Web Dev
    leaderOnlyOnShadow = await newAdmin("use-shadow@a.test");
    await grantSocialSeat(T, SHADOW_GM, leaderOnlyOnShadow); // a lead seat on the shadow GM division only
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("the starting point: the Social Media head is the only approver, and neither leader is one", async () => {
    expect(await approvers()).toEqual([headUser]);
  });

  it("a PUT that changes nothing is allowed for everyone, a leader included (the guard reads the diff, not the person)", async () => {
    expect((await putEdited(leader, () => {})).statusCode).toBe(200);
    expect((await putEdited(admin2, () => {})).statusCode).toBe(200);
  });

  describe("the attacks, by a company_admin who leads the unit", () => {
    it("1. renaming the unit they lead to \"Social Media\" is refused, and they do not become an approver", async () => {
      const before = await stored();
      expectRefused(await putEdited(leader, (r) => { find(r, SOCIAL_UNITS.webDev)!.name = "Social Media"; }));
      await expectUntouched(before);
      expect(await approvers()).toEqual([headUser]);
    });

    it("1b. any rename of the unit they lead is refused, even a harmless one", async () => {
      const before = await stored();
      expectRefused(await putEdited(leader, (r) => { find(r, SOCIAL_UNITS.webDev)!.name = "Web Development"; }));
      await expectUntouched(before);
    });

    it("2. re-typing the division they lead (named GM) into a department, so it reads as the GM unit, is refused", async () => {
      const before = await stored();
      expectRefused(await putEdited(leaderOnlyOnShadow, (r) => { find(r, SHADOW_GM)!.kind = "department"; }));
      await expectUntouched(before);
      expect(await approvers()).not.toContain(leaderOnlyOnShadow);
    });

    it("3. moving (re-parenting) the unit they lead is refused", async () => {
      const before = await stored();
      expectRefused(await putEdited(leader, (r) => { find(r, SOCIAL_UNITS.division)!.children!.push(detach(r, SOCIAL_UNITS.webDev)); }));
      await expectUntouched(before);
    });

    it("4. deleting the unit they lead is refused", async () => {
      const before = await stored();
      expectRefused(await putEdited(leaderOnlyOnShadow, (r) => { detach(r, SHADOW_GM); }));
      await expectUntouched(before);
    });

    it("4b. deleting a parent whose subtree holds the unit they lead is refused too (the led unit is removed with it)", async () => {
      const before = await stored();
      expectRefused(await putEdited(leaderOnlyOnShadow, (r) => { detach(r, SOCIAL_UNITS.webDev); }));
      await expectUntouched(before);
    });

    it("5. the same edits in ONE request (rename + re-type + move) are refused as a whole, and nothing is half-applied", async () => {
      const before = await stored();
      expectRefused(
        await putEdited(leader, (r) => {
          find(r, SOCIAL_UNITS.creatives)!.name = "Creatives Studio"; // a unit they do not lead: fine on its own
          find(r, SOCIAL_UNITS.webDev)!.name = "Social Media";
        }),
      );
      await expectUntouched(before);
    });
  });

  describe("the controls: the guard is not a blanket refusal", () => {
    it("the leader edits a unit they do NOT lead freely (rename, re-type, move)", async () => {
      const res = await putEdited(leader, (r) => { find(r, SOCIAL_UNITS.creatives)!.name = "Creatives Studio"; });
      expect(res.statusCode).toBe(200);
      expect(find(await stored(), SOCIAL_UNITS.creatives)!.name).toBe("Creatives Studio");
      expect((await putEdited(leader, (r) => { find(r, SOCIAL_UNITS.creatives)!.name = "Creatives"; })).statusCode).toBe(200);
    });

    it("the leader makes edits that leave their own unit alone: an assignee, a new child, a re-order of siblings", async () => {
      const res = await putEdited(leader, (r) => {
        Object.assign(find(r, SOCIAL_UNITS.webDev)!, { assigneeId: headUser, assigneeName: "Mock Head" });
        find(r, SOCIAL_UNITS.webDev)!.children!.push(NEW_NODE("dv-backend", "Backend", "division"));
        r.children!.reverse();
      });
      expect(res.statusCode).toBe(200);
      expect(find(await stored(), "dv-backend")).toBeTruthy();
      expect(find(await stored(), SOCIAL_UNITS.webDev)!.name).toBe("Web Dev");
    });

    it("a staff seat (no lead role row), an ended lead seat and a retired lead position are NOT a live lead seat: those holders may edit", async () => {
      const staff = await newAdmin("use-staff@a.test");
      await grantLeadSeat(T, SOCIAL_UNITS.gm, staff, { noRole: true });
      const former = await newAdmin("use-former@a.test");
      await grantLeadSeat(T, SOCIAL_UNITS.gm, former, { ended: true });
      const retired = await newAdmin("use-retired@a.test");
      await grantLeadSeat(T, SOCIAL_UNITS.gm, retired, { status: "retired" });
      for (const [who, name] of [[staff, "GM Staffed"], [former, "GM Former"], [retired, "GM Retired"], [admin2, "GM"]] as const) {
        const res = await putEdited(who, (r) => { find(r, SOCIAL_UNITS.gm)!.name = name; });
        expect(res.statusCode, name).toBe(200);
      }
      expect(find(await stored(), SOCIAL_UNITS.gm)!.name).toBe("GM");
    });

    it("ANOTHER company_admin renames the leader's unit to \"Social Media\", and the leader then IS an approver (the attack was real)", async () => {
      expect(await approvers()).toEqual([headUser]);
      const res = await putEdited(admin2, (r) => { find(r, SOCIAL_UNITS.webDev)!.name = "Social Media"; });
      expect(res.statusCode).toBe(200);
      expect(await approvers()).toEqual([headUser, leader].sort());
      // and put back, so the rest of the file starts clean
      expect((await putEdited(admin2, (r) => { find(r, SOCIAL_UNITS.webDev)!.name = "Web Dev"; })).statusCode).toBe(200);
      expect(await approvers()).toEqual([headUser]);
    });

    it("ANOTHER company_admin re-types the shadow GM division, deletes it, and moves the leader's unit", async () => {
      expect((await putEdited(admin2, (r) => { find(r, SHADOW_GM)!.kind = "department"; })).statusCode).toBe(200);
      expect(await approvers()).toEqual([headUser, leaderOnlyOnShadow].sort());
      expect((await putEdited(admin2, (r) => { detach(r, SHADOW_GM); })).statusCode).toBe(200);
      expect(find(await stored(), SHADOW_GM)).toBeNull();
      expect(await approvers()).toEqual([headUser]);
      expect((await putEdited(admin2, (r) => { find(r, SOCIAL_UNITS.division)!.children!.push(detach(r, SOCIAL_UNITS.webDev)); })).statusCode).toBe(200);
      expect(parentOf(await stored(), SOCIAL_UNITS.webDev)!.id).toBe(SOCIAL_UNITS.division);
    });
  });

  describe("the superadmin", () => {
    it("is refused on a unit they lead, the wildcard included, and edits any other unit freely", async () => {
      const sa = await createUser("use-superadmin@a.test");
      await addMembership(T, sa);
      await grantRole(sa, await createRole("platform_admin"), "global", null);
      await grantSocialSeat(T, SOCIAL_UNITS.creatives, sa);
      const before = await stored();
      expectRefused(await putEdited(sa, (r) => { find(r, SOCIAL_UNITS.creatives)!.name = "Social Media"; }));
      expectRefused(await putEdited(sa, (r) => { detach(r, SOCIAL_UNITS.creatives); }));
      await expectUntouched(before);
      expect((await putEdited(sa, (r) => { find(r, SOCIAL_UNITS.gm)!.name = "GM Office"; })).statusCode).toBe(200);
      expect((await putEdited(sa, (r) => { find(r, SOCIAL_UNITS.gm)!.name = "GM"; })).statusCode).toBe(200);
    });
  });

  describe("what is unchanged", () => {
    it("a non-administrator is still refused (before any of this), and a first write (no stored tree) is not guarded", async () => {
      const member = await createUser("use-member@a.test");
      await addMembership(T, member);
      expectRefused(await putEdited(member, () => {}));

      const T2 = await createCompany("Unit Self Edit Fresh Co", ["hr", "reports"]);
      const admin = await createUser("use-fresh-admin@a.test");
      await addMembership(T2, admin);
      await grantRole(admin, await createRole("company_admin"), "company", T2);
      await grantLeadSeat(T2, "d-anything", admin);
      const first = await app.inject({
        method: "PUT", url: `/api/${T2}/org-structure`, headers: asUser(admin),
        payload: { root: { id: "root-2", name: "Fresh", kind: "company", children: [NEW_NODE("d-anything", "Anything", "department")] } },
      });
      expect(first.statusCode).toBe(200);
    });

    it("the validation answer is unchanged: a body with no root is a 400 for an administrator", async () => {
      const res = await app.inject({ method: "PUT", url: `/api/${T}/org-structure`, headers: asUser(admin2), payload: { nothing: true } });
      expect(res.statusCode).toBe(400);
    });
  });
});
