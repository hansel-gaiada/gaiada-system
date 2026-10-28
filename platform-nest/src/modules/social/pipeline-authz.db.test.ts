// SCP-1b (docs/PERMISSION-CONTRACT.md §53.4, §53.5; BFF §63.3.3) — the facts Cerbos sees for the pipeline, read from the
// rows: `loadSocialApproverIds` (the HoD and GM seats, per company) and `loadSocialPostAuthz` (the post's officer, maker,
// month-request assignees and creative source), against real Postgres under the app role.
//
// The seat rule is §50's (DW-10g-2): an active position carrying its org_unit_lead role row, an open assignment. The units
// are found by NAME (workspace slugs `social-media` and `gm`), so the fixture's node ids are deliberately arbitrary, and
// company B reuses company A's ids for the tenant trap.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient, createProject } from "../../testing/fixtures";
import { SOCIAL_UNITS, grantSocialSeat, seedSocialOrgTree, setEngagementOfficer } from "../../testing/social-pipeline-fixtures";
import {
  loadSocialApproverIds, loadSocialPostAuthz, loadSocialPostAuthzMany, socialApproverUnitIds, socialEngagementResource, socialPostResource, socialReportResource,
} from "./pipeline-authz";

describe("socialApproverUnitIds (pure)", () => {
  const dept = (id: string, name: string, children: unknown[] = []) => ({ id, name, kind: "department", children });
  const tree = { root: { id: "r", name: "Root", kind: "company", children: [dept("x-gm", "GM"), dept("x-div", "Marketing", [dept("x-sm", "Social Media")]), dept("x-web", "Web Dev")] } };
  it("is the Social Media and GM departments, by name, for an agency", () => {
    expect(socialApproverUnitIds(tree, "agency")).toEqual(["x-gm", "x-sm"]);
  });
  it("is empty for a vertical with no social-media / gm workspace, and for no tree", () => {
    expect(socialApproverUnitIds(tree, "hospitality")).toEqual([]);
    expect(socialApproverUnitIds(null, "agency")).toEqual([]);
  });
});

describe("the three resource shapes (pure)", () => {
  it("social_post carries every §63.3.3 attribute from the facts", () => {
    expect(socialPostResource("t", {
      postId: "p", engagementId: "e", pipelineStatus: "hod", ownerId: "o", creatorId: "c",
      approverIds: ["a"], assigneeIds: ["s"], creativeSource: "creatives",
    })).toEqual({
      kind: "social_post", id: "p", tenantId: "t", module: "social", ownerId: "o", creatorId: "c",
      approverIds: ["a"], assigneeIds: ["s"], creativeSource: "creatives",
    });
  });
  it("social_engagement and social_report carry module social and approverIds, and no ownerId", () => {
    expect(socialEngagementResource("t", ["a"], "e")).toEqual({ kind: "social_engagement", id: "e", tenantId: "t", module: "social", approverIds: ["a"] });
    expect(socialEngagementResource("t", [])).toEqual({ kind: "social_engagement", tenantId: "t", module: "social", approverIds: [] });
    expect(socialReportResource("t", "r", ["a"])).toEqual({ kind: "social_report", id: "r", tenantId: "t", module: "social", approverIds: ["a"] });
    expect(socialReportResource("t", "", [])).toEqual({ kind: "social_report", tenantId: "t", module: "social", approverIds: [] });
  });
});

