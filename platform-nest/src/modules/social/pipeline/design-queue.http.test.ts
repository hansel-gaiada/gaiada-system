// SCP-1h — the Creative step against live Postgres and Cerbos (FRONTEND-BFF-CONTRACT §63.6.6): the designer's queue, the month request's two
// follow-ups, and the request detail's `socialPosts`. Skips without DATABASE_URL_TEST, like every suite here; on CI it runs for real. Every case
// drives the REAL endpoint as a real persona with the real policies, never a service function with the authorization mocked out.
//
// What it proves:
//   (1) the queue: a Creatives designer sees only the posts of a month request whose PM task names them; an in-team designer sees only in_team posts;
//       the HoD (an approver) and the superadmin see nothing as designers; a revision shows the note that asked for it; another company's posts are
//       left out; a person outside the company is refused at the outer gate before the query is read; paging (the cursor) walks the whole queue once;
//   (2) opening a month request needs the company's PM module (409 `request_kind_unavailable`, nothing written), while joining a request that is
//       already open does not; opening the request also writes the intake project's "created" activity once, as `POST requests` does;
//   (3) the request detail lists the posts that joined it (and [] for a hand-filed request);
//   (4) an asset's source and AI note ride on the design read, and an asset left `unknown` is a warning on submit, never a refusal.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialSeat, grantSocialRole } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";

const SVC = { authorization: "Bearer svc-token" };
const as = (id: string) => ({ ...SVC, "x-user-id": id });

// A cycle far enough ahead that every post is on track or tight, never late: the queue's health is then a real computation.
const MONTH = "2040-03-01";
const DEADLINE = "2040-02-26";
const READY_BY = "2040-02-24";

interface Eng { clientId: string; engagementId: string; cycleId: string; clientName: string }

