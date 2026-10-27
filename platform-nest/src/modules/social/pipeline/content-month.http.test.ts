// SCP-1n — the content month in PM (FRONTEND-BFF-CONTRACT §63.13, §63.5, §63.1 item 5) against live Postgres and Cerbos, through the real routes as
// real personas. Skips without DATABASE_URL_TEST, like every suite here; on CI it runs for real.
//
// What it proves:
//   (1) `PUT cycles` creates ONE PM task per cycle in the engagement's project: "<Month YYYY> content", due on the cycle's ready-by, the Ball and the
//       Responsible on the officer, linked to the cycle. A re-run updates it (due date, officer) and never duplicates it; each row of the answer names
//       the task, or says why there is none (no project, or a deleted one);
//   (2) the pipeline writes its progress: counted posts past client approval ÷ the target; done when every counted post is approved (and the target is
//       met); reopened when one goes back to the client (reschedule, a Composer edit), when a new post arrives, and done again when it is decided or
//       discarded. Extra posts are not counted. A change of the buffer moves the task's due date with the cycle's ready-by;
//   (3) NO PM task is created per post: the number of the company's tasks does not move across a full walk of a post;
//   (4) task links: the PM routes accept `linkedType: 'social_post'` + `linkedId` (create and patch, cleared with nulls), validated (a post of another
//       company, a post the caller cannot read, half a pair, another type and a malformed id are refused), `GET posts/:postId/pipeline` lists the tasks
//       linked to the post and never the content-month task, and no route moves the content-month task's link (409 `task_link_locked`).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient, createProject } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialSeat, grantSocialRole, setEngagementOfficer } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { MUST_HAVE_KEYS } from "./handoff-checks";

const FUTURE = "2027-03-10T10:00:00.000Z";
const LATER = "2027-03-12T10:00:00.000Z";
const MONTH = "2027-03";
const DEADLINE = "2027-02-26";
const SOCIAL = { modules: ["social"] };
const SVC = { authorization: "Bearer svc-token" };
const as = (userId: string) => ({ ...SVC, "x-user-id": userId });

interface Eng { clientId: string; engagementId: string; cycleId: string; officer: string; projectId: string | null }
interface TaskRow {
  id: string; title: string; status: string; progress: number; due: string | null; assignee: { refId?: string; responsibleId?: string; kind?: string } | null;
  project_id: string; linked_type: string | null; linked_id: string | null;
}