describe.skipIf(!TEST_URL)("SCP-1b · loadSocialApproverIds and loadSocialPostAuthz (real Postgres)", () => {
  let A: string; // the agency
  let B: string; // another agency of the same group (a child of A), with the SAME node ids
  let G: string; // a company with no agency vertical (no Social Media workspace)
  let hod: string, gm: string, webHead: string, divisionHead: string, endedHod: string, noRoleHod: string, hodB: string, officer: string, author: string, designer: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("SCP1b Agency A", ["social"]);
    B = await createCompany("SCP1b Agency B", ["social"], A); // a group company under A: one root, so a session may span both
    G = await createCompany("SCP1b Generic", ["social"]);
    await seedSocialOrgTree(A);
    await seedSocialOrgTree(B); // the same ids, on purpose
    hod = await createUser("hod@scp1b.test");
    gm = await createUser("gm@scp1b.test");
    webHead = await createUser("webhead@scp1b.test");
    divisionHead = await createUser("division@scp1b.test");
    endedHod = await createUser("ended@scp1b.test");
    noRoleHod = await createUser("norole@scp1b.test");
    hodB = await createUser("hod-b@scp1b.test");
    officer = await createUser("officer@scp1b.test");
    author = await createUser("author@scp1b.test");
    designer = await createUser("designer@scp1b.test");
    for (const u of [hod, gm, webHead, divisionHead, endedHod, noRoleHod, officer, author, designer]) await addMembership(A, u);
    await addMembership(B, hodB);
    await addMembership(B, hod); // a member of B too, with no seat there
    await grantSocialSeat(A, SOCIAL_UNITS.socialMedia, hod);
    await grantSocialSeat(A, SOCIAL_UNITS.gm, gm);
    await grantSocialSeat(A, SOCIAL_UNITS.webDev, webHead); // the head of an unrelated unit
    await grantSocialSeat(A, SOCIAL_UNITS.division, divisionHead); // an ANCESTOR of Social Media
    await grantSocialSeat(A, SOCIAL_UNITS.socialMedia, endedHod, { ended: true }); // a closed assignment
    await grantSocialSeat(A, SOCIAL_UNITS.socialMedia, noRoleHod, { noRole: true }); // is_lead without the role row
    await grantSocialSeat(B, SOCIAL_UNITS.socialMedia, hodB); // another company's same-id unit
    // G has the same tree shape but no agency vertical: the name resolves to no workspace there.
    await addMembership(G, gm);
    await withTenants([G], (c) =>
      c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1, $2, $3)`, [
        G, JSON.stringify({ root: { id: "r", name: "Root", kind: "company", children: [{ id: SOCIAL_UNITS.gm, name: "GM", kind: "department", children: [] }] } }), config.originSite,
      ]),
    );
    await grantSocialSeat(G, SOCIAL_UNITS.gm, gm);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("the Social Media seat and the GM seat, and nobody else (unrelated head, ancestor head, ended, role-row-less excluded)", async () => {
    const ids = await withTenants([A], (c) => loadSocialApproverIds(c, A));
    expect(ids).toEqual([hod, gm].map((x) => x.toLowerCase()).sort());
    for (const out of [webHead, divisionHead, endedHod, noRoleHod, hodB]) expect(ids).not.toContain(out.toLowerCase());
  });

  it("THE TENANT TRAP: company B's list holds its own seat only, never A's same-id seat holders, and A's never holds B's", async () => {
    const idsB = await withTenants([B], (c) => loadSocialApproverIds(c, B));
    expect(idsB).toEqual([hodB.toLowerCase()]);
    // read under a session that can see both companies: still per company
    const idsA = await withTenants([A, B], (c) => loadSocialApproverIds(c, A));
    expect(idsA).not.toContain(hodB.toLowerCase());
  });

  it("a company whose vertical has no Social Media / GM workspace has no seat approvers", async () => {
    expect(await withTenants([G], (c) => loadSocialApproverIds(c, G))).toEqual([]);
  });

  it("a company with no org tree has no seat approvers", async () => {
    const empty = await createCompany("SCP1b Empty", ["social"]);
    expect(await withTenants([empty], (c) => loadSocialApproverIds(c, empty))).toEqual([]);
  });

  it("loadSocialPostAuthz: a non-uuid or unknown post is null", async () => {
    expect(await withTenants([A], (c) => loadSocialPostAuthz(c, A, "not-a-uuid"))).toBeNull();
    expect(await withTenants([A], (c) => loadSocialPostAuthz(c, A, newId()))).toBeNull();
  });

  it("loadSocialPostAuthz: every value from the rows (officer, maker, month-request assignees, creative source, seats)", async () => {
    const clientId = await createClient(A, "SCP1b Brand");
    const engagementId = newId();
    const postId = newId();
    const project = await createProject(A, "SCP1b content month");
    const taskId = newId();
    const requestId = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, origin_site) VALUES ($1, $2, $3, 'SCP1b engagement', $4)`,
        [engagementId, A, clientId, config.originSite],
      );
      await c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, assignee, origin_site)
         VALUES ($1, $2, $3, 'Content month', jsonb_build_object('responsibleId', $4::text), $5)`,
        [taskId, A, project, designer, config.originSite],
      );
      await c.query(
        `INSERT INTO work_requests (id, tenant_id, kind, requested_by, title, origin_site, to_unit_id, pm_task_id)
         VALUES ($1, $2, 'assets', $3, 'Content month assets', $4, $5, $6)`,
        [requestId, A, hod, config.originSite, SOCIAL_UNITS.creatives, taskId],
      );
      // A Composer-shaped row (pipeline_status NULL) carrying the pipeline's maker and design facts: the loader reads the
      // columns whatever the status, and the CHECKs allow these on a non-pipeline row.
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site, author_id, creative_source, creative_request_id)
         VALUES ($1, $2, $3, 'SCP1b post', $4, $5, 'creatives', $6)`,
        [postId, A, engagementId, config.originSite, author, requestId],
      );
    }, { modules: ["social"] });
    await setEngagementOfficer(A, engagementId, officer);

    const facts = await withTenants([A], (c) => loadSocialPostAuthz(c, A, postId));
    expect(facts).toEqual({
      postId, engagementId, pipelineStatus: null,
      ownerId: officer, creatorId: author,
      approverIds: [hod, gm].map((x) => x.toLowerCase()).sort(),
      assigneeIds: [designer.toLowerCase()],
      creativeSource: "creatives",
    });
    // SCP-3g: the batched loader is the one builder: the same facts per post, keyed lower case; unknown and non-uuid ids
    // (and repeats) have no entry.
    const many = await withTenants([A], (c) => loadSocialPostAuthzMany(c, A, [postId.toUpperCase(), newId(), "not-a-uuid", postId]));
    expect([...many.keys()]).toEqual([postId.toLowerCase()]);
    expect(many.get(postId.toLowerCase())).toEqual(facts);
    expect((await withTenants([A], (c) => loadSocialPostAuthzMany(c, A, []))).size).toBe(0);
    // Another company's session cannot read it (RLS), so a cross-company id answers null.
    expect(await withTenants([B], (c) => loadSocialPostAuthz(c, B, postId))).toBeNull();
    expect((await withTenants([B], (c) => loadSocialPostAuthzMany(c, B, [postId]))).size).toBe(0);

    // Unfed facts answer the fail-closed defaults: no officer, no author, no request, no source.
    await setEngagementOfficer(A, engagementId, null);
    await withTenants([A], (c) => c.query(
      `UPDATE social_posts SET author_id = NULL, creative_source = NULL, creative_request_id = NULL WHERE id = $1`, [postId],
    ), { modules: ["social"] });
    const bare = await withTenants([A], (c) => loadSocialPostAuthz(c, A, postId));
    expect(bare).toMatchObject({ ownerId: "", creatorId: "", assigneeIds: [], creativeSource: "" });
  });
});
