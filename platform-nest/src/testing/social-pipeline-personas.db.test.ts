// SCP-1o (plan §11.2) — the stage-machine test personas are all reachable from the fixtures: two Officers, the Copywriter, the HoD, a second approver (the
// GM), the owner, a company admin with no Social seat, a designer, and a client contact. The designer on a client-month request is the inline setup of
// `pipeline-authz.db.test.ts` (a PM task's responsible person on the request); the in-team designer is the `social_designer` persona, used here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { initTestDb, teardownTestDb, TEST_URL } from "./setup";
import { createClient, createUser, addMembership } from "./fixtures";
import { seedPersonaTenant, type PersonaTenant } from "./personas";
import { SOCIAL_UNITS, grantSocialRole, grantSocialSeat, placeOfficerOnAllocation, seedSocialOrgTree } from "./social-pipeline-fixtures";
import { loadSocialApproverIds, loadSocialPostAuthz } from "../modules/social/pipeline-authz";

describe.skipIf(!TEST_URL)("SCP-1o · the §11.2 test personas, reachable from the fixtures (real Postgres)", () => {
  let p: PersonaTenant;
  let hod: string, gm: string, owner: string;

  beforeAll(async () => {
    await initTestDb();
    p = await seedPersonaTenant(["company_admin", "social_copywriter", "social_designer", "client_contact"], "scp1o-personas");
    await seedSocialOrgTree(p.tenantId);
    hod = await createUser(`${newId()}@scp1o.test`, "SCP HoD");
    gm = await createUser(`${newId()}@scp1o.test`, "SCP GM");
    owner = await createUser(`${newId()}@scp1o.test`, "SCP owner");
    for (const u of [hod, gm, owner]) await addMembership(p.tenantId, u);
    await grantSocialSeat(p.tenantId, SOCIAL_UNITS.socialMedia, hod);
    await grantSocialSeat(p.tenantId, SOCIAL_UNITS.gm, gm);
    await grantSocialRole(p.tenantId, owner, "owner");
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("every persona of §11.2 exists, and the company admin, the owner and the client hold no seat", async () => {
    for (const k of ["company_admin", "social_copywriter", "social_designer", "client_contact"] as const) expect(p.users[k], k).toBeTruthy();
    const ids = await withTenants([p.tenantId], (c) => loadSocialApproverIds(c, p.tenantId));
    expect(ids).toEqual([hod, gm].map((x) => x.toLowerCase()).sort());
    for (const out of [p.users.company_admin!, owner, p.users.client_contact!, p.users.social_copywriter!, p.users.social_designer!]) expect(ids).not.toContain(out.toLowerCase());
  });

  it("placeOfficerOnAllocation puts two Officers on two clients, each the owner of their own client's posts only", async () => {
    const mk = async (name: string) => {
      const clientId = await createClient(p.tenantId, name);
      const engagementId = newId();
      const postId = newId();
      await withTenants([p.tenantId], async (c) => {
        await c.query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, origin_site) VALUES ($1, $2, $3, $4, $5)`, [engagementId, p.tenantId, clientId, name, config.originSite]);
        await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site) VALUES ($1, $2, $3, 'SCP1o post', $4)`, [postId, p.tenantId, engagementId, config.originSite]);
      }, { modules: ["social"] });
      return { engagementId, postId };
    };
    const a = await mk("SCP1o Client A");
    const b = await mk("SCP1o Client B");
    const officer1 = await placeOfficerOnAllocation(p.tenantId, a.engagementId);
    const officer2 = await placeOfficerOnAllocation(p.tenantId, b.engagementId);
    expect(officer1).not.toBe(officer2);
    const fa = await withTenants([p.tenantId], (c) => loadSocialPostAuthz(c, p.tenantId, a.postId));
    const fb = await withTenants([p.tenantId], (c) => loadSocialPostAuthz(c, p.tenantId, b.postId));
    expect(fa?.ownerId).toBe(officer1);
    expect(fb?.ownerId).toBe(officer2);
    // an existing user may be placed too (the Officer of both clients)
    expect(await placeOfficerOnAllocation(p.tenantId, b.engagementId, officer1)).toBe(officer1);
    expect((await withTenants([p.tenantId], (c) => loadSocialPostAuthz(c, p.tenantId, b.postId)))?.ownerId).toBe(officer1);
  });
});
