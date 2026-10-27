// SCP-1l — the shared comment thread on a social_post (FRONTEND-BFF-CONTRACT §63.8, PERMISSION-CONTRACT §53.12) against live
// Postgres and Cerbos. Skips without DATABASE_URL_TEST, like every suite here; on CI it runs for real. Every case drives the REAL
// route as a real persona with the real policies, never a service function with the authorization mocked out.
//
// What it proves:
//   (1) who writes: the officer and a seat approver write a client-visible comment (with a pin); a copywriter and a non-owner
//       staff member write only a team one (403 not_officer_or_approver for client, and nothing is stored);
//   (2) who reads and writes at all: a member with no read on the post is refused both, as 403; a Creatives designer on the
//       month request reads and writes team comments through `design` (never a client one);
//   (3) another entity type refuses `visibility` and `anchor` with 400 {field}, and its thread is unchanged (team, no pin);
//   (4) the pin's file must be a file of THAT post: a live design row's file or a reference image is admitted; another post's
//       file, a removed design's file, an unknown file and a malformed pin are 400 {field: "anchor"};
//   (5) authorization before validation: a refused caller never reads a 400, on a social_post thread or any other;
//   (6) the read shape (additive `visibility`, `anchor`, the old fields intact), a missing post is 404 post_not_found;
//   (7) `clientVisibleComments`, the rule the portal reads through: nothing until the post reached the client, then only the
//       client-visible comments.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject, createTask } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialSeat, grantSocialRole } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { MUST_HAVE_KEYS } from "./handoff-checks";
import { clientVisibleComments } from "./post-comments";

const FUTURE = "2027-03-10T10:00:00.000Z";
const SOCIAL = { modules: ["social"] };
const SVC = { authorization: "Bearer svc-token" };
const as = (userId: string) => ({ ...SVC, "x-user-id": userId });