describe.skipIf(!TEST_URL)("SCP-1n · the content month in PM (BFF §63.13)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  const U: Record<string, string> = {};
  let assetId: string;
  let foreignPostId: string;
  let n = 0;
  const base = () => `/api/${A}/modules/social`;

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** An in-team engagement (no month request, so the walk below opens no PM task of its own): its officer, its project, its target. */
  async function freshEngagement(o: { project?: boolean | string; target?: number | null; officer?: string } = {}): Promise<{ clientId: string; engagementId: string; officer: string; projectId: string | null }> {
    n += 1;
    const clientId = await createClient(A, `Mock Client ${n}`);
    const engagementId = newId();
    const officer = o.officer ?? U.officer;
    const projectId = o.project === false ? null : typeof o.project === "string" ? o.project : await createProject(A, `Mock content project ${n}`);
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, project_id, posts_per_cycle, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, 'in_team', $7, $8, $9, 'central')`,
        [engagementId, A, clientId, `Mock engagement ${n}`, officer, JSON.stringify({ networks: { instagram: true, facebook: true } }),
         ["instagram", "facebook"], projectId, o.target === undefined ? null : o.target],
      );
      const orgId = newId();
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
        [orgId, A, clientId, `mock-org-${n}-${newId().slice(0, 8)}`],
      );
      for (const network of ["instagram", "facebook"]) {
        await c.query(
          `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, postiz_integration_id, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'connected', '{"igPosts24h":{"used":0,"cap":100}}', $7, 'central')`,
          [newId(), A, clientId, orgId, network, `@mock-${network}-${n}`, `int-${network}-${n}`],
        );
      }
    }, SOCIAL);
    return { clientId, engagementId, officer, projectId };
  }

  const putCycles = (rows: Array<{ engagementId: string; deadline: string }>, who = U.hod) =>
    app.inject({ method: "PUT", url: `${base()}/cycles`, headers: as(who), payload: { month: MONTH, rows } });

  /** A fresh engagement and its planned cycle (one `PUT cycles`), the cycle id read back. */
  async function planned(o: { project?: boolean | string; target?: number | null; officer?: string } = {}): Promise<Eng> {
    const e = await freshEngagement(o);
    const res = await putCycles([{ engagementId: e.engagementId, deadline: DEADLINE }]);
    if (res.statusCode !== 200) throw new Error(`plan: ${res.statusCode} ${res.body}`);
    const c = await adminPool().query(`SELECT id::text AS id FROM social_cycles WHERE engagement_id = $1 AND deleted_at IS NULL`, [e.engagementId]);
    return { ...e, cycleId: c.rows[0].id as string };
  }

  async function cycleTasks(cycleId: string): Promise<TaskRow[]> {
    const r = await adminPool().query(
      `SELECT id::text AS id, title, status, progress, to_char(due_date, 'YYYY-MM-DD') AS due, assignee, project_id::text AS project_id, linked_type, linked_id::text AS linked_id
         FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_cycle' AND linked_id = $2 AND deleted_at IS NULL`,
      [A, cycleId],
    );
    return r.rows as TaskRow[];
  }
  const taskCount = async () => Number((await adminPool().query(`SELECT count(*)::int AS n FROM pm_tasks WHERE tenant_id = $1`, [A])).rows[0].n);
  const readyByOf = async (cycleId: string) =>
    String((await adminPool().query(`SELECT to_char(ready_by, 'YYYY-MM-DD') AS d FROM social_cycles WHERE id = $1`, [cycleId])).rows[0].d);

  async function row(postId: string) {
    const r = await adminPool().query(`SELECT pipeline_status FROM social_posts WHERE id = $1`, [postId]);
    return r.rows[0] as { pipeline_status: string | null } | undefined;
  }
  async function act(who: string, postId: string, action: string, body: Record<string, unknown> = {}) {
    const expectedStatus = body.expectedStatus ?? (await row(postId))?.pipeline_status ?? "planned";
    return app.inject({ method: "POST", url: `${base()}/posts/${postId}/actions`, headers: as(who), payload: { action, expectedStatus, ...body } });
  }
  async function ok(res: { statusCode: number; body: string; json: () => unknown }, label: string) {
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${label}: ${res.statusCode} ${res.body}`);
    return res.json() as { post: Record<string, any> };
  }
  async function newPost(eng: Eng, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `${base()}/cycles/${eng.cycleId}/posts`, headers: as(eng.officer),
      payload: { title: "Mock bakery: morning pastries", format: "feed", scheduledAt: FUTURE, placement: ["instagram"], ...extra },
    });
    return (await ok(res, "create")).post.id as string;
  }
  async function fill(eng: Eng, postId: string) {
    const res = await app.inject({
      method: "PATCH", url: `${base()}/posts/${postId}/pipeline`, headers: as(eng.officer),
      payload: {
        expectedStatus: "drafting",
        fields: {
          caption: "Fresh pastries every morning.", onAssetText: "Open daily", cta: "Visit us", hashtags: ["mockbakery"],
          mustHaves: [...MUST_HAVE_KEYS], rawAssets: [{ url: "https://example.invalid/ref.jpg", label: "Reference", source: "own" }],
        },
      },
    });
    await ok(res, "fill");
  }
  /** Drive a post of an in-team engagement through the real routes to `target`. */
  async function driveTo(eng: Eng, postId: string, target: "planned" | "client" | "approved" | "scheduled") {
    const order = ["planned", "drafting", "proofread", "hod", "design", "final", "client", "approved", "scheduled"];
    const steps: Record<string, () => Promise<void>> = {
      drafting: async () => { await ok(await act(eng.officer, postId, "start_draft"), "start_draft"); await fill(eng, postId); },
      proofread: async () => { await ok(await act(eng.officer, postId, "send_to_proofread"), "send_to_proofread"); },
      hod: async () => { await ok(await act(U.copywriter, postId, "approve_copy"), "approve_copy"); },
      design: async () => { await ok(await act(U.hod, postId, "approve_for_design"), "approve_for_design"); },
      final: async () => {
        await ok(await act(U.inTeamDesigner, postId, "start_design"), "start_design");
        const add = await app.inject({ method: "POST", url: `${base()}/posts/${postId}/designs`, headers: as(U.inTeamDesigner), payload: { expectedStatus: "design", assetGroupId: assetId } });
        await ok(add, "add_design");
        await ok(await act(U.inTeamDesigner, postId, "submit_design"), "submit_design");
      },
      client: async () => { await ok(await act(U.hod, postId, "final_approve"), "final_approve"); },
      approved: async () => { await ok(await act(eng.officer, postId, "record_client_approve", { channel: "whatsapp", note: "Approved on a call." }), "record_client_approve"); },
      scheduled: async () => { await ok(await act(eng.officer, postId, "schedule"), "schedule"); },
    };
    for (const s of order.slice(1, order.indexOf(target) + 1)) await steps[s]();
  }

  // ── setup ───────────────────────────────────────────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    process.env.SOCIAL_POSTIZ_ORG_API_KEY = "mock-key";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("Mock Agency", ["social", "pm"]);
    B = await createCompany("Mock Other Co", ["social", "pm"]);
    const units = await seedSocialOrgTree(A);
    const people = ["officer", "otherOfficer", "copywriter", "hod", "inTeamDesigner", "socialManager", "outsider"];
    for (const p of people) {
      U[p] = await createUser(`scp1n-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
      await addMembership(A, U[p]);
      await grantSocialRole(A, U[p], "member");
    }
    U.bUser = await createUser("scp1n-buser@mock.test", "Mock B User");
    await addMembership(B, U.bUser);
    await grantSocialRole(B, U.bUser, "member");
    for (const p of ["officer", "otherOfficer", "copywriter", "hod"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialRole(A, U.inTeamDesigner, "social_designer");
    await grantSocialRole(A, U.socialManager, "social_manager");
    await grantSocialSeat(A, units.socialMedia, U.hod);

    const asset = await newId();
    await adminPool().query(
      `INSERT INTO creative_assets (id, tenant_id, uploader_id, name, content_type, grade, graded_key, graded_byte_size, origin_site)
       VALUES ($1, $2, $3, 'Mock design', 'image/jpeg', '{}'::jsonb, $4, 1024, 'central')`,
      [asset, A, U.inTeamDesigner, `mock/${asset}.jpg`],
    );
    assetId = asset;

    // A post of ANOTHER company, to be refused as a link target.
    const bClient = await createClient(B, "Mock B Client");
    const bEngagement = newId();
    foreignPostId = newId();
    await withTenants([B], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, creative_source, platforms, origin_site)
         VALUES ($1, $2, $3, 'Mock B engagement', 'active', 'in_team', $4, 'central')`,
        [bEngagement, B, bClient, ["instagram"]],
      );
      // A pipeline post needs its cycle (social_posts_pipeline_needs_cycle_ck).
      const bCycle = newId();
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
         VALUES ($1, $2, $3, '2026-11-01', '2026-10-30', '2026-10-29', 'central')`,
        [bCycle, B, bEngagement],
      );
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, pipeline_status, status_since) VALUES ($1, $2, $3, $4, 'Mock B post', 'planned', now())`,
        [foreignPostId, B, bEngagement, bCycle],
      );
    }, SOCIAL);

    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) PUT cycles makes and keeps the task
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("PUT cycles creates one content-month task: title, due on the ready-by, the Ball and Responsible on the officer, linked to the cycle", async () => {
    const e = await freshEngagement();
    const before = await taskCount();
    const res = await putCycles([{ engagementId: e.engagementId, deadline: DEADLINE }]);
    expect(res.statusCode, res.body).toBe(200);
    const cycle = (await adminPool().query(`SELECT id::text AS id FROM social_cycles WHERE engagement_id = $1`, [e.engagementId])).rows[0].id as string;
    const tasks = await cycleTasks(cycle);
    expect(tasks).toHaveLength(1);
    expect(await taskCount()).toBe(before + 1);
    const t = tasks[0];
    expect(t).toMatchObject({ title: "March 2027 content", progress: 0, project_id: e.projectId, linked_type: "social_cycle", linked_id: cycle });
    expect(t.status).not.toBe("done");
    expect(t.due).toBe(await readyByOf(cycle));
    expect(t.assignee).toMatchObject({ kind: "person", refId: U.officer, responsibleId: U.officer });
    // The answer's row names the task.
    const answered = (res.json().rows as Array<{ engagementId: string; contentMonthTask?: { taskId: string | null; reason: string | null } }>).find((r) => r.engagementId === e.engagementId);
    expect(answered?.contentMonthTask).toEqual({ taskId: t.id, reason: null });
    // The Ball is a real assignment (the dual-write ran): the task's owner row names the officer.
    const owner = await adminPool().query(`SELECT user_id::text AS u FROM pm_task_assignees WHERE task_id = $1 AND role = 'owner' AND valid_to IS NULL`, [t.id]);
    expect(owner.rows.map((r) => r.u)).toEqual([U.officer]);
  });

  it("a re-run updates the task (due date, officer) and never duplicates it", async () => {
    const e = await planned();
    const [first] = await cycleTasks(e.cycleId);
    const before = await taskCount();
    // The same call again changes nothing.
    expect((await putCycles([{ engagementId: e.engagementId, deadline: DEADLINE }])).statusCode).toBe(200);
    expect(await cycleTasks(e.cycleId)).toHaveLength(1);
    expect(await taskCount()).toBe(before);
    // A new deadline moves the due date, on the same task.
    const moved = await putCycles([{ engagementId: e.engagementId, deadline: "2027-02-19" }]);
    expect(moved.statusCode, moved.body).toBe(200);
    const [second] = await cycleTasks(e.cycleId);
    expect(second.id).toBe(first.id);
    expect(second.due).toBe(await readyByOf(e.cycleId));
    expect(second.due).not.toBe(first.due);
    // A new officer takes the Ball, on the same task.
    await setEngagementOfficer(A, e.engagementId, U.otherOfficer);
    expect((await putCycles([{ engagementId: e.engagementId, deadline: "2027-02-19" }])).statusCode).toBe(200);
    const [third] = await cycleTasks(e.cycleId);
    expect(third.id).toBe(first.id);
    expect(third.assignee).toMatchObject({ refId: U.otherOfficer, responsibleId: U.otherOfficer });
    expect(await taskCount()).toBe(before);
    const owners = await adminPool().query(`SELECT user_id::text AS u FROM pm_task_assignees WHERE task_id = $1 AND role = 'owner' AND valid_to IS NULL`, [first.id]);
    expect(owners.rows.map((r) => r.u)).toEqual([U.otherOfficer]);
  });

  it("an engagement with no project gets no task, and the row says why; a deleted project says so too", async () => {
    const e = await freshEngagement({ project: false });
    const before = await taskCount();
    const res = await putCycles([{ engagementId: e.engagementId, deadline: DEADLINE }]);
    expect(res.statusCode, res.body).toBe(200);
    const answered = (res.json().rows as Array<{ engagementId: string; contentMonthTask?: unknown }>).find((r) => r.engagementId === e.engagementId);
    expect(answered?.contentMonthTask).toEqual({ taskId: null, reason: "no_project" });
    expect(await taskCount()).toBe(before);

    const gone = await freshEngagement();
    await adminPool().query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [gone.projectId]);
    const res2 = await putCycles([{ engagementId: gone.engagementId, deadline: DEADLINE }]);
    expect(res2.statusCode, res2.body).toBe(200);
    const answered2 = (res2.json().rows as Array<{ engagementId: string; contentMonthTask?: unknown }>).find((r) => r.engagementId === gone.engagementId);
    expect(answered2?.contentMonthTask).toEqual({ taskId: null, reason: "project_not_found" });
    expect(await taskCount()).toBe(before);
  });

  it("one bad row refuses the whole call and creates no task (the call is one transaction)", async () => {
    const a = await freshEngagement();
    const before = await taskCount();
    const res = await putCycles([{ engagementId: a.engagementId, deadline: DEADLINE }, { engagementId: newId(), deadline: DEADLINE }]);
    expect(res.statusCode).toBe(404);
    expect(await taskCount()).toBe(before);
    const cycles = await adminPool().query(`SELECT 1 FROM social_cycles WHERE engagement_id = $1`, [a.engagementId]);
    expect(cycles.rowCount).toBe(0);
  });

  it("a change of the buffer moves the cycle's ready-by, and the task's due date moves with it", async () => {
    const e = await planned();
    const [t0] = await cycleTasks(e.cycleId);
    const set = await app.inject({ method: "PUT", url: `${base()}/settings`, headers: as(U.hod), payload: { bufferWorkingDays: 4 } });
    expect(set.statusCode, set.body).toBe(200);
    const readyBy = await readyByOf(e.cycleId);
    const [t1] = await cycleTasks(e.cycleId);
    expect(t1.id).toBe(t0.id);
    expect(t1.due).toBe(readyBy);
    expect(t1.due).not.toBe(t0.due);
    // put back, so the other cases read the default
    expect((await app.inject({ method: "PUT", url: `${base()}/settings`, headers: as(U.hod), payload: { bufferWorkingDays: 1 } })).statusCode).toBe(200);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) the pipeline writes the progress: progress, done, reopen
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("progress follows the stage actions: past client approval ÷ the target; done when every counted post is approved; reopened when one goes back to the client", async () => {
    const e = await planned({ target: 2 });
    const task = async () => (await cycleTasks(e.cycleId))[0];
    expect(await task()).toMatchObject({ progress: 0 });

    const p1 = await newPost(e);
    const p2 = await newPost(e);
    expect(await task()).toMatchObject({ progress: 0 });

    // Approved by the client: 1 of 2.
    await driveTo(e, p1, "approved");
    let t = await task();
    expect(t.progress).toBe(50);
    expect(t.status).not.toBe("done");
    // Scheduled still counts (approved, scheduled and live are past client approval).
    await ok(await act(e.officer, p1, "schedule"), "schedule");
    expect((await task()).progress).toBe(50);

    // The second approved: every counted post is approved and the target is met: done, 100.
    await driveTo(e, p2, "approved");
    t = await task();
    expect(t).toMatchObject({ status: "done", progress: 100 });

    // One goes back to the client (reschedule): the task reopens, at 1 of 2.
    await ok(await act(e.officer, p2, "reschedule", { at: LATER }), "reschedule");
    t = await task();
    expect(t.status).not.toBe("done");
    expect(t.progress).toBe(50);

    // The client decides again (recorded by the officer): done again.
    await ok(await act(e.officer, p2, "record_client_approve", { channel: "email", note: "Approved by email." }), "record_client_approve");
    expect(await task()).toMatchObject({ status: "done", progress: 100 });

    // A third post makes the month unfinished: the task reopens, held below 100 until it is done (2 of a target of 2 is 99 here).
    const p3 = await newPost(e);
    t = await task();
    expect(t.status).not.toBe("done");
    expect(t.progress).toBe(99);
    // Discarded, the month is done again.
    await ok(await act(e.officer, p3, "discard"), "discard");
    expect(await task()).toMatchObject({ status: "done", progress: 100 });
    // Archived: the post leaves the count, and a client-approved month with fewer than the target is not done (1 of 2).
    await ok(await act(e.officer, p2, "archive", { reason: "The client dropped this one." }), "archive");
    t = await task();
    expect(t.status).not.toBe("done");
    expect(t.progress).toBe(50);
  });

  it("with no target the progress is divided by the counted posts, and an extra post is not counted", async () => {
    const e = await planned({ target: null });
    const task = async () => (await cycleTasks(e.cycleId))[0];
    const p1 = await newPost(e);
    const p2 = await newPost(e);
    await driveTo(e, p1, "approved");
    expect((await task()).progress).toBe(50); // 1 of the 2 counted posts
    // An extra post, walked to approved, is beside the target: it moves nothing.
    const extra = await newPost(e, { isExtra: true });
    await driveTo(e, extra, "approved");
    expect(await task()).toMatchObject({ progress: 50 });
    expect((await task()).status).not.toBe("done");
    await driveTo(e, p2, "approved");
    expect(await task()).toMatchObject({ status: "done", progress: 100 });
  });

  it("a Composer edit of an approved post sends it back to the client, and the task reopens", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    await driveTo(e, p, "approved");
    expect((await cycleTasks(e.cycleId))[0]).toMatchObject({ status: "done", progress: 100 });
    const variant = await adminPool().query(`SELECT id::text AS id FROM social_post_variants WHERE post_id = $1 AND deleted_at IS NULL`, [p]);
    const res = await app.inject({ method: "PATCH", url: `${base()}/variants/${variant.rows[0].id}`, headers: as(U.socialManager), payload: { body: "A new caption." } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await row(p))?.pipeline_status).toBe("client");
    const t = (await cycleTasks(e.cycleId))[0];
    expect(t.status).not.toBe("done");
    expect(t.progress).toBe(0);
  });

  it("an engagement planned with no project has no task to move: the stage actions still run", async () => {
    const e = await planned({ project: false, target: 1 });
    const p = await newPost(e);
    await driveTo(e, p, "approved");
    expect(await cycleTasks(e.cycleId)).toHaveLength(0);
  });

  it("moving the task never moves a post (one direction only): a PM progress write leaves the post where it was", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    await driveTo(e, p, "client");
    const [t] = await cycleTasks(e.cycleId);
    const res = await app.inject({ method: "PATCH", url: `/api/${A}/pm/tasks/${t.id}`, headers: as(U.hod), payload: { status: "done" } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await row(p))?.pipeline_status).toBe("client");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) no PM task per post
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("no PM task is created per post: the company's task count does not move across a full walk of a post", async () => {
    const e = await planned({ target: 3 });
    expect(await cycleTasks(e.cycleId)).toHaveLength(1);
    const before = await taskCount();
    const p = await newPost(e);
    expect(await taskCount()).toBe(before);
    await driveTo(e, p, "scheduled");
    expect(await taskCount()).toBe(before);
    await ok(await act(e.officer, p, "reschedule", { at: LATER }), "reschedule");
    expect(await taskCount()).toBe(before);
    await ok(await act(e.officer, p, "record_client_approve", { channel: "email", note: "Approved by email." }), "record_client_approve");
    expect(await taskCount()).toBe(before);
    // Still the one content-month task, and no task points at the post.
    expect(await cycleTasks(e.cycleId)).toHaveLength(1);
    const linked = await adminPool().query(`SELECT 1 FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_post' AND linked_id = $2`, [A, p]);
    expect(linked.rowCount).toBe(0);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) a task can point at a post
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  const createTask = (who: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/${A}/pm/tasks`, headers: as(who), payload });
  const patchTask = (who: string, taskId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/${A}/pm/tasks/${taskId}`, headers: as(who), payload });
  const readPost = (who: string, postId: string) => app.inject({ method: "GET", url: `${base()}/posts/${postId}/pipeline`, headers: as(who) });

  it("a task created with a link to a post is listed in the post's read; the task read carries the link", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    const made = await createTask(e.officer, { projectId: e.projectId, title: "Mock: shoot the hero picture", linkedType: "social_post", linkedId: p });
    expect(made.statusCode, made.body).toBe(201);
    const taskId = (made.json() as { id: string }).id;
    const read = await readPost(e.officer, p);
    expect(read.statusCode, read.body).toBe(200);
    const tasks = read.json().tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: taskId, title: "Mock: shoot the hero picture", projectId: e.projectId, progress: 0, ball: null });
    const task = await app.inject({ method: "GET", url: `/api/${A}/pm/tasks/${taskId}`, headers: as(e.officer) });
    expect(task.json()).toMatchObject({ linkedType: "social_post", linkedId: p });
    // The content-month task points at a cycle, so it is not on the post.
    expect(tasks.some((t) => t.title === "March 2027 content")).toBe(false);
    // And the tenant-wide list carries the link too.
    const list = await app.inject({ method: "GET", url: `/api/${A}/pm/tasks?limit=200`, headers: as(e.officer) });
    const items = (list.json() as { items: Array<{ id: string; linkedType: string | null; linkedId: string | null }> }).items;
    expect(items.find((t) => t.id === taskId)).toMatchObject({ linkedType: "social_post", linkedId: p });
  });

  it("an existing task is linked and unlinked by PATCH (both fields, or both null); the post's read follows", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    const made = await createTask(e.officer, { projectId: e.projectId, title: "Mock: write the alt text" });
    const taskId = (made.json() as { id: string }).id;
    expect((await readPost(e.officer, p)).json().tasks).toEqual([]);
    expect((await patchTask(e.officer, taskId, { linkedType: "social_post", linkedId: p })).statusCode).toBe(200);
    expect(((await readPost(e.officer, p)).json().tasks as Array<{ id: string }>).map((t) => t.id)).toEqual([taskId]);
    expect((await patchTask(e.officer, taskId, { linkedType: null, linkedId: null })).statusCode).toBe(200);
    expect((await readPost(e.officer, p)).json().tasks).toEqual([]);
    const stored = await adminPool().query(`SELECT linked_type, linked_id FROM pm_tasks WHERE id = $1`, [taskId]);
    expect(stored.rows[0]).toEqual({ linked_type: null, linked_id: null });
    // A PATCH that does not mention the link leaves it alone.
    await patchTask(e.officer, taskId, { linkedType: "social_post", linkedId: p });
    expect((await patchTask(e.officer, taskId, { priority: "high" })).statusCode).toBe(200);
    expect(((await readPost(e.officer, p)).json().tasks as unknown[])).toHaveLength(1);
  });

  it("linking to a post of another company is refused (400 on linkedId), on create and on patch, and nothing is stored", async () => {
    const e = await planned({ target: 1 });
    const before = await taskCount();
    const made = await createTask(e.officer, { projectId: e.projectId, title: "Mock: not mine", linkedType: "social_post", linkedId: foreignPostId });
    expect(made.statusCode, made.body).toBe(400);
    expect(made.json()).toMatchObject({ field: "linkedId" });
    expect(await taskCount()).toBe(before);
    const ghost = await createTask(e.officer, { projectId: e.projectId, title: "Mock: no such post", linkedType: "social_post", linkedId: newId() });
    expect(ghost.statusCode).toBe(400);
    expect(ghost.json()).toMatchObject({ field: "linkedId" });

    const own = await createTask(e.officer, { projectId: e.projectId, title: "Mock: plain" });
    const taskId = (own.json() as { id: string }).id;
    const patched = await patchTask(e.officer, taskId, { linkedType: "social_post", linkedId: foreignPostId });
    expect(patched.statusCode, patched.body).toBe(400);
    expect(patched.json()).toMatchObject({ field: "linkedId" });
    const stored = await adminPool().query(`SELECT linked_type, linked_id FROM pm_tasks WHERE id = $1`, [taskId]);
    expect(stored.rows[0]).toEqual({ linked_type: null, linked_id: null });
  });

  it("a person who cannot read the post cannot link a task to it (403), and the task is not created", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    const before = await taskCount();
    const made = await createTask(U.outsider, { projectId: e.projectId, title: "Mock: nosy", linkedType: "social_post", linkedId: p });
    expect(made.statusCode, made.body).toBe(403);
    expect(await taskCount()).toBe(before);
  });

  it("the link is validated: half a pair, another type, a malformed id and the cycle kind are 400 with the field", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    const bad: Array<[string, Record<string, unknown>, string]> = [
      ["a type with no id", { linkedType: "social_post" }, "linkedId"],
      ["an id with no type", { linkedId: p }, "linkedType"],
      ["a type with a null id", { linkedType: "social_post", linkedId: null }, "linkedId"],
      ["another type", { linkedType: "deal", linkedId: p }, "linkedType"],
      ["the cycle kind, which no route may set", { linkedType: "social_cycle", linkedId: e.cycleId }, "linkedType"],
      ["a malformed id", { linkedType: "social_post", linkedId: "not-a-uuid" }, "linkedId"],
    ];
    const before = await taskCount();
    for (const [label, extra, field] of bad) {
      const res = await createTask(e.officer, { projectId: e.projectId, title: "Mock: bad link", ...extra });
      expect(res.statusCode, label).toBe(400);
      expect(res.json(), label).toMatchObject({ field });
    }
    expect(await taskCount()).toBe(before);
  });

  it("no route moves the content-month task's link: 409 task_link_locked, and the link stays", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    const [t] = await cycleTasks(e.cycleId);
    for (const payload of [{ linkedType: "social_post", linkedId: p }, { linkedType: null, linkedId: null }]) {
      const res = await patchTask(U.hod, t.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(409);
      expect(res.json()).toMatchObject({ error: "task_link_locked" });
    }
    expect((await cycleTasks(e.cycleId))[0]).toMatchObject({ linked_type: "social_cycle", linked_id: e.cycleId });
  });

  it("a caller with no read on the post reads no tasks of it (403), and another company's caller does not find the post", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    await createTask(e.officer, { projectId: e.projectId, title: "Mock: visible to the team", linkedType: "social_post", linkedId: p });
    const out = await readPost(U.outsider, p);
    expect(out.statusCode).toBe(403);
    const foreign = await app.inject({ method: "GET", url: `/api/${B}/modules/social/posts/${p}/pipeline`, headers: as(U.bUser) });
    expect([403, 404]).toContain(foreign.statusCode);
  });
});
