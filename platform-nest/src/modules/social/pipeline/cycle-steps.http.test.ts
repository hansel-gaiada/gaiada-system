// SCP-5f — the monthly cycle's step tasks (FRONTEND-BFF-CONTRACT §63.27) against REAL Postgres and REAL Cerbos, through the real routes as
// real personas. Skips without DATABASE_URL_TEST, like every suite here; on CI it runs for real. The report's delivery through the PDF
// renderer stand-in also needs REDIS_URL_TEST (the print job token lives in Redis), which CI has.
//
// What it proves (§63.27.5):
//   (1) `PUT cycles` makes exactly six step tasks per cycle beside the content-month task (titles, links, `linkedStep`, the Ball and the
//       Responsible on the officer, the due dates in working days from ready-by less the client's estimates, the report on the client's
//       report day in M−1); a re-run makes none; still no task per post; without estimates every step but the report falls due on ready-by,
//       and without a report day the report has no due date;
//   (2) no project: no steps, and each row says why (`no_project`, `project_not_found`);
//   (3) each step closes on its condition and reopens: a design change reopens `artwork`; a reschedule reopens `client_window` and
//       `deploy`; a new counted post reopens `planning`; a step closed by hand reopens at the next recompute; moving a step task never moves
//       a post;
//   (4) the link is locked (409 `task_link_locked`), and PM's reads answer `linkedStep`;
//   (5) the `report` step closes on the delivery of period M−2's report, not another period's;
//   (6) a new officer on the allocation takes the Ball of every OPEN step; new estimates re-date them; a new buffer re-dates them;
//   (7) two stage actions on posts of one cycle at once never deadlock, and the second always counts what the first committed: the pairs
//       run truly concurrently (two connections), many times;
//   (8) a rules change applies to new cycles only, and a step set to `manual` is never closed or reopened by the pipeline (last: it changes
//       the company's rules).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import Redis from "ioredis";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { setRedis, closeRedis } from "../../../events/redis";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient, createProject } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialSeat, grantSocialRole } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { MUST_HAVE_KEYS } from "./handoff-checks";
import { closeReportStepsOnDelivery } from "./cycle-steps";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const FUTURE = "2027-03-10T10:00:00.000Z";
const MONTH = "2027-03";
const DEADLINE = "2027-02-26"; // a Friday; the default buffer of 1 working day makes ready-by Thursday 2027-02-25
const READY_BY = "2027-02-25";
const SOCIAL = { modules: ["social"] };
const SVC = { authorization: "Bearer svc-token" };
const as = (userId: string) => ({ ...SVC, "x-user-id": userId });
const E9 = { proofread: 1, hod: 1, design: 3, final: 1, client: 2, schedule: 1 };
const STEPS = ["report", "planning", "copy_lock", "artwork", "client_window", "deploy"];

interface Eng { clientId: string; engagementId: string; cycleId: string; officer: string; projectId: string | null }
interface StepRow {
  id: string; step: string; title: string; status: string; progress: number; due: string | null; project_id: string;
  assignee: { refId?: string; responsibleId?: string; kind?: string } | null;
}