describe.skipIf(!TEST_URL)("SCP-1l · the social_post comment thread (BFF §63.8)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  let engagementId: string;
  let cycleId: string;
  let postId: string; // driven to `design`, the month request names the designer
  let otherPostId: string;
  let taskId: string;
  // Files: a design row's file, a reference image, another post's file, a removed design's file.
  let designFile: string;
  let referenceFile: string;
  let foreignFile: string;
  let removedFile: string;

  const base = () => `/api/${A}/modules/social`;
  const commentsUrl = () => `/api/${A}/comments`;

  async function ok(res: { statusCode: number; body: string }, label: string) {
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${label}: ${res.statusCode} ${res.body}`);
  }
  async function act(who: string, id: string, action: string) {
    const r = await adminPool().query(`SELECT pipeline_status FROM social_posts WHERE id = $1`, [id]);
    const res = await app.inject({
      method: "POST", url: `${base()}/posts/${id}/actions`, headers: as(who),
      payload: { action, expectedStatus: r.rows[0].pipeline_status },
    });
    await ok(res, action);
  }
  async function newPost(): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `${base()}/cycles/${cycleId}/posts`, headers: as(U.officer),
      payload: { title: "Mock bakery: morning pastries", format: "feed", scheduledAt: FUTURE, placement: ["instagram"] },
    });
    await ok(res, "create post");
    return (res.json() as { post: { id: string } }).post.id;
  }
  const post = (who: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: commentsUrl(), headers: as(who), payload });
  const list = (who: string, entityType: string, entityId: string) =>
    app.inject({ method: "GET", url: `${commentsUrl()}?entityType=${entityType}&entityId=${entityId}`, headers: as(who) });
  const rowCount = async (entityType: string, entityId: string) =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM comments WHERE target_entity_type = $1 AND target_entity_id = $2`, [entityType, entityId])).rows[0].n);
  const pin = (fileId: string, over: Record<string, unknown> = {}) => ({ x: 0.25, y: 0.5, fileId, ...over });

  async function fileRow(targetType: string, targetId: string): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'mock.jpg', 'image/jpeg', 1024, $6, 'central')`,
      [id, A, U.designer, targetType, targetId, `mock/${id}.jpg`],
    );
    return id;
  }
  async function designRow(forPost: string, fileId: string, position: number, removed = false) {
    await adminPool().query(
      `INSERT INTO social_post_designs (id, tenant_id, post_id, position, link_url, link_source, file_id, added_by, removed_by, removed_at)
       VALUES ($1, $2, $3, $4, 'https://example.invalid/mock.jpg', 'own', $5, $6, $7, $8)`,
      [newId(), A, forPost, position, fileId, U.designer, removed ? U.designer : null, removed ? new Date().toISOString() : null],
    );
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    process.env.SOCIAL_POSTIZ_ORG_API_KEY = "mock-key";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("Mock Agency", ["social", "pm"]);
    const units = await seedSocialOrgTree(A);
    for (const p of ["officer", "otherStaff", "copywriter", "hod", "designer", "outsider", "viewer", "creativesHead"]) {
      U[p] = await createUser(`scp1l-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
      await addMembership(A, U[p]);
    }
    for (const p of ["officer", "otherStaff", "copywriter", "hod", "designer", "outsider", "creativesHead"]) await grantSocialRole(A, U[p], "member");
    await grantRole(U.viewer, await createRole("viewer"), "company", A);
    // The team's read tier (social_staff). The outsider holds `member` only: no read on any post.
    for (const p of ["officer", "otherStaff", "copywriter", "hod"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.creatives, U.creativesHead);

    const clientId = await createClient(A, "Mock Client 1l");
    engagementId = newId();
    cycleId = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, origin_site)
         VALUES ($1, $2, $3, 'Mock engagement 1l', $4, 'active', $5, 'creatives', $6, 'central')`,
        [engagementId, A, clientId, U.officer, JSON.stringify({ networks: { instagram: true, facebook: true } }), ["instagram", "facebook"]],
      );
      const orgId = newId();
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
        [orgId, A, clientId, `mock-org-1l-${newId().slice(0, 8)}`],
      );
      for (const network of ["instagram", "facebook"]) {
        await c.query(
          `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, postiz_integration_id, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'connected', '{"igPosts24h":{"used":0,"cap":100}}', $7, 'central')`,
          [newId(), A, clientId, orgId, network, `@mock-${network}-1l`, `int-${network}-1l`],
        );
      }
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
         VALUES ($1, $2, $3, '2027-03-01', '2027-02-26', '2027-02-24', 'central')`,
        [cycleId, A, engagementId],
      );
    }, SOCIAL);

    app = await buildApp();

    // The post under test, driven through the real routes to `design`, where the month request exists and Creatives names
    // the designer (the PM step Creatives takes in its own board).
    postId = await newPost();
    await act(U.officer, postId, "start_draft");
    const fill = await app.inject({
      method: "PATCH", url: `${base()}/posts/${postId}/pipeline`, headers: as(U.officer),
      payload: {
        expectedStatus: "drafting",
        fields: {
          caption: "Fresh pastries every morning.", onAssetText: "Open daily", cta: "Visit us", hashtags: ["mockbakery"],
          mustHaves: [...MUST_HAVE_KEYS], rawAssets: [{ url: "https://example.invalid/ref.jpg", label: "Reference", source: "own" }],
        },
      },
    });
    await ok(fill, "fill");
    await act(U.officer, postId, "send_to_proofread");
    await act(U.copywriter, postId, "approve_copy");
    await act(U.hod, postId, "approve_for_design");
    const req = await adminPool().query(`SELECT creative_request_id::text AS id FROM social_posts WHERE id = $1`, [postId]);
    await adminPool().query(
      `UPDATE pm_tasks SET assignee = jsonb_set(COALESCE(assignee, '{}'::jsonb), '{responsibleId}', to_jsonb($2::text))
        WHERE id = (SELECT pm_task_id FROM work_requests WHERE id = $1)`,
      [req.rows[0].id, U.designer],
    );

    otherPostId = await newPost();
    designFile = await fileRow("creative_asset", newId());
    await designRow(postId, designFile, 1);
    referenceFile = await fileRow("social_post", postId);
    foreignFile = await fileRow("social_post", otherPostId);
    await designRow(otherPostId, foreignFile, 1);
    removedFile = await fileRow("creative_asset", newId());
    await designRow(postId, removedFile, 2, true);

    const project = await createProject(A, "Rebrand 1l");
    taskId = await createTask(A, project, "Mock task 1l");
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── (1) who writes ────────────────────────────────────────────────────────────────────────────────────────────
  it("the officer writes a client-visible comment with a pin, and it reads back with both", async () => {
    const res = await post(U.officer, { entityType: "social_post", entityId: postId, body: "Please check the date on the board.", visibility: "client", anchor: pin(designFile) });
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json() as { id: string };
    const got = await list(U.officer, "social_post", postId);
    expect(got.statusCode).toBe(200);
    const row = (got.json() as Array<Record<string, any>>).find((c) => c.id === id)!;
    expect(row).toMatchObject({ visibility: "client", body: "Please check the date on the board.", anchor: { x: 0.25, y: 0.5, fileId: designFile } });
  });

  it("a seat approver (the HoD) writes a client-visible comment", async () => {
    const res = await post(U.hod, { entityType: "social_post", entityId: postId, body: "Approved from our side.", visibility: "client" });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("a copywriter writes a team comment (also with an explicit team, and with a pin) but not a client one", async () => {
    expect((await post(U.copywriter, { entityType: "social_post", entityId: postId, body: "Caption tightened." })).statusCode).toBe(201);
    expect((await post(U.copywriter, { entityType: "social_post", entityId: postId, body: "Team, explicit.", visibility: "team" })).statusCode).toBe(201);
    expect((await post(U.copywriter, { entityType: "social_post", entityId: postId, body: "Pinned note.", anchor: pin(referenceFile) })).statusCode).toBe(201);
    const before = await rowCount("social_post", postId);
    const res = await post(U.copywriter, { entityType: "social_post", entityId: postId, body: "Hello client.", visibility: "client" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "not_officer_or_approver" });
    expect(await rowCount("social_post", postId)).toBe(before);
  });

  it("a staff member who is not the client's officer writes team only", async () => {
    expect((await post(U.otherStaff, { entityType: "social_post", entityId: postId, body: "A thought." })).statusCode).toBe(201);
    const res = await post(U.otherStaff, { entityType: "social_post", entityId: postId, body: "For the client.", visibility: "client" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "not_officer_or_approver" });
  });

  // ── (2) read and write need a read on the post (or design) ───────────────────────────────────────────────────
  it("a member with no read on the post is refused both reading and writing the thread", async () => {
    const before = await rowCount("social_post", postId);
    const read = await list(U.outsider, "social_post", postId);
    expect(read.statusCode).toBe(403);
    expect((read.json() as { error: string }).error).toMatch(/^not authorized/);
    for (const extra of [{}, { visibility: "client" }, { visibility: "team", anchor: pin(designFile) }]) {
      const w = await post(U.outsider, { entityType: "social_post", entityId: postId, body: "I should not be here.", ...extra });
      expect(w.statusCode, JSON.stringify(extra)).toBe(403);
      expect((w.json() as { error: string }).error).toMatch(/^not authorized/);
    }
    expect(await rowCount("social_post", postId)).toBe(before);
  });

  it("a Creatives designer on the month request reads and writes team comments through design, never a client one", async () => {
    const read = await list(U.designer, "social_post", postId);
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as unknown[]).length).toBeGreaterThan(0);
    const w = await post(U.designer, { entityType: "social_post", entityId: postId, body: "Exporting the final now.", anchor: pin(designFile) });
    expect(w.statusCode, w.body).toBe(201);
    const c = await post(U.designer, { entityType: "social_post", entityId: postId, body: "Hello client.", visibility: "client" });
    expect(c.statusCode).toBe(403);
    expect(c.json()).toMatchObject({ error: "not_officer_or_approver" });
  });

  it("the same designer has no read on a post of another request", async () => {
    const res = await list(U.designer, "social_post", otherPostId);
    expect(res.statusCode).toBe(403);
  });

  it("a post that does not exist is 404 post_not_found, read and write", async () => {
    const ghost = newId();
    const r = await list(U.officer, "social_post", ghost);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: "post_not_found" });
    const w = await post(U.officer, { entityType: "social_post", entityId: ghost, body: "Into the void." });
    expect(w.statusCode).toBe(404);
    expect(w.json()).toMatchObject({ error: "post_not_found" });
  });

  // ── (3) another entity type ────────────────────────────────────────────────────────────────────────────────
  it("another entity type refuses visibility and anchor with 400 and the field, and its thread is unchanged", async () => {
    const ok1 = await post(U.officer, { entityType: "task", entityId: taskId, body: "A plain task comment." });
    expect(ok1.statusCode, ok1.body).toBe(201);
    const before = await rowCount("task", taskId);
    for (const [extra, field] of [
      [{ visibility: "team" }, "visibility"], [{ visibility: "client" }, "visibility"],
      [{ anchor: pin(designFile) }, "anchor"], [{ anchor: null }, "anchor"],
    ] as const) {
      const res = await post(U.officer, { entityType: "task", entityId: taskId, body: "Nope.", ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.json()).toMatchObject({ field });
    }
    expect(await rowCount("task", taskId)).toBe(before);
    const got = (await list(U.officer, "task", taskId)).json() as Array<Record<string, any>>;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ body: "A plain task comment.", visibility: "team", anchor: null });
    const stored = await adminPool().query(`SELECT visibility, anchor FROM comments WHERE target_entity_type = 'task' AND target_entity_id = $1`, [taskId]);
    expect(stored.rows).toEqual([{ visibility: "team", anchor: null }]);
  });

  it("the read keeps every old field and adds visibility and anchor", async () => {
    const got = (await list(U.officer, "task", taskId)).json() as Array<Record<string, unknown>>;
    for (const k of ["id", "author_id", "author_name", "body", "parent_comment_id", "created_at", "reactions", "visibility", "anchor"]) expect(got[0], k).toHaveProperty(k);
  });

  // ── (4) the pin's file ─────────────────────────────────────────────────────────────────────────────────────
  it("a pin on a live design's file or a reference image of the post is admitted", async () => {
    for (const f of [designFile, referenceFile]) {
      const res = await post(U.officer, { entityType: "social_post", entityId: postId, body: "On this one.", anchor: pin(f, { x: 0, y: 1 }) });
      expect(res.statusCode, res.body).toBe(201);
    }
    // The id is read case-insensitively and stored lower-case.
    const up = await post(U.officer, { entityType: "social_post", entityId: postId, body: "Upper-case id.", anchor: pin(designFile.toUpperCase()) });
    expect(up.statusCode, up.body).toBe(201);
    const stored = await adminPool().query(`SELECT anchor FROM comments WHERE id = $1`, [(up.json() as { id: string }).id]);
    expect(stored.rows[0].anchor.fileId).toBe(designFile);
  });

  it("a pin on a file of another post, a removed design, an unknown file or in a bad shape is 400 {field: anchor}", async () => {
    const before = await rowCount("social_post", postId);
    const bad: Array<[string, unknown]> = [
      ["another post's file", pin(foreignFile)],
      ["a removed design's file", pin(removedFile)],
      ["an unknown file", pin(newId())],
      ["x above 1", pin(designFile, { x: 1.5 })],
      ["y below 0", pin(designFile, { y: -0.2 })],
      ["x a string", pin(designFile, { x: "0.5" })],
      ["no fileId", { x: 0.5, y: 0.5 }],
      ["fileId not a uuid", pin("not-a-uuid")],
      ["an array", [0.5, 0.5]],
      ["a string", "pin"],
    ];
    for (const [label, anchor] of bad) {
      const res = await post(U.officer, { entityType: "social_post", entityId: postId, body: "Pin.", anchor });
      expect(res.statusCode, label).toBe(400);
      expect(res.json(), label).toMatchObject({ field: "anchor" });
    }
    expect(await rowCount("social_post", postId)).toBe(before);
  });

  it("a visibility that is neither team nor client is 400 {field: visibility}", async () => {
    for (const v of ["everyone", "", "CLIENT", 1]) {
      const res = await post(U.officer, { entityType: "social_post", entityId: postId, body: "Hm.", visibility: v });
      expect(res.statusCode, String(v)).toBe(400);
      expect(res.json()).toMatchObject({ field: "visibility" });
    }
  });

  // ── (5) authorization before validation ──────────────────────────────────────────────────────────────────────
  it("403 comes before 400: a refused caller never reads a validation error", async () => {
    // No read on the post, bad everything.
    const a = await post(U.outsider, { entityType: "social_post", entityId: postId, body: "x", visibility: "everyone", anchor: { x: 9 } });
    expect(a.statusCode).toBe(403);
    // May write team, may not write client: the refusal names itself even though the pin is also bad.
    const b = await post(U.copywriter, { entityType: "social_post", entityId: postId, body: "x", visibility: "client", anchor: pin(foreignFile) });
    expect(b.statusCode).toBe(403);
    expect(b.json()).toMatchObject({ error: "not_officer_or_approver" });
    // A viewer may not comment at all: 403 on any thread, however bad the extra fields.
    const c = await post(U.viewer, { entityType: "task", entityId: taskId, body: "x", visibility: "client", anchor: { x: 9 } });
    expect(c.statusCode).toBe(403);
    const d = await post(U.viewer, { entityType: "social_post", entityId: postId, body: "x", visibility: "client", anchor: { x: 9 } });
    expect(d.statusCode).toBe(403);
  });

  // ── (7) the portal's rule ──────────────────────────────────────────────────────────────────────────────────
  it("clientVisibleComments answers nothing until the post reached the client, then only the client-visible comments", async () => {
    const mine = await post(U.officer, { entityType: "social_post", entityId: otherPostId, body: "Team only note." });
    expect(mine.statusCode, mine.body).toBe(201);
    const shown = await post(U.officer, { entityType: "social_post", entityId: otherPostId, body: "Client, please look.", visibility: "client", anchor: pin(foreignFile, { x: 0.4, y: 0.6 }) });
    expect(shown.statusCode, shown.body).toBe(201);
    const read = () => withTenants([A], (c) => clientVisibleComments(c, A, otherPostId));

    expect(await read()).toEqual([]); // not sent yet
    await adminPool().query(`UPDATE social_posts SET client_first_sent_at = now() WHERE id = $1`, [otherPostId]);
    const seen = await read();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: (shown.json() as { id: string }).id, body: "Client, please look.", anchor: { x: 0.4, y: 0.6, fileId: foreignFile } });
    expect(seen[0]).not.toHaveProperty("authorId");

    // A soft-deleted comment drops off; another post's comments never appear.
    await adminPool().query(`UPDATE comments SET deleted_at = now() WHERE id = $1`, [seen[0]!.id]);
    expect(await read()).toEqual([]);
    expect(await withTenants([A], (c) => clientVisibleComments(c, A, postId))).toEqual([]); // `postId` never reached the client
  });
});
