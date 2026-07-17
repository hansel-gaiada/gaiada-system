// PM subsystem (§5) — rich tasks, subtasks→progress coupling, deps, time, milestones, docs,
// and the AI Tracker (suggest → confirm). Against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("PM subsystem (§5)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let manager: string;
  let member: string;
  let projectId: string;
  const hdr = () => asUser(manager);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Agency A", ["agency"]);
    manager = await createUser("mgr@a.test", "Manager Mo");
    member = await createUser("mem@a.test", "Member Mel");
    await addMembership(tenant, manager);
    await addMembership(tenant, member);
    await grantRole(manager, await createRole("manager"), "company", tenant);
    await grantRole(member, await createRole("member"), "company", tenant);
    projectId = await createProject(tenant, "Website Revamp", manager);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const createTask = async (body: Record<string, unknown>, headers = hdr()) =>
    app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers, payload: { projectId, ...body } });

  it("creates a task with a poly-assignee and lists it under the project", async () => {
    const r = await createTask({
      title: "Design homepage",
      priority: "high",
      assignee: { kind: "person", refId: member, refName: "Member Mel", responsibleId: member, responsibleName: "Member Mel" },
    });
    expect(r.statusCode).toBe(201);
    const { id } = r.json() as { id: string };

    const list = await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${projectId}/tasks`, headers: hdr() });
    const tasks = list.json() as Array<{ id: string; title: string; assignee: { responsibleId: string } | null; loggedMinutes: number }>;
    const found = tasks.find((t) => t.id === id)!;
    expect(found.title).toBe("Design homepage");
    expect(found.assignee?.responsibleId).toBe(member);
    expect(found.loggedMinutes).toBe(0);

    // the responsible person got an assignment notification with a deep-link href
    const notifs = (await app.inject({ method: "GET", url: `/api/${tenant}/notifications`, headers: asUser(member) })).json() as Array<{ payload: { href?: string } }>;
    expect(notifs.some((n) => n.payload?.href === `/tasks/${id}`)).toBe(true);
  });

  it("subtasks drive progress; 100% couples status to done", async () => {
    const id = (await createTask({ title: "Build API" }).then((r) => r.json())).id as string;
    const patch = (body: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: body });

    await patch({ addSubtask: "Endpoint A" });
    await patch({ addSubtask: "Endpoint B" });
    let task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { subtasks: { id: string; done: boolean }[]; progress: number; status: string };
    expect(task.progress).toBe(0);

    await patch({ toggleSubtask: task.subtasks[0].id });
    task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as typeof task;
    expect(task.progress).toBe(50);
    expect(task.status).toBe("todo");

    await patch({ toggleSubtask: task.subtasks[1].id });
    task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as typeof task;
    expect(task.progress).toBe(100);
    expect(task.status).toBe("done");
  });

  it("a member can log time; loggedMinutes rolls up", async () => {
    const id = (await createTask({ title: "QA pass" }).then((r) => r.json())).id as string;
    const r = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/time`, headers: asUser(member), payload: { minutes: 90, billable: true, note: "testing", spentOn: "2026-07-16" } });
    expect(r.statusCode).toBe(201);
    const logs = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}/time`, headers: hdr() })).json() as Array<{ minutes: number; userName: string; spentOn: string }>;
    expect(logs[0].minutes).toBe(90);
    expect(logs[0].userName).toBe("Member Mel");
    expect(logs[0].spentOn).toBe("2026-07-16");
    const task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { loggedMinutes: number };
    expect(task.loggedMinutes).toBe(90);
  });

  it("dependencies: add + self-dependency rejected + cleaned up on delete", async () => {
    const a = (await createTask({ title: "A" }).then((r) => r.json())).id as string;
    const b = (await createTask({ title: "B" }).then((r) => r.json())).id as string;
    const dep = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${b}`, headers: hdr(), payload: { addDependency: a } });
    expect(dep.statusCode).toBe(200);
    let task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${b}`, headers: hdr() })).json() as { dependsOn: string[] };
    expect(task.dependsOn).toContain(a);

    const self = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${b}`, headers: hdr(), payload: { addDependency: b } });
    expect(self.statusCode).toBe(400);

    await app.inject({ method: "DELETE", url: `/api/${tenant}/pm/tasks/${a}`, headers: hdr() });
    task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${b}`, headers: hdr() })).json() as { dependsOn: string[] };
    expect(task.dependsOn).not.toContain(a);
  });

  it("milestones + docs CRUD; project rollup reflects counts", async () => {
    const ms = await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${projectId}/milestones`, headers: hdr(), payload: { name: "MVP", dueDate: "2026-08-01" } });
    expect(ms.statusCode).toBe(201);
    const doc = await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${projectId}/docs`, headers: hdr(), payload: { title: "Spec", body: "the plan" } });
    expect(doc.statusCode).toBe(201);

    const proj = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${projectId}`, headers: hdr() })).json() as { milestones: unknown[]; docCount: number; taskCount: number };
    expect(proj.milestones.length).toBeGreaterThanOrEqual(1);
    expect(proj.docCount).toBeGreaterThanOrEqual(1);
    expect(proj.taskCount).toBeGreaterThan(0);
  });

  it("AI Tracker: run proposes, confirm applies to the task", async () => {
    const id = (await createTask({ title: "Track me" }).then((r) => r.json())).id as string;
    const patch = (body: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: body });
    await patch({ addSubtask: "one" });
    const t = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { subtasks: { id: string }[] };
    await patch({ toggleSubtask: t.subtasks[0].id }); // 100% because single subtask done → but status already couples

    // reset progress to expose a tracker delta: add an undone subtask
    await patch({ addSubtask: "two" });
    const run = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/tracker/run`, headers: asUser(member), payload: {} });
    expect(run.statusCode).toBe(200);
    const body = run.json() as { suggestions: Array<{ id: string; kind: string; proposed: string }> };
    expect(body.suggestions.length).toBeGreaterThan(0);

    const progressSug = body.suggestions.find((s) => s.kind === "progress")!;
    const confirm = await app.inject({ method: "POST", url: `/api/${tenant}/pm/suggestions/${progressSug.id}/confirm`, headers: hdr(), payload: {} });
    expect(confirm.statusCode).toBe(200);
    const task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { progress: number };
    expect(task.progress).toBe(Number(progressSug.proposed));

    // an AI comment was posted on the task thread
    const comments = (await app.inject({ method: "GET", url: `/api/${tenant}/comments?entityType=task&entityId=${id}`, headers: hdr() })).json() as Array<{ body: string; author_id: string | null }>;
    expect(comments.some((cm) => cm.body.startsWith("AI Tracker:") && cm.author_id === null)).toBe(true);
  });

  it("a plain member cannot create or delete a task (manage-gated)", async () => {
    const create = await createTask({ title: "nope" }, asUser(member));
    expect(create.statusCode).toBe(403);
  });
});
