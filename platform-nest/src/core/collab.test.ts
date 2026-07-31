// 5c.3: comments + notifications. Threaded polymorphic comments, and notifications raised on
// assignment (task PATCH), mention (@ in a comment), and comment-on-assigned-work. A user
// sees only their own inbox; self-notification is skipped.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { newId, withTenants } from "../db";
import { relayBatch } from "../events/relay";
import { consumeWorkActivityOnce } from "../events/work-activity-consumer";
import { setRedis, closeRedis } from "../events/redis";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, createTask } from "../testing/fixtures";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

type Notif = { id: string; type: string; payload: { entityId?: string } };

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("collaboration: comments + notifications", () => {
  let app: NestFastifyApplication;
  let redis: Redis;
  let co: string;
  let manager: string, member: string, assignee: string, viewer: string;
  let projectId: string, taskId: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });
  const unread = async (uid: string) =>
    (await app.inject({ method: "GET", url: `/api/${co}/notifications?unread=true`, headers: asUser(uid) })).json() as Notif[];

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Creative House");
    manager = await createUser("mgr@cl.test");
    member = await createUser("mem@cl.test");
    assignee = await createUser("asg@cl.test");
    viewer = await createUser("view@cl.test");
    for (const u of [manager, member, assignee, viewer]) await addMembership(co, u);
    await grantRole(manager, await createRole("manager"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(assignee, await createRole("member"), "company", co);
    await grantRole(viewer, await createRole("viewer"), "company", co);

    projectId = await createProject(co, "Rebrand");
    taskId = await createTask(co, projectId, "Design hero");
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await closeRedis();
    await teardownTestDb();
  });

  it("member comments on a task; it lists back with the author", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/comments`,
      headers: asUser(member), payload: { entityType: "task", entityId: taskId, body: "First pass looks good" },
    });
    expect(r.statusCode).toBe(201);
    const list = await app.inject({
      method: "GET", url: `/api/${co}/comments?entityType=task&entityId=${taskId}`, headers: asUser(member),
    });
    const rows = list.json() as Array<{ id: string; author_name: string; body: string }>;
    expect(rows.find((c) => c.id === r.json().id)?.author_name).toBe("mem");
  });

  it("a viewer cannot comment (read-only role)", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/comments`,
      headers: asUser(viewer), payload: { entityType: "task", entityId: taskId, body: "nope" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("assigning a task notifies the new assignee", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/tasks/${taskId}`, headers: asUser(manager), payload: { assigneeId: assignee },
    });
    expect(r.statusCode).toBe(200);
    const n = await unread(assignee);
    expect(n.some((x) => x.type === "assignment" && x.payload.entityId === taskId)).toBe(true);
  });

  it("commenting on an assigned task notifies the assignee", async () => {
    await app.inject({
      method: "POST", url: `/api/${co}/comments`,
      headers: asUser(member), payload: { entityType: "task", entityId: taskId, body: "Please tweak the kerning" },
    });
    expect((await unread(assignee)).some((x) => x.type === "comment")).toBe(true);
  });

  it("an @mention notifies the mentioned user", async () => {
    await app.inject({
      method: "POST", url: `/api/${co}/comments`,
      headers: asUser(member), payload: { entityType: "task", entityId: taskId, body: "cc @manager", mentions: [manager] },
    });
    expect((await unread(manager)).some((x) => x.type === "mention")).toBe(true);
  });

  it("a user sees only their own notifications and can mark them all read", async () => {
    const before = await unread(assignee);
    expect(before.length).toBeGreaterThan(0);
    const markAll = await app.inject({ method: "POST", url: `/api/${co}/notifications/read-all`, headers: asUser(assignee) });
    expect(markAll.statusCode).toBe(200);
    expect((await unread(assignee)).length).toBe(0);
    // manager's mention is untouched by assignee's read-all (per-user inbox).
    expect((await unread(manager)).some((x) => x.type === "mention")).toBe(true);
  });

  it("self-notification is skipped (assignee commenting on their own task)", async () => {
    await app.inject({
      method: "POST", url: `/api/${co}/comments`,
      headers: asUser(assignee), payload: { entityType: "task", entityId: taskId, body: "on it" },
    });
    expect((await unread(assignee)).length).toBe(0);
  });

  // WS4: POST /notifications — an elevated actor (or scoped automation account) raises a
  // notice for another member; a plain member cannot.
  it("a manager can raise a notification for a member; a member cannot", async () => {
    const ok = await app.inject({
      method: "POST", url: `/api/${co}/notifications`,
      headers: asUser(manager), payload: { recipientId: viewer, type: "client_onboarded", payload: { note: "x" } },
    });
    expect(ok.statusCode).toBe(201);
    expect((await unread(viewer)).some((x) => x.type === "client_onboarded")).toBe(true);

    const denied = await app.inject({
      method: "POST", url: `/api/${co}/notifications`,
      headers: asUser(member), payload: { recipientId: viewer, type: "spam" },
    });
    expect(denied.statusCode).toBe(403);
  });

  // ---------------- Reactions (P3-08) ----------------
  describe("comment reactions (P3-08)", () => {
    let reactCommentId: string;

    beforeAll(async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${co}/comments`,
        headers: asUser(member), payload: { entityType: "task", entityId: taskId, body: "react to me" },
      });
      reactCommentId = (r.json() as { id: string }).id;
    });

    const reactionsFor = async (id: string, viewerId: string) => {
      const list = (await app.inject({ method: "GET", url: `/api/${co}/comments?entityType=task&entityId=${taskId}`, headers: asUser(viewerId) })).json() as Array<{
        id: string; reactions: Array<{ emoji: string; count: number; mine: boolean }>;
      }>;
      return list.find((c) => c.id === id)!.reactions;
    };

    it("adds a reaction, is idempotent on re-add, aggregates count + per-viewer `mine`, and rejects an off-set emoji", async () => {
      const add = await app.inject({ method: "POST", url: `/api/${co}/comments/${reactCommentId}/reactions`, headers: asUser(manager), payload: { emoji: "👍" } });
      expect(add.statusCode).toBe(201);
      const again = await app.inject({ method: "POST", url: `/api/${co}/comments/${reactCommentId}/reactions`, headers: asUser(manager), payload: { emoji: "👍" } });
      expect(again.statusCode).toBe(201); // idempotent — no PK-conflict error

      const offSet = await app.inject({ method: "POST", url: `/api/${co}/comments/${reactCommentId}/reactions`, headers: asUser(manager), payload: { emoji: "🥸" } });
      expect(offSet.statusCode).toBe(400);

      const mine = await reactionsFor(reactCommentId, manager);
      const thumbsMine = mine.find((rr) => rr.emoji === "👍")!;
      expect(thumbsMine.count).toBe(1); // idempotent add didn't double-count
      expect(thumbsMine.mine).toBe(true);

      const asOther = await reactionsFor(reactCommentId, member);
      expect(asOther.find((rr) => rr.emoji === "👍")!.mine).toBe(false); // same count, viewer-scoped `mine`
    });

    it("404s reacting to a comment that doesn't exist", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${co}/comments/00000000-0000-0000-0000-000000000000/reactions`,
        headers: asUser(manager), payload: { emoji: "🔥" },
      });
      expect(r.statusCode).toBe(404);
    });

    it("a viewer (read-only role) cannot react", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${co}/comments/${reactCommentId}/reactions`, headers: asUser(viewer), payload: { emoji: "🎉" } });
      expect(r.statusCode).toBe(403);
    });

    it("user A cannot delete user B's reaction; deleting your own works (self-row delete only)", async () => {
      await app.inject({ method: "POST", url: `/api/${co}/comments/${reactCommentId}/reactions`, headers: asUser(assignee), payload: { emoji: "❤️" } });

      // manager never added a ❤️ — deleting it under manager's session is a no-op, not a cross-user delete
      await app.inject({ method: "DELETE", url: `/api/${co}/comments/${reactCommentId}/reactions/${encodeURIComponent("❤️")}`, headers: asUser(manager) });
      let hearts = (await reactionsFor(reactCommentId, assignee)).find((rr) => rr.emoji === "❤️");
      expect(hearts?.count).toBe(1); // assignee's reaction survived manager's delete attempt

      // assignee deletes their OWN reaction — succeeds
      await app.inject({ method: "DELETE", url: `/api/${co}/comments/${reactCommentId}/reactions/${encodeURIComponent("❤️")}`, headers: asUser(assignee) });
      hearts = (await reactionsFor(reactCommentId, assignee)).find((rr) => rr.emoji === "❤️");
      expect(hearts).toBeUndefined();
    });

    it("tenant isolation: a rival tenant's session cannot react on this tenant's comment (RLS empty-set, forged id 404s)", async () => {
      const rivalCo = await createCompany("Rival Co (reactions)");
      const rivalUser = await createUser("rival-reactions@x.test");
      await addMembership(rivalCo, rivalUser);
      await grantRole(rivalUser, await createRole("manager"), "company", rivalCo);

      // not a member of `co` -> denied outright on the real tenant's URL
      const cross = await app.inject({
        method: "POST", url: `/api/${co}/comments/${reactCommentId}/reactions`, headers: asUser(rivalUser), payload: { emoji: "👀" },
      });
      expect(cross.statusCode).toBe(403);

      // rival's OWN tenant URL against tenant `co`'s comment id -> RLS scopes `comments` (and
      // comment_reactions) to rivalCo, so the comment is invisible -> 404, never a cross-write.
      const forged = await app.inject({
        method: "POST", url: `/api/${rivalCo}/comments/${reactCommentId}/reactions`, headers: asUser(rivalUser), payload: { emoji: "👀" },
      });
      expect(forged.statusCode).toBe(404);
    });
  });

  // ---------------- TR-05: pm.task.commented -> work_activity evidence ----------------
  describe("comment -> pm work_activity evidence (TR-05)", () => {
    it("commenting on a genuine pm_tasks row emits pm.task.commented, landing as a work_activity row", async () => {
      const pmTaskId = newId();
      await withTenants([co], (c) =>
        c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, $4, 'central')`, [
          pmTaskId, co, projectId, "A real PM task",
        ]),
      );

      const r = await app.inject({
        method: "POST", url: `/api/${co}/comments`,
        headers: asUser(member), payload: { entityType: "task", entityId: pmTaskId, body: "Nice work on this PM task" },
      });
      expect(r.statusCode).toBe(201);

      await relayBatch(100);
      const handled = await consumeWorkActivityOnce("pm_task");
      expect(handled).toBe(1);

      const row = await adminPool().query(
        `SELECT id, source, verb, object_kind, object_ref, actor_user_id FROM work_activity WHERE object_ref = $1 AND verb = 'commented'`,
        [pmTaskId],
      );
      expect(row.rows[0]).toMatchObject({
        source: "pm", verb: "commented", object_kind: "pm_task", object_ref: pmTaskId,
        // TR-31: the commenting user's id propagates through the outbox payload into
        // actor_user_id — this is what the person-grain comments_authored metric reads; before
        // TR-31 this was hardcoded null on every consumer-derived row.
        actor_user_id: member,
      });

      // TR-31: the propagated actorId is a structured hint (work-activity-linker.ts rule a), so
      // it mints an EXACT person link, not a uuid_scan inference.
      const personLink = await adminPool().query(
        `SELECT target_id, confidence, rule FROM work_activity_links WHERE activity_id = $1 AND target_kind = 'person'`,
        [row.rows[0].id],
      );
      expect(personLink.rows).toEqual([{ target_id: member, confidence: "exact", rule: "hint:actorId" }]);
    });

    it("commenting on the base `tasks` table's task (NOT a pm_tasks row) never mints a bogus source='pm' work_activity row", async () => {
      // `taskId` (module-level fixture) is a base `tasks` row (createTask), never inserted into
      // pm_tasks — the comment guard in collab.controller.ts must skip emitting entirely.
      await app.inject({
        method: "POST", url: `/api/${co}/comments`,
        headers: asUser(member), payload: { entityType: "task", entityId: taskId, body: "comment on a non-PM task" },
      });
      await relayBatch(100);
      await consumeWorkActivityOnce("pm_task"); // no-op if nothing was ever emitted for this id

      const row = await adminPool().query(`SELECT count(*)::int AS n FROM work_activity WHERE object_ref = $1`, [taskId]);
      expect(row.rows[0].n).toBe(0);
    });
  });
});