describe.skipIf(!TEST_URL)("SCP-5f · the monthly cycle's step tasks (BFF §63.27)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  let assetId: string;
  let n = 0;
  let sidecar: Server | null = null;
  const base = () => `/api/${A}/modules/social`;

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
  interface EngOpts { project?: boolean; target?: number | null; officer?: string; estimates?: Record<string, number>; reportDueDay?: number | null }
  /** An in-team engagement (no month request, so nothing else opens a PM task): its officer, project, target, estimates and report day. */
  async function freshEngagement(o: EngOpts = {}): Promise<Omit<Eng, "cycleId">> {
    n += 1;
    const clientId = await createClient(A, `Mock Client ${n}`);
    const engagementId = newId();
    const officer = o.officer ?? U.officer;
    const projectId = o.project === false ? null : await createProject(A, `Mock content project ${n}`);
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, project_id, posts_per_cycle,
                                         step_estimates, report_due_day, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, 'in_team', $7, $8, $9, $10::jsonb, $11, 'central')`,
        [engagementId, A, clientId, `Mock engagement ${n}`, officer, JSON.stringify({ networks: { instagram: true } }), ["instagram"], projectId,
         o.target === undefined ? 1 : o.target, JSON.stringify(o.estimates ?? {}), o.reportDueDay === undefined ? null : o.reportDueDay],
      );
      const orgId = newId();
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
        [orgId, A, clientId, `mock-org-${n}-${newId().slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, postiz_integration_id, origin_site)
         VALUES ($1, $2, $3, $4, 'instagram', $5, 'connected', '{"igPosts24h":{"used":0,"cap":100}}', $6, 'central')`,
        [newId(), A, clientId, orgId, `@mock-ig-${n}`, `int-ig-${n}`],
      );
    }, SOCIAL);
    return { clientId, engagementId, officer, projectId };
  }

  const putCycles = (rows: Array<{ engagementId: string; deadline: string }>, who = U.hod) =>
    app.inject({ method: "PUT", url: `${base()}/cycles`, headers: as(who), payload: { month: MONTH, rows } });

  async function planned(o: EngOpts = {}): Promise<Eng> {
    const e = await freshEngagement(o);
    const res = await putCycles([{ engagementId: e.engagementId, deadline: DEADLINE }]);
    if (res.statusCode !== 200) throw new Error(`plan: ${res.statusCode} ${res.body}`);
    const c = await adminPool().query(`SELECT id::text AS id FROM social_cycles WHERE engagement_id = $1 AND deleted_at IS NULL`, [e.engagementId]);
    return { ...e, cycleId: c.rows[0].id as string };
  }

  /** The cycle's live step tasks, in the seeded order. */
  async function steps(cycleId: string): Promise<StepRow[]> {
    const r = await adminPool().query(
      `SELECT id::text AS id, linked_step AS step, title, status, progress, to_char(due_date, 'YYYY-MM-DD') AS due, assignee, project_id::text AS project_id
         FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_cycle_step' AND linked_id = $2 AND deleted_at IS NULL
        ORDER BY array_position($3::text[], linked_step), linked_step`,
      [A, cycleId, STEPS],
    );
    return r.rows as StepRow[];
  }
  const step = async (cycleId: string, key: string) => (await steps(cycleId)).find((s) => s.step === key)!;
  const doneOf = async (cycleId: string) => Object.fromEntries((await steps(cycleId)).map((s) => [s.step, s.status === "done"]));
  const monthTask = async (cycleId: string) => (await adminPool().query(
    `SELECT status, progress FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_cycle' AND linked_id = $2 AND deleted_at IS NULL`, [A, cycleId])).rows[0] as { status: string; progress: number };
  const taskCount = async () => Number((await adminPool().query(`SELECT count(*)::int AS n FROM pm_tasks WHERE tenant_id = $1`, [A])).rows[0].n);
  const statusOf = async (postId: string) => (await adminPool().query(`SELECT pipeline_status FROM social_posts WHERE id = $1`, [postId])).rows[0]?.pipeline_status as string;

  async function act(who: string, postId: string, action: string, body: Record<string, unknown> = {}) {
    const expectedStatus = body.expectedStatus ?? (await statusOf(postId)) ?? "planned";
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
  const ORDER = ["planned", "drafting", "proofread", "hod", "design", "final", "client", "approved", "scheduled"] as const;
  type Stage = (typeof ORDER)[number];
  /** Drive a post of an in-team engagement through the real routes from where it is to `target`. */
  async function driveTo(eng: Eng, postId: string, target: Stage) {
    const go: Record<string, () => Promise<void>> = {
      drafting: async () => { await ok(await act(eng.officer, postId, "start_draft"), "start_draft"); await fill(eng, postId); },
      proofread: async () => { await ok(await act(eng.officer, postId, "send_to_proofread"), "send_to_proofread"); },
      hod: async () => { await ok(await act(U.copywriter, postId, "approve_copy"), "approve_copy"); },
      design: async () => { await ok(await act(U.hod, postId, "approve_for_design"), "approve_for_design"); },
      final: async () => {
        await ok(await act(U.designer, postId, "start_design"), "start_design");
        const add = await app.inject({ method: "POST", url: `${base()}/posts/${postId}/designs`, headers: as(U.designer), payload: { expectedStatus: "design", assetGroupId: assetId } });
        await ok(add, "add_design");
        await ok(await act(U.designer, postId, "submit_design"), "submit_design");
      },
      client: async () => { await ok(await act(U.hod, postId, "final_approve"), "final_approve"); },
      approved: async () => { await ok(await act(eng.officer, postId, "record_client_approve", { channel: "whatsapp", note: "Approved on a call." }), "record_client_approve"); },
      scheduled: async () => { await ok(await act(eng.officer, postId, "schedule"), "schedule"); },
    };
    const from = ORDER.indexOf((await statusOf(postId)) as Stage);
    for (const s of ORDER.slice(from + 1, ORDER.indexOf(target) + 1)) await go[s]();
  }

  // ── setup ───────────────────────────────────────────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    process.env.SOCIAL_POSTIZ_ORG_API_KEY = "mock-key";
    config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
    if (REDIS_TEST_URL) setRedis(new Redis(REDIS_TEST_URL));
    resetModules();
    registerModule(socialModule);

    A = await createCompany("Mock Agency", ["social", "pm"]);
    const units = await seedSocialOrgTree(A);
    const people = ["officer", "otherOfficer", "copywriter", "hod", "designer"];
    for (const p of people) {
      U[p] = await createUser(`scp5f-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
      await addMembership(A, U[p]);
      await grantSocialRole(A, U[p], "member");
    }
    for (const p of ["officer", "otherOfficer", "copywriter", "hod"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialRole(A, U.designer, "social_designer");
    await grantSocialSeat(A, units.socialMedia, U.hod);

    assetId = newId();
    await adminPool().query(
      `INSERT INTO creative_assets (id, tenant_id, uploader_id, name, content_type, grade, graded_key, graded_byte_size, origin_site)
       VALUES ($1, $2, $3, 'Mock design', 'image/jpeg', '{}'::jsonb, $4, 1024, 'central')`,
      [assetId, A, U.designer, `mock/${assetId}.jpg`],
    );

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    // The PDF renderer stand-in: any authorised render answers a tiny PDF (the round trip itself is social-reports.http.test.ts's).
    sidecar = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.method !== "POST" || req.url !== "/render" || req.headers.authorization !== "Bearer render-tok") { res.writeHead(401).end(); return; }
        res.writeHead(200, { "content-type": "application/pdf" }).end(Buffer.from("%PDF-fake"));
      });
    });
    await new Promise<void>((resolve) => sidecar!.listen(0, "127.0.0.1", resolve));
  }, 180_000);
  afterAll(async () => {
    if (sidecar) await new Promise<void>((r) => sidecar!.close(() => r()));
    await app?.close();
    if (REDIS_TEST_URL) await closeRedis();
    await teardownTestDb();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) made and dated
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("PUT cycles makes exactly six step tasks beside the content-month task: titles, links, the Ball, due dates; a re-run makes none", async () => {
    const e = await freshEngagement({ estimates: E9, reportDueDay: 10 });
    const before = await taskCount();
    const res = await putCycles([{ engagementId: e.engagementId, deadline: DEADLINE }]);
    expect(res.statusCode, res.body).toBe(200);
    const cycleId = (await adminPool().query(`SELECT id::text AS id FROM social_cycles WHERE engagement_id = $1`, [e.engagementId])).rows[0].id as string;
    expect(await taskCount()).toBe(before + 7); // six steps and the content-month task
    const row = (res.json().rows as Array<{ engagementId: string; stepTasks?: unknown }>).find((r) => r.engagementId === e.engagementId);
    expect(row?.stepTasks).toEqual({ created: 6, reason: null });

    const s = await steps(cycleId);
    expect(s.map((x) => x.step)).toEqual(STEPS);
    expect(s.map((x) => x.title)).toEqual([
      "Monthly report for January 2027", "March 2027 plan", "March 2027 copy locked", "March 2027 artwork", "March 2027 client approval", "March 2027 scheduled",
    ]);
    // Ready-by Thu 25 Feb. deploy R; client_window R less 1; artwork less 4: 24, 23, 22, 19; copy_lock less 7: 18, 17, 16; planning less 9: 15, 12.
    // The report: the client's day (10) in M−1.
    expect(s.map((x) => x.due)).toEqual(["2027-02-10", "2027-02-12", "2027-02-16", "2027-02-19", "2027-02-24", READY_BY]);
    for (const x of s) {
      expect(x.project_id).toBe(e.projectId);
      expect(x.status).not.toBe("done");
      expect(x.progress).toBe(0);
      expect(x.assignee).toMatchObject({ kind: "person", refId: U.officer, responsibleId: U.officer });
    }
    const owners = await adminPool().query(`SELECT user_id::text AS u FROM pm_task_assignees WHERE task_id = $1 AND role = 'owner' AND valid_to IS NULL`, [s[1].id]);
    expect(owners.rows.map((r) => r.u)).toEqual([U.officer]);

    // A re-run makes none and changes nothing.
    const again = await putCycles([{ engagementId: e.engagementId, deadline: DEADLINE }]);
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json().rows as Array<{ engagementId: string; stepTasks?: unknown }>).find((r) => r.engagementId === e.engagementId)?.stepTasks)
      .toEqual({ created: 0, reason: null });
    expect(await taskCount()).toBe(before + 7);
    expect((await steps(cycleId)).map((x) => x.id)).toEqual(s.map((x) => x.id));

    // Still no task per post: a full walk of a post makes none.
    const eng = { ...e, cycleId };
    const p = await newPost(eng);
    await driveTo(eng, p, "scheduled");
    expect(await taskCount()).toBe(before + 7);
  });

  it("without estimates every step but the report falls due on ready-by; without a report day the report has no due date", async () => {
    const e = await planned({ reportDueDay: null });
    expect((await steps(e.cycleId)).map((x) => x.due)).toEqual([null, READY_BY, READY_BY, READY_BY, READY_BY, READY_BY]);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) no project
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("no project: no steps, and the row says why; a deleted project says so too", async () => {
    const e = await freshEngagement({ project: false });
    const before = await taskCount();
    const res = await putCycles([{ engagementId: e.engagementId, deadline: DEADLINE }]);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().rows as Array<{ engagementId: string; stepTasks?: unknown }>).find((r) => r.engagementId === e.engagementId)?.stepTasks)
      .toEqual({ created: 0, reason: "no_project" });
    expect(await taskCount()).toBe(before);

    const gone = await freshEngagement();
    await adminPool().query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [gone.projectId]);
    const res2 = await putCycles([{ engagementId: gone.engagementId, deadline: DEADLINE }]);
    expect(res2.statusCode, res2.body).toBe(200);
    expect((res2.json().rows as Array<{ engagementId: string; stepTasks?: unknown }>).find((r) => r.engagementId === gone.engagementId)?.stepTasks)
      .toEqual({ created: 0, reason: "project_not_found" });
    expect(await taskCount()).toBe(before);

    // The stage actions still run on a cycle with no step tasks.
    const c = (await adminPool().query(`SELECT id::text AS id FROM social_cycles WHERE engagement_id = $1`, [e.engagementId])).rows[0].id as string;
    const eng = { ...e, cycleId: c };
    const p = await newPost(eng);
    await driveTo(eng, p, "approved");
    expect(await steps(c)).toHaveLength(0);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) closed and reopened by the pipeline
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("each step closes on its condition and reopens: a design change reopens artwork, a reschedule client approval and scheduling, a new post planning", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    expect(await doneOf(e.cycleId)).toEqual({ report: false, planning: false, copy_lock: false, artwork: false, client_window: false, deploy: false });

    await driveTo(e, p, "proofread");
    expect(await doneOf(e.cycleId)).toMatchObject({ planning: true, copy_lock: false });
    expect((await step(e.cycleId, "planning")).progress).toBe(100);
    await driveTo(e, p, "hod");
    expect(await doneOf(e.cycleId)).toMatchObject({ planning: true, copy_lock: false });
    await driveTo(e, p, "design");
    expect(await doneOf(e.cycleId)).toMatchObject({ copy_lock: true, artwork: false });
    await driveTo(e, p, "final");
    expect(await doneOf(e.cycleId)).toMatchObject({ copy_lock: true, artwork: true, client_window: false });

    // A design change at the final check: artwork reopens; the copy stays locked.
    await ok(await act(U.hod, p, "final_changes", { changeKind: "design", note: "Make the logo larger." }), "final_changes");
    expect(await doneOf(e.cycleId)).toMatchObject({ copy_lock: true, artwork: false });
    await ok(await act(U.designer, p, "start_design"), "start_design");
    await ok(await act(U.designer, p, "submit_design"), "submit_design");
    expect(await doneOf(e.cycleId)).toMatchObject({ artwork: true });

    await driveTo(e, p, "approved");
    expect(await doneOf(e.cycleId)).toMatchObject({ client_window: true, deploy: false });
    await driveTo(e, p, "scheduled");
    expect(await doneOf(e.cycleId)).toEqual({ report: false, planning: true, copy_lock: true, artwork: true, client_window: true, deploy: true });

    // A reschedule sends the post back to the client: client approval and scheduling reopen; the rest stay done.
    await ok(await act(e.officer, p, "reschedule", { at: "2027-03-12T10:00:00.000Z" }), "reschedule");
    expect(await doneOf(e.cycleId)).toEqual({ report: false, planning: true, copy_lock: true, artwork: true, client_window: false, deploy: false });
    await driveTo(e, p, "scheduled");
    expect(await doneOf(e.cycleId)).toMatchObject({ client_window: true, deploy: true });

    // A new counted post reopens planning (and the client and scheduling steps: it is not approved); discarding it closes them again.
    const p2 = await newPost(e);
    expect(await doneOf(e.cycleId)).toMatchObject({ planning: false, client_window: false, deploy: false });
    expect((await step(e.cycleId, "planning")).progress).toBe(50);
    await ok(await act(e.officer, p2, "discard"), "discard");
    expect(await doneOf(e.cycleId)).toMatchObject({ planning: true, client_window: true, deploy: true });
    // An extra post is beside the target: it reopens nothing.
    await newPost(e, { isExtra: true });
    expect(await doneOf(e.cycleId)).toMatchObject({ planning: true, client_window: true, deploy: true });
  });

  it("a step closed by hand reopens at the next recompute when its condition does not hold; moving it never moves a post", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    const planning = await step(e.cycleId, "planning");
    const res = await app.inject({ method: "PATCH", url: `/api/${A}/pm/tasks/${planning.id}`, headers: as(U.hod), payload: { status: "done" } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await step(e.cycleId, "planning")).status).toBe("done");
    expect(await statusOf(p)).toBe("planned"); // one direction only
    await ok(await act(e.officer, p, "start_draft"), "start_draft");
    const after = await step(e.cycleId, "planning");
    expect(after.status).not.toBe("done");
    expect(after.progress).toBe(0);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) the link is locked; PM reads answer linkedStep
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("no PM route moves a step task's link (409 task_link_locked); GET pm/tasks/:id and the task lists answer linkedStep", async () => {
    const e = await planned();
    const p = await newPost(e);
    const t = await step(e.cycleId, "artwork");
    const patch = (payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/${A}/pm/tasks/${t.id}`, headers: as(U.hod), payload });
    for (const payload of [{ linkedType: "social_post", linkedId: p }, { linkedType: null, linkedId: null }]) {
      const r = await patch(payload);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error ?? r.json().message).toBe("task_link_locked");
    }
    const row = await adminPool().query(`SELECT linked_type, linked_id::text AS linked_id, linked_step FROM pm_tasks WHERE id = $1`, [t.id]);
    expect(row.rows[0]).toEqual({ linked_type: "social_cycle_step", linked_id: e.cycleId, linked_step: "artwork" });

    const one = await app.inject({ method: "GET", url: `/api/${A}/pm/tasks/${t.id}`, headers: as(e.officer) });
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toMatchObject({ linkedType: "social_cycle_step", linkedId: e.cycleId, linkedStep: "artwork" });
    const inProject = await app.inject({ method: "GET", url: `/api/${A}/pm/projects/${e.projectId}/tasks`, headers: as(e.officer) });
    expect(inProject.statusCode, inProject.body).toBe(200);
    const items = (inProject.json() as Array<{ id: string; linkedStep?: string | null; linkedType?: string | null }>);
    expect(items.find((x) => x.id === t.id)).toMatchObject({ linkedStep: "artwork" });
    expect(items.find((x) => x.linkedType === "social_cycle")).toMatchObject({ linkedStep: null });
    const list = await app.inject({ method: "GET", url: `/api/${A}/pm/tasks?limit=200`, headers: as(e.officer) });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { items: Array<{ id: string; linkedStep?: string | null }> }).items.find((x) => x.id === t.id)).toMatchObject({ linkedStep: "artwork" });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) the report step closes on delivery
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("the report step closes on the delivery of period M−2's report, not another period's", async () => {
    const e = await planned({ reportDueDay: 5 });
    const metrics = { rangeStart: "", rangeEnd: "", kpis: [], series: [], tables: [], highlights: [] };
    const report = async (period: string) => {
      const id = newId();
      await adminPool().query(
        `INSERT INTO social_reports (id, tenant_id, engagement_id, period, kind, status, metrics, narrative_md, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, 'monthly', 'approved', $5::jsonb, 'A steady month.', $6, now())`,
        [id, A, e.engagementId, period, JSON.stringify(metrics), U.hod],
      );
      return id;
    };
    const other = await report("2026-12"); // M−3: another period
    const mine = await report("2027-01"); // M−2 for content month March 2027
    const deliver = async (id: string) => {
      if (!REDIS_TEST_URL) {
        // No Redis here: the route cannot mint its print token, so prove the transaction body the route runs after its own write.
        await adminPool().query(`UPDATE social_reports SET status = 'delivered', delivered_at = now() WHERE id = $1`, [id]);
        const r = (await adminPool().query(`SELECT engagement_id::text AS e, kind, period FROM social_reports WHERE id = $1`, [id])).rows[0];
        await withTenants([A], (c) => closeReportStepsOnDelivery(c, A, { engagementId: r.e, kind: r.kind, period: r.period }, U.hod), SOCIAL);
        return;
      }
      config.reportRenderer = { url: `http://127.0.0.1:${(sidecar!.address() as AddressInfo).port}`, token: "render-tok", platformUiInternalUrl: "http://127.0.0.1:1", timeoutMs: 5000 };
      try {
        const res = await app.inject({ method: "POST", url: `${base()}/reports/${id}/deliver`, headers: as(U.hod) });
        expect(res.statusCode, res.body).toBe(200);
      } finally {
        config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
      }
    };

    await deliver(other);
    expect((await step(e.cycleId, "report")).status).not.toBe("done");
    await deliver(mine);
    const r = await step(e.cycleId, "report");
    expect(r).toMatchObject({ status: "done", progress: 100, title: "Monthly report for January 2027", due: "2027-02-05" });
    // The stage actions' recompute keeps it closed (the report stays delivered).
    const p = await newPost(e);
    await ok(await act(e.officer, p, "start_draft"), "start_draft");
    expect((await step(e.cycleId, "report")).status).toBe("done");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (6) re-dated by the allocation and the buffer
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("a new officer on the allocation takes the Ball of every open step (a done one keeps its own); new estimates re-date them", async () => {
    const e = await planned({ target: 1 });
    const p = await newPost(e);
    await driveTo(e, p, "proofread"); // planning done
    expect((await step(e.cycleId, "planning")).status).toBe("done");
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `${base()}/engagements/${e.engagementId}/allocation`, headers: as(U.hod), payload });

    const r1 = await patch({ officerId: U.otherOfficer });
    expect(r1.statusCode, r1.body).toBe(200);
    for (const s of await steps(e.cycleId)) {
      const who = s.step === "planning" ? U.officer : U.otherOfficer;
      expect(s.assignee, s.step).toMatchObject({ refId: who, responsibleId: who });
    }
    const owner = await adminPool().query(`SELECT user_id::text AS u FROM pm_task_assignees WHERE task_id = $1 AND role = 'owner' AND valid_to IS NULL`,
      [(await step(e.cycleId, "deploy")).id]);
    expect(owner.rows.map((x) => x.u)).toEqual([U.otherOfficer]);

    expect((await steps(e.cycleId)).map((s) => s.due)).toEqual([null, READY_BY, READY_BY, READY_BY, READY_BY, READY_BY]);
    const r2 = await patch({ stepEstimates: E9, reportDueDay: 31 });
    expect(r2.statusCode, r2.body).toBe(200);
    // The report day 31 clamps to 28 February.
    expect((await steps(e.cycleId)).map((s) => s.due)).toEqual(["2027-02-28", "2027-02-12", "2027-02-16", "2027-02-19", "2027-02-24", READY_BY]);
    // Re-dating never touches the state: planning is still done.
    expect((await step(e.cycleId, "planning")).status).toBe("done");
  });

  it("a new buffer moves ready-by, and the steps move with it in the same transaction", async () => {
    const e = await planned({ estimates: { schedule: 1 } });
    const set = (b: number) => app.inject({ method: "PUT", url: `${base()}/settings`, headers: as(U.hod), payload: { bufferWorkingDays: b } });
    try {
      expect((await set(3)).statusCode).toBe(200);
      // Deadline Fri 26 Feb less 3 working days: Tue 23 Feb; client approval one working day before it.
      expect(await step(e.cycleId, "deploy")).toMatchObject({ due: "2027-02-23" });
      expect(await step(e.cycleId, "client_window")).toMatchObject({ due: "2027-02-22" });
    } finally {
      expect((await set(1)).statusCode).toBe(200);
    }
    expect(await step(e.cycleId, "deploy")).toMatchObject({ due: READY_BY });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (7) the lock order: concurrent stage actions on one cycle
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("two stage actions on posts of one cycle at once never deadlock, and the second counts what the first committed", async () => {
    const e = await planned({ target: 2 });
    const p1 = await newPost(e);
    const p2 = await newPost(e);
    await driveTo(e, p1, "client");
    await driveTo(e, p2, "client");
    const both = async (label: string, f: (p: string, i: number) => Promise<{ statusCode: number; body: string }>) => {
      const rs = await Promise.all([f(p1, 0), f(p2, 1)]);
      rs.forEach((r, i) => expect(r.statusCode, `${label} #${i}: ${r.body}`).toBe(200));
    };
    const ROUNDS = 12;
    for (let round = 0; round < ROUNDS; round++) {
      // Both approved at once: each action locks its post, then the content-month task, then the step tasks. Whichever commits second
      // must see the first's post approved, so the month and its client step are done (a lost update would leave them open).
      await both(`approve ${round}`, (p) => act(e.officer, p, "record_client_approve", { channel: "email", note: `Round ${round}.` }));
      expect(await doneOf(e.cycleId), `round ${round} approved`).toMatchObject({ client_window: true, deploy: false });
      expect((await monthTask(e.cycleId)).status, `round ${round} month`).toBe("done");
      // Both scheduled at once: deploy closes.
      await both(`schedule ${round}`, (p) => act(e.officer, p, "schedule"));
      expect(await doneOf(e.cycleId), `round ${round} scheduled`).toMatchObject({ client_window: true, deploy: true });
      // Both rescheduled at once: back with the client, both steps and the month reopen.
      // A new date each round (never the one it holds: `no_change`), a different one per post.
      await both(`reschedule ${round}`, (p, i) => act(e.officer, p, "reschedule", { at: `2027-03-${String(11 + (round % 9)).padStart(2, "0")}T1${i}:30:00.000Z` }));
      expect(await doneOf(e.cycleId), `round ${round} rescheduled`).toMatchObject({ client_window: false, deploy: false });
      expect((await monthTask(e.cycleId)).status, `round ${round} month reopened`).not.toBe("done");
    }
    // A create (which locks the cycle row, then the tasks) beside an action on another post of the cycle.
    for (let round = 0; round < 4; round++) {
      const [made, acted] = await Promise.all([
        app.inject({ method: "POST", url: `${base()}/cycles/${e.cycleId}/posts`, headers: as(e.officer),
          payload: { title: `Mock extra ${round}`, format: "feed", scheduledAt: FUTURE, placement: ["instagram"] } }),
        act(e.officer, round % 2 === 0 ? p1 : p2, "record_client_approve", { channel: "email", note: "Concurrent." }),
      ]);
      expect([200, 201], made.body).toContain(made.statusCode);
      expect(acted.statusCode, acted.body).toBe(200);
      expect(await doneOf(e.cycleId)).toMatchObject({ planning: false, client_window: false }); // a new planned post is counted
      await ok(await act(e.officer, (made.json() as { post: { id: string } }).post.id, "discard"), "discard");
      if (round % 2 === 0) await ok(await act(e.officer, p1, "reschedule", { at: `2027-03-2${round}T09:00:00.000Z` }), "reschedule back");
      else await ok(await act(e.officer, p2, "reschedule", { at: `2027-03-2${round}T09:00:00.000Z` }), "reschedule back");
    }
  }, 300_000);

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (8) LAST: the company's rules change (it changes the rules of company A for every later cycle)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("a rules change applies to new cycles only; a step set to manual is made and dated but never closed or reopened by the pipeline", async () => {
    const old = await planned({ target: 1 });
    const oldIds = (await steps(old.cycleId)).map((s) => s.id);

    const current = await app.inject({ method: "GET", url: `${base()}/rules`, headers: as(U.hod) });
    expect(current.statusCode, current.body).toBe(200);
    const value = {
      steps: [
        { key: "planning", title: "{month} content plan", due: { rule: "ready_by", lessEstimatesFrom: "proofread", lessWorkingDays: 0 }, autoClose: { rule: "plan_laid_out" } },
        { key: "deploy", title: "{month} live", due: { rule: "ready_by", lessEstimatesFrom: null, lessWorkingDays: 2 }, autoClose: { rule: "manual" } },
      ],
    };
    const saved = await app.inject({ method: "PUT", url: `${base()}/rules/cycle`, headers: as(U.hod), payload: { expectedVersion: current.json().version, value } });
    expect(saved.statusCode, saved.body).toBe(200);

    // The cycle made before the change keeps its six steps and titles, even when PUT cycles runs again for it.
    expect((await putCycles([{ engagementId: old.engagementId, deadline: DEADLINE }])).statusCode).toBe(200);
    const kept = await steps(old.cycleId);
    expect(kept.map((s) => s.id)).toEqual(oldIds);
    expect(kept.map((s) => s.title)).toEqual([
      "Monthly report for January 2027", "March 2027 plan", "March 2027 copy locked", "March 2027 artwork", "March 2027 client approval", "March 2027 scheduled",
    ]);

    // A new cycle takes the new rules: two steps, their titles and dates.
    const fresh = await planned({ target: 1 });
    const s = await steps(fresh.cycleId);
    expect(s.map((x) => [x.step, x.title, x.due])).toEqual([["planning", "March 2027 content plan", READY_BY], ["deploy", "March 2027 live", "2027-02-23"]]);

    // `deploy` is manual: scheduling every post does not close it ...
    const p = await newPost(fresh);
    await driveTo(fresh, p, "scheduled");
    expect(await doneOf(fresh.cycleId)).toEqual({ planning: true, deploy: false });
    // ... and once closed by hand, a reschedule (its old condition broken) does not reopen it.
    const deploy = await step(fresh.cycleId, "deploy");
    expect((await app.inject({ method: "PATCH", url: `/api/${A}/pm/tasks/${deploy.id}`, headers: as(U.hod), payload: { status: "done" } })).statusCode).toBe(200);
    await ok(await act(fresh.officer, p, "reschedule", { at: "2027-03-15T10:00:00.000Z" }), "reschedule");
    expect(await doneOf(fresh.cycleId)).toEqual({ planning: true, deploy: true });
  });
});
