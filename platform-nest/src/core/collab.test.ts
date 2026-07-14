// 5c.3: comments + notifications. Threaded polymorphic comments, and notifications raised on
// assignment (task PATCH), mention (@ in a comment), and comment-on-assigned-work. A user
// sees only their own inbox; self-notification is skipped.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, createTask } from "../testing/fixtures";

type Notif = { id: string; type: string; payload: { entityId?: string } };

describe.skipIf(!TEST_URL)("collaboration: comments + notifications", () => {
  let app: NestFastifyApplication;
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
});