describe.skipIf(!TEST_URL)("SCP-1h · the Creative step (BFF §63.6.6)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let units: Awaited<ReturnType<typeof seedSocialOrgTree>>;
  const U: Record<string, string> = {};
  let n = 0;
  const base = (t = A) => `/api/${t}/modules/social`;

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
  async function freshEngagement(tenant: string, creativeSource: "creatives" | "in_team", officer: string): Promise<Eng> {
    n += 1;
    const clientName = `Mock Client ${n}`;
    const clientId = await createClient(tenant, clientName);
    const engagementId = newId();
    const cycleId = newId();
    await adminPool().query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'active', '{"networks":{"instagram":true}}', $6, '{instagram}', 'central')`,
      [engagementId, tenant, clientId, `Mock engagement ${n}`, officer, creativeSource],
    );
    await adminPool().query(
      `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1, $2, $3, $4, $5, $6, 'central')`,
      [cycleId, tenant, engagementId, MONTH, DEADLINE, READY_BY],
    );
    return { clientId, engagementId, cycleId, clientName };
  }

  /** A post at the HoD's step, written straight to the table (the steps before it are other suites'); the real routes take it from here. */
  async function postAtHod(tenant: string, eng: Eng, title: string): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, format, pipeline_status, status_since, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'feed', 'hod', now(), 'central')`,
      [id, tenant, eng.engagementId, eng.cycleId, title],
    );
    return id;
  }

  const row = async (postId: string) =>
    (await adminPool().query(
      `SELECT pipeline_status, creative_state, creative_source, creative_request_id::text AS creative_request_id, change_note FROM social_posts WHERE id = $1`, [postId],
    )).rows[0] as { pipeline_status: string; creative_state: string | null; creative_source: string | null; creative_request_id: string | null; change_note: string | null };

  async function act(who: string, postId: string, action: string, body: Record<string, unknown> = {}) {
    const expectedStatus = body.expectedStatus ?? (await row(postId)).pipeline_status;
    return app.inject({ method: "POST", url: `${base()}/posts/${postId}/actions`, headers: as(who), payload: { action, expectedStatus, ...body } });
  }

  /** The HoD approves the post for design through the route; the post then sits in `design`. */
  async function approveForDesign(postId: string) {
    const res = await act(U.hod, postId, "approve_for_design");
    if (res.statusCode !== 200) throw new Error(`approve_for_design: ${res.statusCode} ${res.body}`);
    return res;
  }

  /** Creatives names the designer on the month request's task (the PM step Creatives takes in its own board). */
  async function assignDesigner(postId: string, designerId: string) {
    const r = await row(postId);
    if (!r.creative_request_id) throw new Error("no month request on the post");
    await adminPool().query(
      `UPDATE pm_tasks SET assignee = jsonb_set(COALESCE(assignee, '{}'::jsonb), '{responsibleId}', to_jsonb($2::text))
        WHERE id = (SELECT pm_task_id FROM work_requests WHERE id = $1)`,
      [r.creative_request_id, designerId],
    );
  }

  const queue = async (who: string, qs = "", tenant = A) =>
    app.inject({ method: "GET", url: `${base(tenant)}/design-queue${qs}`, headers: as(who) });
  const items = async (who: string, qs = "", tenant = A) => {
    const res = await queue(who, qs, tenant);
    if (res.statusCode !== 200) throw new Error(`design-queue: ${res.statusCode} ${res.body}`);
    return res.json() as { items: Array<Record<string, any>>; nextCursor: string | null };
  };
  const idsOf = async (who: string, qs = "", tenant = A) => (await items(who, qs, tenant)).items.map((i) => i.postId as string).sort();

  // ── setup ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // The posts the suite creates, shared by the cases below (each case reads what an earlier one set up, in this order).
  let c1: Eng; let c2: Eng; let t1: Eng;
  let postC1: string; let postC2: string; let postT1: string;
  let assetUnknown: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("Mock Agency", ["social", "pm"]);
    B = await createCompany("Mock Group Co", ["social", "pm"], A);
    units = await seedSocialOrgTree(A);
    await seedSocialOrgTree(B, units);

    const people = ["officer", "hod", "gm", "designer", "otherDesigner", "inTeamDesigner", "crossDesigner", "outsider", "member"];
    for (const p of people) {
      U[p] = await createUser(`scp1h-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
      if (p === "outsider") continue;
      await addMembership(A, U[p]);
      // The `member` role at company scope, which every staff member holds (derived_roles.yaml `member`).
      await grantSocialRole(A, U[p], "member");
    }
    await grantSocialRole(A, U.inTeamDesigner, "social_designer");
    await grantSocialRole(A, U.crossDesigner, "social_designer");
    await addMembership(B, U.crossDesigner);
    await grantSocialRole(B, U.crossDesigner, "member");
    await grantSocialRole(B, U.crossDesigner, "social_designer");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantSocialRole(A, U.officer, "social_staff");
    U.superadmin = await createUser("scp1h-superadmin@mock.test", "Mock superadmin");
    await grantRole(U.superadmin, await createRole("platform_admin"), "global", null);

    // An Asset Library picture in A, left at the default source (`unknown`).
    assetUnknown = newId();
    await adminPool().query(
      `INSERT INTO creative_assets (id, tenant_id, uploader_id, name, content_type, grade, graded_key, graded_byte_size, origin_site)
       VALUES ($1, $2, $3, 'Mock design', 'image/jpeg', '{}'::jsonb, $4, 1024, 'central')`,
      [assetUnknown, A, U.designer, `mock/${assetUnknown}.jpg`],
    );
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) the queue
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("an empty company has an empty queue for everyone (an honest empty list, not a refusal)", async () => {
    expect(await items(U.designer)).toEqual({ items: [], nextCursor: null });
  });

  it("a Creatives designer sees only the posts of a month request whose task names them", async () => {
    c1 = await freshEngagement(A, "creatives", U.officer);
    c2 = await freshEngagement(A, "creatives", U.officer);
    t1 = await freshEngagement(A, "in_team", U.officer);
    postC1 = await postAtHod(A, c1, "Mock bakery: morning pastries");
    postC2 = await postAtHod(A, c2, "Mock florist: autumn bouquets");
    postT1 = await postAtHod(A, t1, "Mock spa: winter warmth");
    await approveForDesign(postC1);
    await approveForDesign(postC2);
    await approveForDesign(postT1);
    // Two clients, two cycles, two month requests: Creatives names a different designer on each task.
    expect((await row(postC1)).creative_request_id).not.toBe((await row(postC2)).creative_request_id);
    expect((await row(postT1)).creative_request_id).toBeNull();
    await assignDesigner(postC1, U.designer);
    await assignDesigner(postC2, U.otherDesigner);

    expect(await idsOf(U.designer)).toEqual([postC1]);
    expect(await idsOf(U.otherDesigner)).toEqual([postC2]);
    // A member the request does not name sees nothing, and an officer who is not a designer sees nothing either.
    expect(await idsOf(U.member)).toEqual([]);
    expect(await idsOf(U.officer)).toEqual([]);

    const [it1] = (await items(U.designer)).items;
    expect(Object.keys(it1).sort()).toEqual(["clientName", "creativeState", "format", "health", "postId", "readyBy", "revisionNote", "thumbFileId", "title"]);
    expect(it1).toMatchObject({
      postId: postC1, clientName: c1.clientName, title: "Mock bakery: morning pastries", format: "feed", creativeState: "not_started",
      revisionNote: null, readyBy: READY_BY, thumbFileId: null,
    });
    expect(it1.health).toMatchObject({ readyBy: READY_BY });
    expect(["on_track", "tight", "at_risk"]).toContain(it1.health.state);
  });

  it("an in-team designer sees only in_team posts, and a Creatives designer never sees one", async () => {
    expect(await idsOf(U.inTeamDesigner)).toEqual([postT1]);
    expect(await idsOf(U.designer)).not.toContain(postT1);
    // The in-team designer holds no fact on a Creatives post: not named on its request's task.
    expect(await idsOf(U.inTeamDesigner)).not.toContain(postC1);
  });

  it("the HoD and the superadmin see nothing as designers (the approvers hold neither fact)", async () => {
    expect(await idsOf(U.hod)).toEqual([]);
    expect(await idsOf(U.gm)).toEqual([]);
    expect(await idsOf(U.superadmin)).toEqual([]);
  });

  it("a revision shows the note that asked for it, and leaves the queue once the design is submitted", async () => {
    // The final check sends the post back for a change to the design (loop c): the case is `final_design`, the state `revision`.
    await adminPool().query(
      `UPDATE social_posts SET pipeline_status = 'changes', change_by = 'final', change_kind = 'design', return_to = 'final',
              change_note = $2, creative_state = 'revision', status_since = now() WHERE id = $1`,
      [postC1, "The logo is too small; move it to the top corner."],
    );
    const [it1] = (await items(U.designer)).items;
    expect(it1).toMatchObject({ postId: postC1, creativeState: "revision", revisionNote: "The logo is too small; move it to the top corner." });
    // A post that is not a revision carries no note even if an old one is stored: only the `changes` status shows it.
    await adminPool().query(`UPDATE social_posts SET change_by = NULL, change_kind = NULL, return_to = NULL, change_note = NULL, pipeline_status = 'design', creative_state = 'in_progress' WHERE id = $1`, [postC1]);
    expect((await items(U.designer)).items[0]).toMatchObject({ postId: postC1, creativeState: "in_progress", revisionNote: null });
    // A copy change is the officer's, not the designer's: it is not in the designer's queue.
    await adminPool().query(
      `UPDATE social_posts SET pipeline_status = 'changes', change_by = 'final', change_kind = 'copy', return_to = 'final', change_note = 'Fix the price.' WHERE id = $1`, [postC1]);
    expect(await idsOf(U.designer)).toEqual([]);
    // A post past the design step (the final check) is not either.
    await adminPool().query(
      `UPDATE social_posts SET pipeline_status = 'final', change_by = NULL, change_kind = NULL, return_to = NULL, change_note = NULL, creative_state = 'submitted' WHERE id = $1`, [postC1]);
    expect(await idsOf(U.designer)).toEqual([]);
    // Back to the design step for the cases below.
    await adminPool().query(`UPDATE social_posts SET pipeline_status = 'design', creative_state = 'not_started' WHERE id = $1`, [postC1]);
    expect(await idsOf(U.designer)).toEqual([postC1]);
  });

  it("another company's posts are left out: the queue is the caller's company, whatever they hold elsewhere", async () => {
    const b = await freshEngagement(B, "in_team", U.crossDesigner);
    const postB = newId();
    await adminPool().query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, format, pipeline_status, status_since, creative_source, creative_state, origin_site)
       VALUES ($1, $2, $3, $4, 'Mock co-owner post', 'feed', 'design', now(), 'in_team', 'not_started', 'central')`,
      [postB, B, b.engagementId, b.cycleId],
    );
    // crossDesigner holds social_designer in A and in B: each company's queue lists that company's in-team posts only.
    expect(await idsOf(U.crossDesigner, "", A)).toEqual([postT1]);
    expect(await idsOf(U.crossDesigner, "", B)).toEqual([postB]);
    expect(await idsOf(U.inTeamDesigner, "", A)).toEqual([postT1]);
  });

  it("the outer gate is work_request read: a person outside the company is refused (403) before the query is read", async () => {
    const res = await queue(U.outsider, "?limit=0");
    expect(res.statusCode).toBe(403);
    expect((await queue(U.outsider)).statusCode).toBe(403);
  });

  it("pages walk the whole queue once, in ready-by order; a bad limit or cursor is a 400 with the field", async () => {
    // Three more in-team posts: the in-team designer now has four, in a stable order.
    const t2 = await freshEngagement(A, "in_team", U.officer);
    const extra: string[] = [];
    for (const title of ["Mock spa: a", "Mock spa: b", "Mock spa: c"]) {
      const id = await postAtHod(A, t2, title);
      await approveForDesign(id);
      extra.push(id);
    }
    const all = [postT1, ...extra].sort();
    expect(await idsOf(U.inTeamDesigner)).toEqual(all);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await items(U.inTeamDesigner, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.postId as string));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(2);
    expect([...seen].sort()).toEqual(all);
    expect(new Set(seen).size).toBe(4);

    for (const [qs, field] of [["?limit=0", "limit"], ["?limit=101", "limit"], ["?limit=abc", "limit"], ["?cursor=garbage", "cursor"]] as const) {
      const res = await queue(U.inTeamDesigner, qs);
      expect([res.statusCode, res.json().error, res.json().field], qs).toEqual([400, "invalid_field", field]);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) the month request's two follow-ups
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("opening the month request writes the intake project's 'created' activity once, as POST requests does", async () => {
    const acts = await adminPool().query(
      `SELECT metadata, actor_id::text AS actor_id FROM activities WHERE tenant_id = $1 AND verb = 'created' AND target_entity_type = 'project'`, [A]);
    // Two month requests were opened to Creatives (c1, c2): the intake project exists once, so the activity does too.
    expect(acts.rows).toHaveLength(1);
    expect(acts.rows[0].metadata).toMatchObject({ name: "Creatives · Requests", intakeFor: units.creatives });
    expect(acts.rows[0].actor_id).toBe(U.hod);
    const projects = await adminPool().query(`SELECT count(*)::int AS n FROM projects WHERE tenant_id = $1 AND department_id = $2`, [A, units.creatives]);
    expect(projects.rows[0].n).toBe(1);
  });

  it("with the PM module off, approving for design refuses to open a month request (409), and joining an open one still works", async () => {
    const eng = await freshEngagement(A, "creatives", U.officer);
    const first = await postAtHod(A, eng, "Mock gym: new classes");
    await approveForDesign(first); // PM is on: the cycle's request opens
    const requestId = (await row(first)).creative_request_id;
    expect(requestId).toBeTruthy();

    const other = await freshEngagement(A, "creatives", U.officer);
    const blocked = await postAtHod(A, other, "Mock gym: summer sale");
    const requestsBefore = (await adminPool().query(`SELECT count(*)::int AS n FROM work_requests WHERE tenant_id = $1`, [A])).rows[0].n;

    await adminPool().query(`UPDATE companies SET enabled_modules = array_remove(enabled_modules, 'pm') WHERE id = $1`, [A]);
    try {
      // A cycle with no open request: opening one needs PM, exactly as POST requests (assets) does.
      const refused = await act(U.hod, blocked, "approve_for_design");
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("request_kind_unavailable");
      const after = await row(blocked);
      expect(after).toMatchObject({ pipeline_status: "hod", creative_request_id: null, creative_source: null });
      expect((await adminPool().query(`SELECT count(*)::int AS n FROM work_requests WHERE tenant_id = $1`, [A])).rows[0].n).toBe(requestsBefore);
      const hand = await app.inject({
        method: "POST", url: `/api/${A}/requests`, headers: as(U.officer),
        payload: { kind: "assets", toUnitId: units.creatives, title: "Hand-filed with PM off", form: { deliverables: [{ format: "image", size: "1080x1080", quantity: 1 }] } },
      });
      expect([hand.statusCode, hand.json().reason]).toEqual([409, "request_kind_unavailable"]); // the same refusal, the same code

      // A second post of the cycle whose request is still open joins it: no new task is needed.
      const second = await postAtHod(A, eng, "Mock gym: trainer of the month");
      const joined = await act(U.hod, second, "approve_for_design");
      expect(joined.statusCode).toBe(200);
      expect((await row(second)).creative_request_id).toBe(requestId);
      // An in-team client never needs a request, so PM being off does not touch it.
      const inTeam = await freshEngagement(A, "in_team", U.officer);
      const teamPost = await postAtHod(A, inTeam, "Mock spa: new menu");
      expect((await act(U.hod, teamPost, "approve_for_design")).statusCode).toBe(200);
    } finally {
      await adminPool().query(`UPDATE companies SET enabled_modules = array_append(array_remove(enabled_modules, 'pm'), 'pm') WHERE id = $1`, [A]);
    }
    // With PM back on the refused post goes through and opens its request.
    expect((await act(U.hod, blocked, "approve_for_design")).statusCode).toBe(200);
    expect((await row(blocked)).creative_request_id).toBeTruthy();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) the request detail
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("the request detail lists the posts that joined it; a hand-filed request lists none", async () => {
    const requestId = (await row(postC1)).creative_request_id!;
    const res = await app.inject({ method: "GET", url: `/api/${A}/requests/${requestId}`, headers: as(U.designer) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(requestId);
    expect(body.socialPosts).toEqual([{
      postId: postC1, title: "Mock bakery: morning pastries", clientName: c1.clientName, pipelineStatus: "design", creativeState: "not_started",
      href: `/departments/${units.socialMedia}/posts/${postC1}`,
    }]);
    // The detail keeps every field it had.
    expect(body).toMatchObject({ kind: "assets", status: "open", assets: [], assetCount: 0 });

    const hand = await app.inject({
      method: "POST", url: `/api/${A}/requests`, headers: as(U.officer),
      payload: { kind: "assets", toUnitId: units.creatives, title: "Hand-filed banner", form: { deliverables: [{ format: "image", size: "1080x1080", quantity: 1 }] } },
    });
    expect(hand.statusCode).toBe(201);
    const detail = await app.inject({ method: "GET", url: `/api/${A}/requests/${hand.json().id}`, headers: as(U.officer) });
    expect(detail.json().socialPosts).toEqual([]);

    // A second post of the cycle joins the same request and is listed beside the first.
    const second = await postAtHod(A, c1, "Mock bakery: sourdough Saturday");
    await approveForDesign(second);
    const both = await app.inject({ method: "GET", url: `/api/${A}/requests/${requestId}`, headers: as(U.designer) });
    expect(both.json().socialPosts.map((p: { postId: string }) => p.postId).sort()).toEqual([postC1, second].sort());
  });

  it("the request detail of another company's request is a 404, never its posts", async () => {
    const requestId = (await row(postC1)).creative_request_id!;
    const res = await app.inject({ method: "GET", url: `/api/${B}/requests/${requestId}`, headers: as(U.crossDesigner) });
    expect(res.statusCode).toBe(404);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) the asset's own source and note, on the design read
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("a design's asset carries its source and AI note; an unknown source is a warning on submit, never a refusal", async () => {
    const designer = U.designer;
    expect((await act(designer, postC1, "start_design")).statusCode).toBe(200);
    const add = await app.inject({
      method: "POST", url: `${base()}/posts/${postC1}/designs`, headers: as(designer),
      payload: { expectedStatus: "design", assetGroupId: assetUnknown },
    });
    expect(add.statusCode).toBe(201);
    const read = async () => (await app.inject({ method: "GET", url: `${base()}/posts/${postC1}/pipeline`, headers: as(designer) })).json();
    expect((await read()).designs[0].asset).toMatchObject({ groupId: assetUnknown, source: "unknown", aiNote: null });

    // The asset's source is set where it is saved (the Asset Library); the post's read follows it.
    await adminPool().query(`UPDATE creative_assets SET source = 'ai', ai_note = 'Background from an image model; the text is set by hand.' WHERE id = $1`, [assetUnknown]);
    expect((await read()).designs[0].asset).toMatchObject({ source: "ai", aiNote: "Background from an image model; the text is set by hand." });
    await adminPool().query(`UPDATE creative_assets SET source = 'unknown', ai_note = NULL WHERE id = $1`, [assetUnknown]);

    const submitted = await act(designer, postC1, "submit_design");
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().warnings).toContain("design_source_unknown");
    expect((await row(postC1)).pipeline_status).toBe("final");
  });
});
