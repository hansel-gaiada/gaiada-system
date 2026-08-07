// PM subsystem (§5) — rich tasks, subtasks→progress coupling, deps, time, milestones, docs,
// and the AI Tracker (suggest → confirm). Against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { newId } from "../../db";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, defineCustomField } from "../../testing/fixtures";

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
    tenant = await createCompany("Agency A", ["agency", "pm"]);
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

  // ---------------- Custom fields (P2-03, D17 framework reuse) ----------------
  describe("task custom fields", () => {
    it("create + PATCH accept a validated custom field and it round-trips on read", async () => {
      await defineCustomField(tenant, "pm_task", "channel", "text", false);
      const create = await createTask({ title: "CF task", customFields: { channel: "email" } });
      expect(create.statusCode).toBe(201);
      const id = (create.json() as { id: string }).id;
      const got = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { customFields: Record<string, unknown> };
      expect(got.customFields.channel).toBe("email");

      const patch = await app.inject({
        method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { customFields: { channel: "phone" } },
      });
      expect(patch.statusCode).toBe(200);
      const after = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { customFields: Record<string, unknown> };
      expect(after.customFields.channel).toBe("phone");
    });

    it("rejects an unknown custom field key on create and on PATCH", async () => {
      const create = await createTask({ title: "CF bogus", customFields: { bogus: "x" } });
      expect(create.statusCode).toBe(400);

      const id = (await createTask({ title: "CF ok" }).then((r) => r.json())).id as string;
      const patch = await app.inject({
        method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { customFields: { bogus: "x" } },
      });
      expect(patch.statusCode).toBe(400);
    });

    it("enforces a required field and a select field's option set", async () => {
      // Isolated in its own tenant: a required pm_task field def would otherwise break every
      // other test in this file that creates a task via the shared `createTask` helper.
      const isoTenant = await createCompany("Agency CF (isolated)", ["agency", "pm"]);
      const isoManager = await createUser("cf-mgr@x.test", "CF Manager");
      await addMembership(isoTenant, isoManager);
      await grantRole(isoManager, await createRole("manager"), "company", isoTenant);
      const isoProjectId = await createProject(isoTenant, "CF Project", isoManager);
      const isoHdr = asUser(isoManager);
      const isoCreateTask = (body: Record<string, unknown>) =>
        app.inject({ method: "POST", url: `/api/${isoTenant}/pm/tasks`, headers: isoHdr, payload: { projectId: isoProjectId, ...body } });

      const defRes = await app.inject({
        method: "POST", url: `/api/${isoTenant}/custom-fields`, headers: isoHdr,
        payload: { entityType: "pm_task", key: "severity", label: "Severity", dataType: "select", options: ["low", "high"], required: true },
      });
      expect(defRes.statusCode).toBe(201);

      const missing = await isoCreateTask({ title: "CF missing required" });
      expect(missing.statusCode).toBe(400);

      const badOption = await isoCreateTask({ title: "CF bad option", customFields: { severity: "extreme" } });
      expect(badOption.statusCode).toBe(400);

      const ok = await isoCreateTask({ title: "CF good option", customFields: { severity: "high" } });
      expect(ok.statusCode).toBe(201);
    });
  });

  it("a tenant without the pm module enabled 404s on /pm/* (WSA-2 ModuleEnabledGuard)", async () => {
    const darkTenant = await createCompany("Agency B (no pm)", ["agency"]);
    await addMembership(darkTenant, manager);
    const r = await app.inject({ method: "GET", url: `/api/${darkTenant}/pm/tasks`, headers: hdr() });
    expect(r.statusCode).toBe(404);
  });

  // ---------------- Tags (P2-01) ----------------
  describe("project tags", () => {
    let tagId: string;

    it("creates a tag with a valid color slug and lists it under the project", async () => {
      const create = await app.inject({
        method: "POST", url: `/api/${tenant}/pm/projects/${projectId}/tags`, headers: hdr(),
        payload: { label: "Priority", color: "bronze" },
      });
      expect(create.statusCode).toBe(201);
      const tag = create.json() as { id: string; label: string; color: string };
      expect(tag.label).toBe("Priority");
      expect(tag.color).toBe("bronze");
      tagId = tag.id;

      const list = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${projectId}/tags`, headers: hdr() })).json() as Array<{ id: string; label: string; color: string }>;
      expect(list.some((t) => t.id === tagId && t.color === "bronze")).toBe(true);
    });

    it("rejects a color outside the closed 8-slug set, on both create and patch", async () => {
      const bad = await app.inject({
        method: "POST", url: `/api/${tenant}/pm/projects/${projectId}/tags`, headers: hdr(),
        payload: { label: "Bad", color: "red" },
      });
      expect(bad.statusCode).toBe(400);

      const badPatch = await app.inject({
        method: "PATCH", url: `/api/${tenant}/pm/projects/${projectId}/tags/${tagId}`, headers: hdr(),
        payload: { color: "hotpink" },
      });
      expect(badPatch.statusCode).toBe(400);
    });

    it("a plain member cannot create a tag (manage-gated like milestones/docs)", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/pm/projects/${projectId}/tags`, headers: asUser(member),
        payload: { label: "nope", color: "slate" },
      });
      expect(r.statusCode).toBe(403);
    });

    it("patches a tag's label/color", async () => {
      const r = await app.inject({
        method: "PATCH", url: `/api/${tenant}/pm/projects/${projectId}/tags/${tagId}`, headers: hdr(),
        payload: { label: "Urgent", color: "clay" },
      });
      expect(r.statusCode).toBe(200);
      const tag = r.json() as { id: string; label: string; color: string };
      expect(tag.label).toBe("Urgent");
      expect(tag.color).toBe("clay");
    });

    it("a task can only carry tag ids from its OWN project's registry; foreign ids are rejected", async () => {
      const otherProjectId = await createProject(tenant, "Other Project", manager);
      const foreignTagRes = await app.inject({
        method: "POST", url: `/api/${tenant}/pm/projects/${otherProjectId}/tags`, headers: hdr(),
        payload: { label: "Foreign", color: "olive" },
      });
      const foreignTagId = (foreignTagRes.json() as { id: string }).id;

      const id = (await createTask({ title: "Tag me" }).then((r) => r.json())).id as string;

      const foreign = await app.inject({
        method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { tags: [foreignTagId] },
      });
      expect(foreign.statusCode).toBe(400);

      const junk = await app.inject({
        method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { tags: ["not-a-uuid"] },
      });
      expect(junk.statusCode).toBe(400);

      const good = await app.inject({
        method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { tags: [tagId] },
      });
      expect(good.statusCode).toBe(200);
      const task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { tags: string[] };
      expect(task.tags).toEqual([tagId]);
    });

    it("DELETE 409s with {inUse} when a tag is referenced by a task; ?force=1 strips it from tasks then deletes", async () => {
      const id = (await createTask({ title: "Uses tag" }).then((r) => r.json())).id as string;
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { tags: [tagId] } });

      const blocked = await app.inject({ method: "DELETE", url: `/api/${tenant}/pm/projects/${projectId}/tags/${tagId}`, headers: hdr() });
      expect(blocked.statusCode).toBe(409);
      expect((blocked.json() as { inUse: number }).inUse).toBeGreaterThanOrEqual(1);

      // still referenced — not deleted by the blocked attempt
      const stillThere = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${projectId}/tags`, headers: hdr() })).json() as Array<{ id: string }>;
      expect(stillThere.some((t) => t.id === tagId)).toBe(true);

      const forced = await app.inject({ method: "DELETE", url: `/api/${tenant}/pm/projects/${projectId}/tags/${tagId}?force=1`, headers: hdr() });
      expect(forced.statusCode).toBe(200);

      const task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { tags: string[] };
      expect(task.tags).not.toContain(tagId);

      const list = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${projectId}/tags`, headers: hdr() })).json() as Array<{ id: string }>;
      expect(list.some((t) => t.id === tagId)).toBe(false);
    });

    it("tenant isolation: a rival tenant's session cannot read this tenant's tags (RLS empty-set), and a forged id 404s rather than leaking", async () => {
      const rivalTenant = await createCompany("Rival Co (pm tags)", ["agency", "pm"]);
      const rivalAdmin = await createUser("rival-tags@x.test", "Rival Admin");
      await addMembership(rivalTenant, rivalAdmin);
      await grantRole(rivalAdmin, await createRole("manager"), "company", rivalTenant);

      // not a member of `tenant` -> denied outright on the real tenant's URL
      const cross = await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${projectId}/tags`, headers: asUser(rivalAdmin) });
      expect(cross.statusCode).toBe(403);

      // rival's OWN tenant URL, referencing tenant A's project id -> RLS scopes pm_project_tags to
      // rivalTenant, so the (foreign) project has zero tags visible — never tenant A's rows.
      const leakCheck = await app.inject({ method: "GET", url: `/api/${rivalTenant}/pm/projects/${projectId}/tags`, headers: asUser(rivalAdmin) });
      expect(leakCheck.statusCode).toBe(200);
      expect((leakCheck.json() as unknown[]).length).toBe(0);

      // a write against a forged (cross-tenant) project id is a 404, not a leak or a cross-write
      const forgedWrite = await app.inject({
        method: "POST", url: `/api/${rivalTenant}/pm/projects/${projectId}/tags`, headers: asUser(rivalAdmin),
        payload: { label: "x", color: "ink" },
      });
      expect(forgedWrite.statusCode).toBe(404);
    });
  });

  // ---------------- Custom statuses (P2-04, pm-console-ux-design-spec §7) ----------------
  describe("custom statuses", () => {
    // Each test uses its OWN project so materialization never bleeds across cases.
    const freshProject = (name: string) => createProject(tenant, name, manager);
    const newTask = async (pid: string, body: Record<string, unknown> = {}) =>
      (await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers: hdr(), payload: { projectId: pid, title: "T", ...body } }).then((r) => r.json())).id as string;
    const getStatuses = async (pid: string) =>
      (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr() })).json() as Array<{ id: string; label: string; color: string; isDone: boolean; isBlocked: boolean; position: number; wipLimit?: number }>;
    const getTask = async (id: string) =>
      (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { status: string; progress: number };

    // P4-B8b: the synthesized set is the owner's 5-status ladder. `in_progress` keeps its id and only
    // gains the label "Doing" — an id rename would orphan every existing pm_tasks.status value.
    it("a project that never opens the editor reads back the 5 synthesized defaults (byte-identical)", async () => {
      const pid = await freshProject("Statuses fresh");
      const statuses = await getStatuses(pid);
      expect(statuses.map((s) => s.id)).toEqual(["backlog", "todo", "in_progress", "blocked", "done"]);
      expect(statuses.map((s) => s.label)).toEqual(["Backlog", "ToDo", "Doing", "Blocked", "Done"]);
      expect(statuses.find((s) => s.id === "done")!.isDone).toBe(true);
      expect(statuses.find((s) => s.id === "blocked")!.isBlocked).toBe(true);
      expect(statuses.find((s) => s.id === "todo")!.isDone).toBe(false);
      // no wipLimit key on defaults
      expect(statuses.every((s) => s.wipLimit === undefined)).toBe(true);

      // the project GET carries the same synthesized set
      const proj = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}`, headers: hdr() })).json() as { statuses: Array<{ id: string }> };
      expect(proj.statuses.map((s) => s.id)).toEqual(["backlog", "todo", "in_progress", "blocked", "done"]);
    });

    it("a plain member cannot edit statuses (manage-gated); read is allowed", async () => {
      const pid = await freshProject("Statuses rbac");
      const create = await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: asUser(member), payload: { label: "X", color: "#111111" } });
      expect(create.statusCode).toBe(403);
      const read = await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: asUser(member) });
      expect(read.statusCode).toBe(200);
    });

    it("creating a custom status materializes the 4 defaults and appends the new one; existing tasks stay valid", async () => {
      const pid = await freshProject("Statuses materialize");
      // A task created BEFORE any editor write keeps its literal 'todo' status (zero row rewrite).
      const legacyTask = await newTask(pid);
      expect((await getTask(legacyTask)).status).toBe("todo");

      const create = await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr(), payload: { label: "Shipped", color: "#4B7A5A", isDone: true, wipLimit: 3 } });
      expect(create.statusCode).toBe(201);
      const st = create.json() as { id: string; label: string; isDone: boolean; wipLimit?: number; position: number };
      expect(st.id).toBe("shipped");
      expect(st.isDone).toBe(true);
      expect(st.wipLimit).toBe(3);
      expect(st.position).toBe(5); // appended after the 5 materialized defaults (positions 0..4)

      const statuses = await getStatuses(pid);
      expect(statuses.map((s) => s.id)).toEqual(["backlog", "todo", "in_progress", "blocked", "done", "shipped"]);
      // the legacy task is still readable/valid against the now-materialized set
      expect((await getTask(legacyTask)).status).toBe("todo");
    });

    it("ENGINE FLAG: a RENAMED is_done status drives done-coupling by flag, not by the literal id", async () => {
      const pid = await freshProject("Statuses flag");
      const create = await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr(), payload: { label: "Shipped", color: "#4B7A5A", isDone: true } });
      expect((create.json() as { id: string }).id).toBe("shipped");

      // create-time: status accepted, and because it is_done, progress couples to 100
      const t1 = await newTask(pid, { status: "shipped" });
      const at1 = await getTask(t1);
      expect(at1.status).toBe("shipped");
      expect(at1.progress).toBe(100);

      // patch-time: moving an in-flight task to the renamed done status forces progress 100
      const t2 = await newTask(pid);
      expect((await getTask(t2)).progress).toBe(0);
      const patch = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${t2}`, headers: hdr(), payload: { status: "shipped" } });
      expect(patch.statusCode).toBe(200);
      expect((await getTask(t2)).progress).toBe(100);
    });

    it("rejects an unknown status id on create and on PATCH; and a cross-project status id", async () => {
      const pid = await freshProject("Statuses validate");
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr(), payload: { label: "Review", color: "#6E5A43" } });

      const badCreate = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers: hdr(), payload: { projectId: pid, title: "bad", status: "nope" } });
      expect(badCreate.statusCode).toBe(400);

      const id = await newTask(pid);
      const badPatch = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { status: "nope" } });
      expect(badPatch.statusCode).toBe(400);

      // a status id belonging to a DIFFERENT project is rejected
      const otherPid = await freshProject("Statuses other");
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${otherPid}/statuses`, headers: hdr(), payload: { label: "Custom", color: "#6E5A43" } });
      const cross = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { status: "custom" } });
      expect(cross.statusCode).toBe(400);

      // a valid same-project custom id is accepted
      const ok = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { status: "review" } });
      expect(ok.statusCode).toBe(200);
      expect((await getTask(id)).status).toBe("review");
    });

    it("PATCH updates label/color/flags/wip and can reorder; DELETE 400 {inUse} without moveTo, reassign+delete with moveTo", async () => {
      const pid = await freshProject("Statuses delete");
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr(), payload: { label: "Review", color: "#6E5A43" } });

      const upd = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/projects/${pid}/statuses/review`, headers: hdr(), payload: { label: "In review", isBlocked: true, wipLimit: 5, position: 1 } });
      expect(upd.statusCode).toBe(200);
      const updated = upd.json() as { label: string; isBlocked: boolean; wipLimit?: number; position: number };
      expect(updated.label).toBe("In review");
      expect(updated.isBlocked).toBe(true);
      expect(updated.wipLimit).toBe(5);
      expect(updated.position).toBe(1);
      // clearing wip back to null
      const cleared = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/projects/${pid}/statuses/review`, headers: hdr(), payload: { wipLimit: null } });
      expect((cleared.json() as { wipLimit?: number }).wipLimit).toBeUndefined();

      const id = await newTask(pid);
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { status: "review" } });

      const blocked = await app.inject({ method: "DELETE", url: `/api/${tenant}/pm/projects/${pid}/statuses/review`, headers: hdr() });
      expect(blocked.statusCode).toBe(400);
      expect((blocked.json() as { inUse: number }).inUse).toBe(1);
      // not deleted while blocked
      expect((await getStatuses(pid)).some((s) => s.id === "review")).toBe(true);

      const moved = await app.inject({ method: "DELETE", url: `/api/${tenant}/pm/projects/${pid}/statuses/review?moveTo=todo`, headers: hdr() });
      expect(moved.statusCode).toBe(200);
      expect((await getTask(id)).status).toBe("todo"); // reassigned
      expect((await getStatuses(pid)).some((s) => s.id === "review")).toBe(false); // deleted
    });

    it("tenant isolation: a rival tenant's session sees only its own project's synthesized defaults, never this tenant's materialized rows", async () => {
      const pid = await freshProject("Statuses iso");
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr(), payload: { label: "Secret", color: "#000000" } });

      const rivalTenant = await createCompany("Rival Co (pm statuses)", ["agency", "pm"]);
      const rivalAdmin = await createUser("rival-status@x.test", "Rival Status Admin");
      await addMembership(rivalTenant, rivalAdmin);
      await grantRole(rivalAdmin, await createRole("manager"), "company", rivalTenant);

      // not a member of `tenant` -> denied on the real tenant's URL
      const cross = await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: asUser(rivalAdmin) });
      expect(cross.statusCode).toBe(403);

      // rival's OWN tenant URL against tenant A's project id: RLS scopes projects to rivalTenant so
      // the (foreign) project is invisible -> 404, never a leak of tenant A's status rows.
      const leak = await app.inject({ method: "GET", url: `/api/${rivalTenant}/pm/projects/${pid}/statuses`, headers: asUser(rivalAdmin) });
      expect(leak.statusCode).toBe(404);
    });
  });

  // ---------------- Recurring tasks (P2-06, pm-console-ux-design-spec §8) ----------------
  describe("recurring tasks", () => {
    const freshProject = (name: string) => createProject(tenant, name, manager);
    const newTask = async (pid: string, body: Record<string, unknown>) =>
      (await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers: hdr(), payload: { projectId: pid, title: "Recur me", ...body } }).then((r) => r.json())).id as string;
    const patch = (id: string, body: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: body });
    const getTask = async (id: string) =>
      (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as {
        id: string; title: string; status: string; progress: number; subtasks: { done: boolean }[];
        dueDate: string | null; startDate: string | null; assignee: unknown; tags: string[];
        estimateMinutes: number | null; customFields: Record<string, unknown>; priority: string;
        recurrence: { freq: string; until?: string } | null;
      };

    it("completing the final open occurrence spawns exactly ONE next task, dueDate shifted by freq", async () => {
      const pid = await freshProject("Recurring weekly");
      const id = await newTask(pid, { dueDate: "2026-07-16", recurrence: { freq: "weekly" } });

      const r = await patch(id, { status: "done" });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { spawned: { id: string; dueDate: string } | null };
      expect(body.spawned).not.toBeNull();
      expect(body.spawned!.dueDate).toBe("2026-07-23");

      const child = await getTask(body.spawned!.id);
      expect(child.title).toBe("Recur me");
      expect(child.status).toBe("todo"); // project's first non-done status
      expect(child.progress).toBe(0);
      expect(child.recurrence).toEqual({ freq: "weekly" });

      // exactly one child exists for this parent
      const all = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/tasks`, headers: hdr() })).json() as { id: string; title: string }[];
      expect(all.filter((t) => t.title === "Recur me")).toHaveLength(2); // parent + exactly one child
    });

    it("re-completing an already-done recurring task does NOT double-spawn (idempotency)", async () => {
      const pid = await freshProject("Recurring idempotent");
      const id = await newTask(pid, { dueDate: "2026-07-16", recurrence: { freq: "daily" } });

      const first = (await patch(id, { status: "done" })).json() as { spawned: { id: string } | null };
      expect(first.spawned).not.toBeNull();

      // re-PATCH the SAME completion twice more — the not-done->done edge no longer
      // fires (task.status, read under the row lock, is already the done status)
      const second = (await patch(id, { status: "done" })).json() as { spawned: { id: string } | null };
      expect(second.spawned).toBeNull();
      const third = (await patch(id, { status: "done" })).json() as { spawned: { id: string } | null };
      expect(third.spawned).toBeNull();

      const all = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/tasks`, headers: hdr() })).json() as { title: string }[];
      expect(all.filter((t) => t.title === "Recur me")).toHaveLength(2); // parent + exactly ONE child, never more
    });

    it("concurrent completions of the same recurring task spawn exactly ONE child (row-lock guard)", async () => {
      const pid = await freshProject("Recurring concurrent");
      const id = await newTask(pid, { dueDate: "2026-07-16", recurrence: { freq: "daily" } });

      const [a, b] = await Promise.all([patch(id, { status: "done" }), patch(id, { status: "done" })]);
      const spawnedIds = [a, b].map((r) => (r.json() as { spawned: { id: string } | null }).spawned).filter((s): s is { id: string } => !!s);
      expect(spawnedIds).toHaveLength(1); // only one of the two racing PATCHes spawned

      const all = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/tasks`, headers: hdr() })).json() as { title: string }[];
      expect(all.filter((t) => t.title === "Recur me")).toHaveLength(2);
    });

    it("respects `until`: no spawn once the next occurrence would land after it", async () => {
      const pid = await freshProject("Recurring until");
      const id = await newTask(pid, { dueDate: "2026-07-30", recurrence: { freq: "weekly", until: "2026-08-01" } });
      const r = (await patch(id, { status: "done" })).json() as { spawned: { id: string } | null };
      expect(r.spawned).toBeNull(); // 2026-07-30 + 7d = 2026-08-06, past the until
    });

    it("monthly recurrence clamps day-of-month on overflow (Jan 31 -> Feb 28)", async () => {
      const pid = await freshProject("Recurring monthly");
      const id = await newTask(pid, { dueDate: "2026-01-31", recurrence: { freq: "monthly" } });
      const r = (await patch(id, { status: "done" })).json() as { spawned: { id: string; dueDate: string } | null };
      expect(r.spawned?.dueDate).toBe("2026-02-28"); // 2026 is not a leap year
    });

    it("a non-recurring task's completion never spawns anything", async () => {
      const pid = await freshProject("Non-recurring");
      const id = await newTask(pid, { dueDate: "2026-07-16" });
      const r = (await patch(id, { status: "done" })).json() as { spawned: { id: string } | null };
      expect(r.spawned).toBeNull();
    });

    it("carries over assignee/tags/estimate/customFields/priority/recurrence; resets subtasks to not-done", async () => {
      // NOTE: "channel" on pm_task/tenant is already defined by the earlier "task custom
      // fields" describe block in this same file (shared `tenant`) — reuse it, don't redefine.
      const pid = await freshProject("Recurring carryover");
      const tagRes = await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/tags`, headers: hdr(), payload: { label: "Ops", color: "moss" } });
      const tagId = (tagRes.json() as { id: string }).id;

      const createRes = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers: hdr(), payload: {
        projectId: pid, title: "Recur me",
        dueDate: "2026-07-16", priority: "high", estimateMinutes: 120, recurrence: { freq: "weekly" },
        assignee: { kind: "person", refId: member, refName: "Member Mel", responsibleId: member, responsibleName: "Member Mel" },
        customFields: { channel: "email" },
      } });
      expect(createRes.statusCode).toBe(201);
      const id = (createRes.json() as { id: string }).id;
      const tagged = await patch(id, { tags: [tagId], addSubtask: "step one" });
      expect(tagged.statusCode).toBe(200);
      const before = await getTask(id);
      const beforeSubtasks = (before as unknown as { subtasks: { id: string }[] }).subtasks;
      expect(beforeSubtasks?.length).toBe(1);
      await patch(id, { toggleSubtask: beforeSubtasks[0].id }); // -> 100% -> done, spawns

      // find the spawned child via the tracker-agnostic project task list
      const all = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/tasks`, headers: hdr() })).json() as Array<{ id: string; title: string }>;
      const child = all.find((t) => t.title === "Recur me" && t.id !== id)!;
      expect(child).toBeTruthy();
      const childFull = await getTask(child.id);
      expect(childFull.priority).toBe("high");
      expect(childFull.estimateMinutes).toBe(120);
      expect(childFull.customFields.channel).toBe("email");
      expect(childFull.tags).toEqual([tagId]);
      expect((childFull.assignee as { responsibleId: string }).responsibleId).toBe(member);
      expect(childFull.recurrence).toEqual({ freq: "weekly" });
      expect(childFull.subtasks.every((s) => !s.done)).toBe(true);
    });
  });

  // ---------------- Burndown snapshots (P2-07, pm-console-ux-design-spec §4, §0 D-2) ----------------
  describe("burndown snapshots", () => {
    const freshProject = (name: string) => createProject(tenant, name, manager);
    const newTask = async (pid: string, body: Record<string, unknown> = {}) =>
      (await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers: hdr(), payload: { projectId: pid, title: "T", ...body } }).then((r) => r.json())).id as string;
    const getBurndown = (pid: string, qs = "") =>
      app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/burndown${qs}`, headers: hdr() });
    const todayStr = () => new Date().toISOString().slice(0, 10);

    it("empty series returns [] (never an error) when the range excludes today's lazily-upserted row", async () => {
      const pid = await freshProject("Burndown empty");
      const r = await getBurndown(pid, "?from=2000-01-01&to=2000-01-02");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual([]);
    });

    it("counts derive from the project's is_done FLAG (a renamed done status), not a literal status id", async () => {
      const pid = await freshProject("Burndown counts");
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr(), payload: { label: "Shipped", color: "#4B7A5A", isDone: true } });
      await newTask(pid, { status: "shipped" }); // counts as done via the flag, not the literal id
      await newTask(pid); // open
      await newTask(pid); // open

      const r = await getBurndown(pid, `?from=${todayStr()}&to=${todayStr()}`);
      expect(r.statusCode).toBe(200);
      const rows = r.json() as Array<{ date: string; open: number; done: number; avgProgress: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].open).toBe(2);
      expect(rows[0].done).toBe(1);
    });

    it("two same-day reads leave exactly ONE row (idempotent upsert-on-read)", async () => {
      const pid = await freshProject("Burndown idempotent");
      await newTask(pid);

      await getBurndown(pid);
      await getBurndown(pid); // second same-day read must not insert a second row

      const { rows } = await adminPool().query(
        `SELECT count(*)::int AS n FROM pm_progress_snapshots WHERE project_id = $1 AND snapshot_date = current_date`,
        [pid],
      );
      expect(rows[0].n).toBe(1);
    });

    it("series is ascending by date and respects from/to filters", async () => {
      const pid = await freshProject("Burndown range");
      await newTask(pid);
      // seed a past row directly (the lazy path only ever writes TODAY) to exercise ordering.
      await adminPool().query(
        `INSERT INTO pm_progress_snapshots (tenant_id, project_id, snapshot_date, open_count, done_count, avg_progress, origin_site)
         VALUES ($1, $2, current_date - interval '1 day', 3, 1, 25, 'main')`,
        [tenant, pid],
      );

      const r = await getBurndown(pid);
      const rows = r.json() as Array<{ date: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const dates = rows.map((x) => x.date);
      expect([...dates].sort()).toEqual(dates);

      const onlyToday = await getBurndown(pid, `?from=${todayStr()}&to=${todayStr()}`);
      expect((onlyToday.json() as unknown[]).length).toBe(1);
    });

    it("404s for an unknown project id; a plain member (read-gated) can still read", async () => {
      const notFound = await getBurndown("00000000-0000-0000-0000-000000000000");
      expect(notFound.statusCode).toBe(404);

      const pid = await freshProject("Burndown rbac");
      const r = await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/burndown`, headers: asUser(member) });
      expect(r.statusCode).toBe(200);
    });

    it("tenant isolation: a rival cannot read via the real tenant's URL, and a forged cross-tenant project id 404s rather than leaking", async () => {
      const pid = await freshProject("Burndown iso");
      await getBurndown(pid); // seed today's row

      const rivalTenant = await createCompany("Rival Co (pm burndown)", ["agency", "pm"]);
      const rivalAdmin = await createUser("rival-burndown@x.test", "Rival Burndown Admin");
      await addMembership(rivalTenant, rivalAdmin);
      await grantRole(rivalAdmin, await createRole("manager"), "company", rivalTenant);

      const cross = await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/burndown`, headers: asUser(rivalAdmin) });
      expect(cross.statusCode).toBe(403);

      const forged = await app.inject({ method: "GET", url: `/api/${rivalTenant}/pm/projects/${pid}/burndown`, headers: asUser(rivalAdmin) });
      expect(forged.statusCode).toBe(404);
    });
  });

  // ---------------- Flow (P3-05) ----------------
  describe("flow (per-status snapshot counts)", () => {
    const freshProject = (name: string) => createProject(tenant, name, manager);
    const newTask = async (pid: string, body: Record<string, unknown> = {}) =>
      (await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers: hdr(), payload: { projectId: pid, title: "T", ...body } }).then((r) => r.json())).id as string;
    const getFlow = (pid: string, qs = "") =>
      app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/flow${qs}`, headers: hdr() });
    const getBurndown = (pid: string, qs = "") =>
      app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/burndown${qs}`, headers: hdr() });
    const todayStr = () => new Date().toISOString().slice(0, 10);

    it("counts by the project's OWN (custom) status ids, not legacy literals, and updates after a task moves", async () => {
      const pid = await freshProject("Flow custom statuses");
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr(), payload: { label: "Backlog", color: "#111111", isDone: false } });
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr(), payload: { label: "Shipped", color: "#4B7A5A", isDone: true } });
      const t1 = await newTask(pid, { status: "backlog" });
      await newTask(pid, { status: "backlog" });
      await newTask(pid); // default "todo"

      let r = await getFlow(pid, `?from=${todayStr()}&to=${todayStr()}`);
      expect(r.statusCode).toBe(200);
      let rows = r.json() as Array<{ date: string; counts: Record<string, number> }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].counts).toEqual({ backlog: 2, todo: 1 });

      // move a task -> the lazy upsert-on-read must reflect the new distribution, not the old one
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${t1}`, headers: hdr(), payload: { status: "shipped" } });
      r = await getFlow(pid, `?from=${todayStr()}&to=${todayStr()}`);
      rows = r.json() as Array<{ date: string; counts: Record<string, number> }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].counts).toEqual({ backlog: 1, todo: 1, shipped: 1 });
    });

    it("empty series returns [] (never an error) when the range excludes today's lazily-upserted row", async () => {
      const pid = await freshProject("Flow empty");
      const r = await getFlow(pid, "?from=2000-01-01&to=2000-01-02");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual([]);
    });

    it("ascending by date and respects from/to filters, mirroring burndown's validation", async () => {
      const pid = await freshProject("Flow range");
      await newTask(pid);
      await adminPool().query(
        `INSERT INTO pm_progress_snapshots (tenant_id, project_id, snapshot_date, open_count, done_count, avg_progress, status_counts, origin_site)
         VALUES ($1, $2, current_date - interval '1 day', 1, 0, 0, '{"todo":1}'::jsonb, 'main')`,
        [tenant, pid],
      );

      const r = await getFlow(pid);
      const rows = r.json() as Array<{ date: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const dates = rows.map((x) => x.date);
      expect([...dates].sort()).toEqual(dates);

      const badFrom = await getFlow(pid, "?from=not-a-date");
      expect(badFrom.statusCode).toBe(400);
      const badTo = await getFlow(pid, "?to=07-24-2026");
      expect(badTo.statusCode).toBe(400);

      const notFound = await getFlow("00000000-0000-0000-0000-000000000000");
      expect(notFound.statusCode).toBe(404);
    });

    it("regression: burndown's response shape (open/done/avgProgress) is unchanged by the status_counts addition", async () => {
      const pid = await freshProject("Flow burndown regression");
      await newTask(pid);
      await newTask(pid, { status: "done" });

      const r = await getBurndown(pid, `?from=${todayStr()}&to=${todayStr()}`);
      expect(r.statusCode).toBe(200);
      const rows = r.json() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(["avgProgress", "date", "done", "open"]);
      expect(rows[0].open).toBe(1);
      expect(rows[0].done).toBe(1);
    });
  });

  // ---------------- createTask subtasks + tags (P3-01) ----------------
  describe("createTask subtasks + tags", () => {
    it("accepts subtasks: string[] -> persisted as {id,title,done:false}", async () => {
      const r = await createTask({ title: "With subtasks", subtasks: ["Step one", "Step two"] });
      expect(r.statusCode).toBe(201);
      const id = (r.json() as { id: string }).id;
      const task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { subtasks: { id: string; title: string; done: boolean }[] };
      expect(task.subtasks).toHaveLength(2);
      expect(task.subtasks.map((s) => s.title)).toEqual(["Step one", "Step two"]);
      expect(task.subtasks.every((s) => s.done === false)).toBe(true);
      expect(new Set(task.subtasks.map((s) => s.id)).size).toBe(2); // distinct generated ids
    });

    it("rejects a non-string-array subtasks payload", async () => {
      const r = await createTask({ title: "Bad subtasks", subtasks: [1, 2] });
      expect(r.statusCode).toBe(400);
    });

    it("accepts tags: string[] from this task's project registry and persists them", async () => {
      const tagRes = await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${projectId}/tags`, headers: hdr(), payload: { label: "CreateTag", color: "dust" } });
      const tagId = (tagRes.json() as { id: string }).id;
      const r = await createTask({ title: "With tags", tags: [tagId] });
      expect(r.statusCode).toBe(201);
      const id = (r.json() as { id: string }).id;
      const task = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as { tags: string[] };
      expect(task.tags).toEqual([tagId]);
    });

    it("rejects a tag id from a DIFFERENT project on create (400)", async () => {
      const otherProjectId = await createProject(tenant, "Other Project (create-tags)", manager);
      const foreignTagRes = await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${otherProjectId}/tags`, headers: hdr(), payload: { label: "Foreign", color: "olive" } });
      const foreignTagId = (foreignTagRes.json() as { id: string }).id;
      const r = await createTask({ title: "Cross-project tag", tags: [foreignTagId] });
      expect(r.statusCode).toBe(400);
    });

    it("rejects a junk (non-uuid) tag id on create", async () => {
      const r = await createTask({ title: "Junk tag", tags: ["not-a-uuid"] });
      expect(r.statusCode).toBe(400);
    });
  });

  // ---------------- Task duplicate (P3-01) ----------------
  describe("task duplicate", () => {
    const freshProject = (name: string) => createProject(tenant, name, manager);

    it("duplicates title/description/priority/tags/subtasks(reset)/estimate/milestone/assignee(notified)/dates/recurrence; resets status+progress; drops dependsOn", async () => {
      const pid = await freshProject("Duplicate basic");
      const tagRes = await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/tags`, headers: hdr(), payload: { label: "DupTag", color: "clay" } });
      const tagId = (tagRes.json() as { id: string }).id;
      const msRes = await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/milestones`, headers: hdr(), payload: { name: "Dup MS", dueDate: "2026-09-01" } });
      const milestoneId = (msRes.json() as { id: string }).id;

      const createRes = await app.inject({
        method: "POST", url: `/api/${tenant}/pm/tasks`, headers: hdr(),
        payload: {
          projectId: pid, title: "Original", description: "desc here", priority: "high",
          estimateMinutes: 90, dueDate: "2026-08-01", startDate: "2026-07-25", milestoneId,
          recurrence: { freq: "weekly" },
          assignee: { kind: "person", refId: member, refName: "Member Mel", responsibleId: member, responsibleName: "Member Mel" },
        },
      });
      const sourceId = (createRes.json() as { id: string }).id;
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${sourceId}`, headers: hdr(), payload: { tags: [tagId], addSubtask: "sub one" } });
      const withSubtask = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${sourceId}`, headers: hdr() })).json() as { subtasks: { id: string }[] };
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${sourceId}`, headers: hdr(), payload: { toggleSubtask: withSubtask.subtasks[0].id } });

      // add a second task and a dependency, to prove dependsOn is dropped on the copy
      const otherId = (await createTask({ title: "Blocker", projectId: pid }).then((r) => r.json())).id as string;
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${sourceId}`, headers: hdr(), payload: { addDependency: otherId } });

      const dup = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${sourceId}/duplicate`, headers: hdr() });
      expect(dup.statusCode).toBe(201);
      const dupId = (dup.json() as { id: string }).id;

      const copy = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${dupId}`, headers: hdr() })).json() as {
        title: string; description: string; priority: string; tags: string[]; subtasks: { title: string; done: boolean }[];
        estimateMinutes: number | null; milestoneId: string | null; assignee: { responsibleId: string } | null;
        dueDate: string | null; startDate: string | null; recurrence: { freq: string } | null;
        status: string; progress: number; dependsOn: string[];
      };
      expect(copy.title).toBe("Original (copy)");
      expect(copy.description).toBe("desc here");
      expect(copy.priority).toBe("high");
      expect(copy.tags).toEqual([tagId]);
      expect(copy.subtasks).toHaveLength(1);
      expect(copy.subtasks[0].title).toBe("sub one");
      expect(copy.subtasks[0].done).toBe(false); // reset even though the source's was toggled done
      expect(copy.estimateMinutes).toBe(90);
      expect(copy.milestoneId).toBe(milestoneId);
      expect(copy.assignee?.responsibleId).toBe(member);
      expect(copy.dueDate).toBe("2026-08-01");
      expect(copy.startDate).toBe("2026-07-25");
      expect(copy.recurrence).toEqual({ freq: "weekly" });
      expect(copy.progress).toBe(0);
      expect(copy.dependsOn).toEqual([]);

      // status reset to the project's first-by-position NON-done status via effectiveStatuses flags
      const statuses = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr() })).json() as Array<{ id: string; position: number; isDone: boolean }>;
      const firstNonDone = [...statuses].sort((a, z) => a.position - z.position).find((s) => !s.isDone);
      expect(copy.status).toBe(firstNonDone!.id);

      // the assignee got a fresh assignment notification pointing at the COPY, not the source
      const notifs = (await app.inject({ method: "GET", url: `/api/${tenant}/notifications`, headers: asUser(member) })).json() as Array<{ payload: { href?: string } }>;
      expect(notifs.some((n) => n.payload?.href === `/tasks/${dupId}`)).toBe(true);
    });

    it("resets status to the first NON-done status by FLAG even when the literal 'todo' status is itself marked done — never a literal-id fallback", async () => {
      const pid = await freshProject("Duplicate custom status");
      // Materialize the 4 defaults, then flip the literal "todo" status's is_done flag to true.
      // If the reset logic ever regressed to hardcoding the string "todo", this project would
      // wrongly reset a duplicate into a DONE column; the real, flag-driven logic must instead
      // skip it and land on "in_progress" (the next by position that is NOT done).
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr(), payload: { label: "Trigger materialize", color: "#111111" } });
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/projects/${pid}/statuses/todo`, headers: hdr(), payload: { isDone: true } });

      const createRes = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers: hdr(), payload: { projectId: pid, title: "Custom status source" } });
      const sourceId = (createRes.json() as { id: string }).id;
      // P4-B8b: the source is now placed into the done-flagged "todo" EXPLICITLY. It used to arrive
      // there by accident, because create defaulted to "first status by position". That default is
      // now `readyStatus`, which skips a done-flagged status on purpose — a new task must never be
      // born complete. The explicit PATCH keeps this test about DUPLICATION, which is its subject.
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${sourceId}`, headers: hdr(), payload: { status: "todo" } });
      // sitting in a done-flagged status -> progress is coupled to 100
      expect((await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${sourceId}`, headers: hdr() })).json()).toMatchObject({ status: "todo", progress: 100 });

      const dup = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${sourceId}/duplicate`, headers: hdr() });
      expect(dup.statusCode).toBe(201);
      const dupId = (dup.json() as { id: string }).id;
      const copy = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${dupId}`, headers: hdr() })).json() as { status: string; progress: number };
      // P4-B8b: still the first-by-position NON-done status via the FLAG — which is now `backlog`,
      // since the ladder put it ahead of the (here done-flagged) `todo`. The assertion that matters
      // is unchanged: never the literal "todo" when that status is marked done.
      expect(copy.status).toBe("backlog");
      expect(copy.status).not.toBe("todo");
      expect(copy.progress).toBe(0);
    });

    // Companion to the above, and a bug this suite caught during P4-B8b: `readyStatus` PREFERS the
    // canonical `todo` id, so it has to re-check the flags. A project that marks `todo` done would
    // otherwise have every fired recurrence and every new task land in a DONE column.
    it("readyStatus never lands new work on a 'todo' status the project has flagged done", async () => {
      const pid = await freshProject("Ready status flag guard");
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr(), payload: { label: "Trigger materialize", color: "#111111" } });
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/projects/${pid}/statuses/todo`, headers: hdr(), payload: { isDone: true } });

      // A recurring task, completed -> spawns the next occurrence, which must be actionable.
      const created = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers: hdr(), payload: { projectId: pid, title: "Weekly thing", dueDate: "2026-08-10", recurrence: { freq: "weekly" } } });
      const srcId = (created.json() as { id: string }).id;
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${srcId}`, headers: hdr(), payload: { status: "done" } });

      const all = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/tasks`, headers: hdr() })).json() as Array<{ id: string; status: string }>;
      const statuses = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/statuses`, headers: hdr() })).json() as Array<{ id: string; isDone: boolean; isBlocked: boolean }>;
      const doneIds = new Set(statuses.filter((x) => x.isDone).map((x) => x.id));
      const blockedIds = new Set(statuses.filter((x) => x.isBlocked).map((x) => x.id));
      const child = all.find((t) => t.id !== srcId);
      expect(child).toBeDefined();
      expect(doneIds.has(child!.status)).toBe(false);
      expect(blockedIds.has(child!.status)).toBe(false);
    });

    it("a plain member cannot duplicate a task (create-gated)", async () => {
      const id = (await createTask({ title: "Guard me" }).then((r) => r.json())).id as string;
      const r = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/duplicate`, headers: asUser(member) });
      expect(r.statusCode).toBe(403);
    });

    it("404s for an unknown source task id", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/00000000-0000-0000-0000-000000000000/duplicate`, headers: hdr() });
      expect(r.statusCode).toBe(404);
    });
  });

  // ---------------- Templates (P3-01) ----------------
  describe("pm templates", () => {
    const createTemplate = (body: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/api/${tenant}/pm/templates`, headers: hdr(), payload: body });

    it("creates a task-kind template with a full payload and round-trips it", async () => {
      const r = await createTemplate({
        kind: "task", name: "Bug intake",
        payload: { title: "Investigate {{bug}}", description: "triage", priority: "high", estimateMinutes: 30, subtasks: ["Repro", "Root cause"], tagLabels: ["bug"] },
      });
      expect(r.statusCode).toBe(201);
      const { id } = r.json() as { id: string };

      const list = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/templates?kind=task`, headers: hdr() })).json() as Array<{ id: string; kind: string; name: string; payload: Record<string, unknown> }>;
      const found = list.find((t) => t.id === id)!;
      expect(found.kind).toBe("task");
      expect(found.name).toBe("Bug intake");
      expect(found.payload.title).toBe("Investigate {{bug}}");
      expect(found.payload.subtasks).toEqual(["Repro", "Root cause"]);
      expect(found.payload.tagLabels).toEqual(["bug"]);
    });

    it("creates a doc-kind template with {title, body}", async () => {
      const r = await createTemplate({ kind: "doc", name: "Weekly report", payload: { title: "Weekly Status", body: "## Status\n" } });
      expect(r.statusCode).toBe(201);
      const list = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/templates?kind=doc`, headers: hdr() })).json() as Array<{ kind: string; payload: Record<string, unknown> }>;
      expect(list.some((t) => t.kind === "doc" && t.payload.body === "## Status\n")).toBe(true);
    });

    it("rejects an unknown kind on create", async () => {
      const r = await createTemplate({ kind: "spreadsheet", name: "nope", payload: { title: "x" } });
      expect(r.statusCode).toBe(400);
    });

    it("rejects an invalid payload per kind (missing title; doc missing body; bad priority)", async () => {
      expect((await createTemplate({ kind: "task", name: "no title", payload: {} })).statusCode).toBe(400);
      expect((await createTemplate({ kind: "doc", name: "no body", payload: { title: "x" } })).statusCode).toBe(400);
      expect((await createTemplate({ kind: "task", name: "bad prio", payload: { title: "x", priority: "critical" } })).statusCode).toBe(400);
    });

    it("rejects an invalid kind query param on GET (list)", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${tenant}/pm/templates?kind=nonsense`, headers: hdr() });
      expect(r.statusCode).toBe(400);
    });

    it("PATCH updates name and/or payload (validated against the EXISTING immutable kind)", async () => {
      const created = await createTemplate({ kind: "task", name: "Editable", payload: { title: "orig" } });
      const id = (created.json() as { id: string }).id;

      const renamed = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/templates/${id}`, headers: hdr(), payload: { name: "Renamed" } });
      expect(renamed.statusCode).toBe(200);
      expect((renamed.json() as { name: string }).name).toBe("Renamed");

      const repayload = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/templates/${id}`, headers: hdr(), payload: { payload: { title: "new title", priority: "low" } } });
      expect(repayload.statusCode).toBe(200);
      const body = repayload.json() as { payload: Record<string, unknown> };
      expect(body.payload.title).toBe("new title");
      expect(body.payload.priority).toBe("low");

      // an invalid payload for the (unchanged, immutable) task kind still 400s on PATCH
      const bad = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/templates/${id}`, headers: hdr(), payload: { payload: { title: "x", priority: "bogus" } } });
      expect(bad.statusCode).toBe(400);
    });

    it("DELETE soft-deletes; deleted templates drop out of the list", async () => {
      const created = await createTemplate({ kind: "doc", name: "To delete", payload: { title: "x", body: "y" } });
      const id = (created.json() as { id: string }).id;
      const del = await app.inject({ method: "DELETE", url: `/api/${tenant}/pm/templates/${id}`, headers: hdr() });
      expect(del.statusCode).toBe(200);
      const list = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/templates?kind=doc`, headers: hdr() })).json() as Array<{ id: string }>;
      expect(list.some((t) => t.id === id)).toBe(false);
    });

    it("404s on PATCH/DELETE for an unknown template id", async () => {
      const badId = "00000000-0000-0000-0000-000000000000";
      expect((await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/templates/${badId}`, headers: hdr(), payload: { name: "x" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/${tenant}/pm/templates/${badId}` , headers: hdr() })).statusCode).toBe(404);
    });

    it("a plain member cannot create a template (manage-gated); GET (list) is also manage-gated (403 for member)", async () => {
      const createAsMember = await app.inject({ method: "POST", url: `/api/${tenant}/pm/templates`, headers: asUser(member), payload: { kind: "doc", name: "nope", payload: { title: "x", body: "y" } } });
      expect(createAsMember.statusCode).toBe(403);
      const listAsMember = await app.inject({ method: "GET", url: `/api/${tenant}/pm/templates`, headers: asUser(member) });
      expect(listAsMember.statusCode).toBe(403);
    });

    it("tenant isolation: a rival tenant's session cannot see this tenant's templates (RLS empty-set)", async () => {
      const created = await createTemplate({ kind: "doc", name: "Secret", payload: { title: "x", body: "y" } });
      const templateId = (created.json() as { id: string }).id;

      const rivalTenant = await createCompany("Rival Co (pm templates)", ["agency", "pm"]);
      const rivalAdmin = await createUser("rival-templates@x.test", "Rival Templates Admin");
      await addMembership(rivalTenant, rivalAdmin);
      await grantRole(rivalAdmin, await createRole("manager"), "company", rivalTenant);

      const cross = await app.inject({ method: "GET", url: `/api/${tenant}/pm/templates`, headers: asUser(rivalAdmin) });
      expect(cross.statusCode).toBe(403);

      const rivalList = (await app.inject({ method: "GET", url: `/api/${rivalTenant}/pm/templates`, headers: asUser(rivalAdmin) })).json() as Array<{ id: string }>;
      expect(rivalList.some((t) => t.id === templateId)).toBe(false);
    });
  });

  // ---------------- Project duplicate (P3-02) ----------------
  describe("project duplicate", () => {
    const freshProject = (name: string) => createProject(tenant, name, manager);
    const post = (url: string, payload: Record<string, unknown>, headers = hdr()) =>
      app.inject({ method: "POST", url, headers, payload });
    const get = (url: string, headers = hdr()) => app.inject({ method: "GET", url, headers });

    it("deep-copies statuses/tags/milestones/docs/tasks with fully remapped ids; resets status/progress/assignee/owner; NO source id survives; source untouched", async () => {
      const pid = await freshProject("Dup source");

      // custom statuses: materialize the 4 defaults + append one
      await post(`/api/${tenant}/pm/projects/${pid}/statuses`, { label: "Review", color: "#6E5A43" });

      // 2 tags
      const tagA = (await post(`/api/${tenant}/pm/projects/${pid}/tags`, { label: "Alpha", color: "clay" }).then((r) => r.json())).id as string;
      const tagB = (await post(`/api/${tenant}/pm/projects/${pid}/tags`, { label: "Beta", color: "moss" }).then((r) => r.json())).id as string;

      // a milestone
      const ms = (await post(`/api/${tenant}/pm/projects/${pid}/milestones`, { name: "M1", dueDate: "2026-09-01" }).then((r) => r.json())).id as string;

      // a doc
      await post(`/api/${tenant}/pm/projects/${pid}/docs`, { title: "Spec", body: "content" });

      // 3 tasks: a blocker, a dependent (dependsOn blocker + tagged tagA + on milestone), an assigned one
      const mkTask = (body: Record<string, unknown>) => post(`/api/${tenant}/pm/tasks`, { projectId: pid, ...body }).then((r) => r.json());
      const blockerId = (await mkTask({ title: "Blocker" })).id as string;
      const dependentId = (await mkTask({ title: "Dependent", milestoneId: ms })).id as string;
      const assignedId = (await mkTask({ title: "Assigned", assignee: { kind: "person", refId: member, refName: "Member Mel", responsibleId: member, responsibleName: "Member Mel" } })).id as string;

      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${dependentId}`, headers: hdr(), payload: { addDependency: blockerId, tags: [tagA] } });
      // blocker gets a subtask + a time log — neither must carry to the copy
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${blockerId}`, headers: hdr(), payload: { addSubtask: "sub one" } });
      await post(`/api/${tenant}/pm/tasks/${blockerId}/time`, { minutes: 30 });
      const srcBlocker = (await get(`/api/${tenant}/pm/tasks/${blockerId}`)).json() as { subtasks: { id: string }[] };
      const srcSubtaskId = srcBlocker.subtasks[0].id;

      // project owner + due date — must NOT copy
      await app.inject({
        method: "PATCH", url: `/api/${tenant}/pm/projects/${pid}`, headers: hdr(),
        payload: { owner: { kind: "person", refId: manager, refName: "Manager Mo", responsibleId: manager, responsibleName: "Manager Mo" }, dueDate: "2026-10-01" },
      });

      // ---- duplicate ----
      const dup = await post(`/api/${tenant}/pm/projects/${pid}/duplicate`, { name: "Dup copy" });
      expect(dup.statusCode).toBe(201);
      const newPid = (dup.json() as { id: string }).id;
      expect(newPid).not.toBe(pid);

      // ---- project row: name from input, status active, no owner, no due date ----
      const proj = (await get(`/api/${tenant}/pm/projects/${newPid}`)).json() as { name: string; status: string; owner: unknown; dueDate: string | null };
      expect(proj.name).toBe("Dup copy");
      expect(proj.status).toBe("active");
      expect(proj.owner).toBeNull();
      expect(proj.dueDate).toBeNull();

      // ---- statuses: equal-count, VERBATIM ids (per-project slugs reused) ----
      const srcStatuses = (await get(`/api/${tenant}/pm/projects/${pid}/statuses`)).json() as Array<{ id: string; position: number; isDone: boolean }>;
      const newStatuses = (await get(`/api/${tenant}/pm/projects/${newPid}/statuses`)).json() as Array<{ id: string; position: number; isDone: boolean }>;
      expect(newStatuses.map((x) => x.id)).toEqual(srcStatuses.map((x) => x.id));
      const firstNonDone = [...newStatuses].sort((a, z) => a.position - z.position).find((x) => !x.isDone)!;

      // ---- tags: equal count, FRESH ids ----
      const newTags = (await get(`/api/${tenant}/pm/projects/${newPid}/tags`)).json() as Array<{ id: string; label: string }>;
      expect(newTags).toHaveLength(2);
      expect(newTags.some((t) => t.id === tagA || t.id === tagB)).toBe(false);
      const newTagAlpha = newTags.find((t) => t.label === "Alpha")!;

      // ---- milestones: equal count, FRESH ids, status reset to open ----
      const newMs = (await get(`/api/${tenant}/pm/projects/${newPid}/milestones`)).json() as Array<{ id: string; name: string; status: string; dueDate: string | null }>;
      expect(newMs).toHaveLength(1);
      expect(newMs[0].id).not.toBe(ms);
      expect(newMs[0].status).toBe("open");
      expect(newMs[0].dueDate).toBe("2026-09-01");
      const newMsId = newMs[0].id;

      // ---- docs: equal count, author = the duplicating user ----
      const newDocs = (await get(`/api/${tenant}/pm/projects/${newPid}/docs`)).json() as Array<{ title: string; body: string; author: string }>;
      expect(newDocs).toHaveLength(1);
      expect(newDocs[0].title).toBe("Spec");
      expect(newDocs[0].author).toBe("Manager Mo");

      // ---- tasks: equal count; every one reset to first-non-done, progress 0, assignee null ----
      const newTasks = (await get(`/api/${tenant}/pm/projects/${newPid}/tasks`)).json() as Array<{
        id: string; title: string; status: string; progress: number; assignee: unknown; tags: string[];
        milestoneId: string | null; dependsOn: string[]; subtasks: { id: string; done: boolean }[]; loggedMinutes: number;
      }>;
      expect(newTasks).toHaveLength(3);
      for (const t of newTasks) {
        expect(t.status).toBe(firstNonDone.id);
        expect(t.progress).toBe(0);
        expect(t.assignee).toBeNull(); // assignee cleared even for the source's assigned task
      }
      const newBlocker = newTasks.find((t) => t.title === "Blocker")!;
      const newDependent = newTasks.find((t) => t.title === "Dependent")!;

      // ---- remaps land on NEW ids ----
      expect(newDependent.dependsOn).toEqual([newBlocker.id]); // task map: points at the COPIED blocker
      expect(newDependent.tags).toEqual([newTagAlpha.id]);     // tag map: resolves in the NEW registry
      expect(newDependent.milestoneId).toBe(newMsId);          // milestone map

      // ---- subtasks reset; comments/time dropped ----
      expect(newBlocker.subtasks).toHaveLength(1);
      expect(newBlocker.subtasks[0].done).toBe(false);
      expect(newBlocker.subtasks[0].id).not.toBe(srcSubtaskId);
      expect(newBlocker.loggedMinutes).toBe(0);
      const newBlockerComments = (await get(`/api/${tenant}/comments?entityType=task&entityId=${newBlocker.id}`)).json() as unknown[];
      expect(newBlockerComments).toHaveLength(0);

      // ---- HARD INVARIANT: no source-project id appears ANYWHERE in the copy ----
      const forbidden = new Set([pid, tagA, tagB, ms, blockerId, dependentId, assignedId, srcSubtaskId]);
      for (const t of newTasks) {
        expect(forbidden.has(t.id)).toBe(false);
        for (const d of t.dependsOn) expect(forbidden.has(d)).toBe(false);
        for (const g of t.tags) expect(forbidden.has(g)).toBe(false);
        if (t.milestoneId) expect(forbidden.has(t.milestoneId)).toBe(false);
        for (const st of t.subtasks) expect(forbidden.has(st.id)).toBe(false);
      }
      expect(newTags.every((t) => !forbidden.has(t.id))).toBe(true);
      expect(forbidden.has(newMsId)).toBe(false);

      // ---- SOURCE project untouched ----
      const srcProj = (await get(`/api/${tenant}/pm/projects/${pid}`)).json() as { owner: { responsibleId: string } | null; dueDate: string | null; taskCount: number };
      expect(srcProj.owner?.responsibleId).toBe(manager);
      expect(srcProj.dueDate).toBe("2026-10-01");
      expect(srcProj.taskCount).toBe(3);
      const srcDependent = (await get(`/api/${tenant}/pm/tasks/${dependentId}`)).json() as { dependsOn: string[]; tags: string[] };
      expect(srcDependent.dependsOn).toEqual([blockerId]); // still references the ORIGINAL blocker
      expect(srcDependent.tags).toEqual([tagA]);
      const srcBlockerAfter = (await get(`/api/${tenant}/pm/tasks/${blockerId}`)).json() as { loggedMinutes: number };
      expect(srcBlockerAfter.loggedMinutes).toBe(30);
    });

    it("duplicating a default-status (unmaterialized) project boards correctly on synthesized defaults", async () => {
      const pid = await freshProject("Dup defaults");
      await post(`/api/${tenant}/pm/tasks`, { projectId: pid, title: "Only task" });

      const dup = await post(`/api/${tenant}/pm/projects/${pid}/duplicate`, { name: "Dup defaults copy" });
      expect(dup.statusCode).toBe(201);
      const newPid = (dup.json() as { id: string }).id;

      // clone reads the same 5 synthesized defaults (nothing was materialized to copy)
      const statuses = (await get(`/api/${tenant}/pm/projects/${newPid}/statuses`)).json() as Array<{ id: string }>;
      expect(statuses.map((s) => s.id)).toEqual(["backlog", "todo", "in_progress", "blocked", "done"]);

      const tasks = (await get(`/api/${tenant}/pm/projects/${newPid}/tasks`)).json() as Array<{ title: string; status: string }>;
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe("backlog"); // INTAKE status: a cloned project's tasks are uncommitted
    });

    it("requires a name", async () => {
      const pid = await freshProject("Dup name-required");
      const r = await post(`/api/${tenant}/pm/projects/${pid}/duplicate`, {});
      expect(r.statusCode).toBe(400);
    });

    it("a plain member cannot duplicate a project (manage-gated)", async () => {
      const pid = await freshProject("Dup rbac");
      const r = await post(`/api/${tenant}/pm/projects/${pid}/duplicate`, { name: "nope" }, asUser(member));
      expect(r.statusCode).toBe(403);
    });

    it("404s for an unknown source project id", async () => {
      const r = await post(`/api/${tenant}/pm/projects/00000000-0000-0000-0000-000000000000/duplicate`, { name: "x" });
      expect(r.statusCode).toBe(404);
    });

    it("cross-tenant RLS: a rival cannot duplicate this tenant's project (forged id 404s, no copy created)", async () => {
      const pid = await freshProject("Dup iso");
      await post(`/api/${tenant}/pm/tasks`, { projectId: pid, title: "Secret task" });

      const rivalTenant = await createCompany("Rival Co (pm dup)", ["agency", "pm"]);
      const rivalAdmin = await createUser("rival-dup@x.test", "Rival Dup Admin");
      await addMembership(rivalTenant, rivalAdmin);
      await grantRole(rivalAdmin, await createRole("manager"), "company", rivalTenant);

      // not a member of `tenant` -> denied on the real tenant's URL
      const cross = await post(`/api/${tenant}/pm/projects/${pid}/duplicate`, { name: "steal" }, asUser(rivalAdmin));
      expect(cross.statusCode).toBe(403);

      // rival's OWN tenant URL against tenant A's project id -> RLS hides it -> 404, never a cross-write
      const forged = await post(`/api/${rivalTenant}/pm/projects/${pid}/duplicate`, { name: "steal" }, asUser(rivalAdmin));
      expect(forged.statusCode).toBe(404);
    });
  });

  // ---------------- Followers (P3-08) ----------------
  describe("task followers + status-change fan-out (P3-08)", () => {
    it("follow adds the follower and appears in listFollowers; unfollow removes them; follow is idempotent", async () => {
      const id = (await createTask({ title: "Follow me" }).then((r) => r.json())).id as string;

      const follow = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/follow`, headers: asUser(member) });
      expect(follow.statusCode).toBe(200);
      const followAgain = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/follow`, headers: asUser(member) });
      expect(followAgain.statusCode).toBe(200); // idempotent — no PK conflict error

      const list = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}/followers`, headers: hdr() })).json() as Array<{ id: string; name: string }>;
      expect(list.filter((f) => f.id === member).length).toBe(1);

      const unfollow = await app.inject({ method: "DELETE", url: `/api/${tenant}/pm/tasks/${id}/follow`, headers: asUser(member) });
      expect(unfollow.statusCode).toBe(200);
      const after = (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}/followers`, headers: hdr() })).json() as Array<{ id: string }>;
      expect(after.some((f) => f.id === member)).toBe(false);
    });

    it("follow/unfollow/listFollowers 404 for an unknown task id", async () => {
      const bogus = "00000000-0000-0000-0000-000000000000";
      expect((await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${bogus}/follow`, headers: asUser(member) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${bogus}/followers`, headers: hdr() })).statusCode).toBe(404);
    });

    it("a status change notifies each follower exactly once, with the task href in the payload", async () => {
      const id = (await createTask({ title: "Status fan-out" }).then((r) => r.json())).id as string;
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/follow`, headers: asUser(member) });

      const patch = await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { status: "in_progress" } });
      expect(patch.statusCode).toBe(200);

      const notifs = (await app.inject({ method: "GET", url: `/api/${tenant}/notifications?unread=true`, headers: asUser(member) })).json() as Array<{ type: string; payload: { href?: string; entityId?: string } }>;
      const taskUpdates = notifs.filter((n) => n.type === "task_update" && n.payload?.entityId === id);
      expect(taskUpdates.length).toBe(1);
      expect(taskUpdates[0].payload.href).toBe(`/tasks/${id}`);

      // re-patching to the SAME status a second time does not change status -> no second notification
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { status: "in_progress" } });
      const notifsAfter = (await app.inject({ method: "GET", url: `/api/${tenant}/notifications?unread=true`, headers: asUser(member) })).json() as Array<{ type: string; payload: { entityId?: string } }>;
      expect(notifsAfter.filter((n) => n.type === "task_update" && n.payload?.entityId === id).length).toBe(1);
    });

    it("unfollow stops delivery of future status-change notifications", async () => {
      const id = (await createTask({ title: "Unfollow stops delivery" }).then((r) => r.json())).id as string;
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/follow`, headers: asUser(member) });
      await app.inject({ method: "DELETE", url: `/api/${tenant}/pm/tasks/${id}/follow`, headers: asUser(member) });

      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { status: "in_progress" } });
      const notifs = (await app.inject({ method: "GET", url: `/api/${tenant}/notifications?unread=true`, headers: asUser(member) })).json() as Array<{ payload: { entityId?: string } }>;
      expect(notifs.some((n) => n.payload?.entityId === id)).toBe(false);
    });

    it("a follower who is ALSO the newly-reassigned responsible gets exactly ONE notification, not two", async () => {
      const id = (await createTask({ title: "Overlap fan-out" }).then((r) => r.json())).id as string;
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/follow`, headers: asUser(member) });

      const patch = await app.inject({
        method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(),
        payload: {
          status: "in_progress",
          assignee: { kind: "person", refId: member, refName: "Member Mel", responsibleId: member, responsibleName: "Member Mel" },
        },
      });
      expect(patch.statusCode).toBe(200);

      const notifs = (await app.inject({ method: "GET", url: `/api/${tenant}/notifications?unread=true`, headers: asUser(member) })).json() as Array<{ type: string; payload: { entityId?: string } }>;
      const aboutThisTask = notifs.filter((n) => n.payload?.entityId === id);
      expect(aboutThisTask.length).toBe(1); // NOT two (assignment + task_update collapsed to one)
      expect(aboutThisTask[0].type).toBe("assignment");
    });

    it("the actor never self-notifies from their own status change, even when they follow the task", async () => {
      const id = (await createTask({ title: "Self edit, self follow" }).then((r) => r.json())).id as string;
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/follow`, headers: hdr() }); // manager follows their own task
      await app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr(), payload: { status: "in_progress" } });
      const notifs = (await app.inject({ method: "GET", url: `/api/${tenant}/notifications?unread=true`, headers: hdr() })).json() as Array<{ payload: { entityId?: string } }>;
      expect(notifs.some((n) => n.payload?.entityId === id)).toBe(false);
    });

    it("tenant isolation: a rival tenant's session cannot follow/read followers on this tenant's task (RLS empty-set, forged id 404s)", async () => {
      const id = (await createTask({ title: "Isolation task" }).then((r) => r.json())).id as string;
      await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/follow`, headers: asUser(member) });

      const rivalTenant = await createCompany("Rival Co (pm followers)", ["agency", "pm"]);
      const rivalAdmin = await createUser("rival-followers@x.test", "Rival Followers Admin");
      await addMembership(rivalTenant, rivalAdmin);
      await grantRole(rivalAdmin, await createRole("manager"), "company", rivalTenant);

      // not a member of `tenant` -> denied outright on the real tenant's URL
      const cross = await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}/followers`, headers: asUser(rivalAdmin) });
      expect(cross.statusCode).toBe(403);

      // rival's OWN tenant URL against tenant A's task id -> RLS scopes pm_tasks (and
      // pm_task_followers) to rivalTenant, so the task is invisible -> 404, never a leak.
      const forgedRead = await app.inject({ method: "GET", url: `/api/${rivalTenant}/pm/tasks/${id}/followers`, headers: asUser(rivalAdmin) });
      expect(forgedRead.statusCode).toBe(404);

      const forgedFollow = await app.inject({ method: "POST", url: `/api/${rivalTenant}/pm/tasks/${id}/follow`, headers: asUser(rivalAdmin) });
      expect(forgedFollow.statusCode).toBe(404);
    });
  });

  // ---------------- Doc versions (P3-10) ----------------
  describe("doc versions", () => {
    let manager2: string; // a SECOND manage-capable user, so author-attribution assertions actually
    // distinguish "who wrote this version" from "who created the doc" (docs are manage-gated —
    // `member`, below, can read but never write one, per resource_pm_project.yaml).
    beforeAll(async () => {
      manager2 = await createUser("mgr2-docv@a.test", "Manager Two");
      await addMembership(tenant, manager2);
      await grantRole(manager2, await createRole("manager"), "company", tenant);
    });

    const freshProject = (name: string) => createProject(tenant, name, manager);
    const createDoc = (pid: string, body: Record<string, unknown>, headers = hdr()) =>
      app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${pid}/docs`, headers, payload: body });
    const patchDoc = (pid: string, docId: string, body: Record<string, unknown>, headers = hdr()) =>
      app.inject({ method: "PATCH", url: `/api/${tenant}/pm/projects/${pid}/docs/${docId}`, headers, payload: body });
    const listVersions = (docId: string, headers = hdr()) =>
      app.inject({ method: "GET", url: `/api/${tenant}/pm/docs/${docId}/versions`, headers });
    const getVersion = (docId: string, v: number | string, headers = hdr()) =>
      app.inject({ method: "GET", url: `/api/${tenant}/pm/docs/${docId}/versions/${v}`, headers });
    const restoreVersion = (docId: string, v: number | string, headers = hdr()) =>
      app.inject({ method: "POST", url: `/api/${tenant}/pm/docs/${docId}/versions/${v}/restore`, headers });
    const getDoc = (pid: string, docId: string) =>
      app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}/docs/${docId}`, headers: hdr() });

    it("create -> edit -> edit yields versions 1,2,3 with correct authors; getDoc/listDocs expose the current version number", async () => {
      const pid = await freshProject("Doc versions basic");
      const { id: docId } = (await createDoc(pid, { title: "Spec v1", body: "body v1" })).json() as { id: string };

      let versions = (await listVersions(docId)).json() as Array<{ version: number; authorId: string; authorName: string; createdAt: string }>;
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ version: 1, authorId: manager, authorName: "Manager Mo" });
      expect(versions[0].createdAt).toBeTruthy();

      const p2 = await patchDoc(pid, docId, { body: "body v2" }, asUser(manager2));
      expect(p2.statusCode).toBe(200);
      const p3 = await patchDoc(pid, docId, { title: "Spec v3" });
      expect(p3.statusCode).toBe(200);

      versions = (await listVersions(docId)).json() as Array<{ version: number; authorId: string; authorName: string; createdAt: string }>;
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
      expect(versions[0].authorName).toBe("Manager Mo"); // creator
      expect(versions[1].authorName).toBe("Manager Two"); // patcher of v2
      expect(versions[2].authorName).toBe("Manager Mo"); // patcher of v3

      // full-body reads carry title/body, NOT in the meta list
      expect(versions[0]).not.toHaveProperty("title");
      expect(versions[0]).not.toHaveProperty("body");
      const v2Full = (await getVersion(docId, 2)).json() as { version: number; title: string; body: string; authorName: string };
      expect(v2Full).toMatchObject({ version: 2, title: "Spec v1", body: "body v2" });

      const doc = (await getDoc(pid, docId)).json() as { version: number };
      expect(doc.version).toBe(3);
    });

    it("a no-op PATCH (unchanged title+body) appends NOTHING to history", async () => {
      const pid = await freshProject("Doc versions no-op");
      const { id: docId } = (await createDoc(pid, { title: "Same", body: "Same body" })).json() as { id: string };

      // omit both fields entirely
      await patchDoc(pid, docId, {});
      // resubmit identical values
      await patchDoc(pid, docId, { title: "Same", body: "Same body" });

      const versions = (await listVersions(docId)).json() as Array<{ version: number }>;
      expect(versions).toHaveLength(1); // still just the creation version
    });

    it("restore of v1 makes the doc content v1 AND appends a new version (author = restorer); list shows all rows", async () => {
      const pid = await freshProject("Doc versions restore");
      const { id: docId } = (await createDoc(pid, { title: "Original", body: "original body" })).json() as { id: string };
      await patchDoc(pid, docId, { title: "Edited once", body: "edited body" });
      await patchDoc(pid, docId, { title: "Edited twice", body: "edited body 2" });

      const restore = await restoreVersion(docId, 1, asUser(manager2));
      expect(restore.statusCode).toBe(200);

      const doc = (await getDoc(pid, docId)).json() as { title: string; body: string; version: number };
      expect(doc.title).toBe("Original");
      expect(doc.body).toBe("original body");
      expect(doc.version).toBe(4);

      const versions = (await listVersions(docId)).json() as Array<{ version: number; authorName: string }>;
      expect(versions).toHaveLength(4);
      expect(versions[3]).toMatchObject({ version: 4, authorName: "Manager Two" }); // restorer, not original author

      // history is append-only: version 1's row is untouched, never rewritten
      const v1 = (await getVersion(docId, 1)).json() as { title: string; body: string };
      expect(v1).toMatchObject({ title: "Original", body: "original body" });
    });

    it("restore (and patch) are manage-gated: a plain member can read history but cannot write it", async () => {
      const pid = await freshProject("Doc versions rbac");
      const { id: docId } = (await createDoc(pid, { title: "T", body: "B" })).json() as { id: string };

      const memberRestore = await restoreVersion(docId, 1, asUser(member));
      expect(memberRestore.statusCode).toBe(403);
      const memberPatch = await patchDoc(pid, docId, { title: "hijacked" }, asUser(member));
      expect(memberPatch.statusCode).toBe(403);

      // but a member CAN read the version history/detail (read-gated, like listDocs/getDoc)
      const memberList = await listVersions(docId, asUser(member));
      expect(memberList.statusCode).toBe(200);
      const memberGet = await getVersion(docId, 1, asUser(member));
      expect(memberGet.statusCode).toBe(200);
    });

    it("two concurrent PATCHes on the same doc never produce duplicate version numbers (row-lock guard)", async () => {
      const pid = await freshProject("Doc versions concurrent");
      const { id: docId } = (await createDoc(pid, { title: "Race", body: "start" })).json() as { id: string };

      const [a, b] = await Promise.all([
        patchDoc(pid, docId, { body: "from A" }),
        patchDoc(pid, docId, { body: "from B" }),
      ]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);

      const versions = (await listVersions(docId)).json() as Array<{ version: number }>;
      const versionNumbers = versions.map((v) => v.version);
      expect(versionNumbers).toEqual([1, 2, 3]); // no duplicate, no gap
      expect(new Set(versionNumbers).size).toBe(versionNumbers.length);
    });

    it("versions of a deleted doc are unreachable", async () => {
      const pid = await freshProject("Doc versions deleted");
      const { id: docId } = (await createDoc(pid, { title: "Doomed", body: "B" })).json() as { id: string };
      await adminPool().query(`UPDATE pm_docs SET deleted_at = now() WHERE id = $1`, [docId]);

      expect((await listVersions(docId)).statusCode).toBe(404);
      expect((await getVersion(docId, 1)).statusCode).toBe(404);
      expect((await restoreVersion(docId, 1)).statusCode).toBe(404);
    });

    it("a non-numeric version segment is rejected with 400, and an out-of-range version 404s", async () => {
      const pid = await freshProject("Doc versions validate");
      const { id: docId } = (await createDoc(pid, { title: "T", body: "B" })).json() as { id: string };

      expect((await getVersion(docId, "abc")).statusCode).toBe(400);
      expect((await getVersion(docId, 999)).statusCode).toBe(404);
      expect((await restoreVersion(docId, "0")).statusCode).toBe(400);
    });

    it("tenant isolation: a rival tenant's session 404s against this tenant's doc id on its own URL", async () => {
      const pid = await freshProject("Doc versions iso");
      const { id: docId } = (await createDoc(pid, { title: "Secret", body: "B" })).json() as { id: string };

      const rivalTenant = await createCompany("Rival Co (pm doc versions)", ["agency", "pm"]);
      const rivalAdmin = await createUser("rival-docversions@x.test", "Rival DocVersions Admin");
      await addMembership(rivalTenant, rivalAdmin);
      await grantRole(rivalAdmin, await createRole("manager"), "company", rivalTenant);

      const cross = await app.inject({ method: "GET", url: `/api/${tenant}/pm/docs/${docId}/versions`, headers: asUser(rivalAdmin) });
      expect(cross.statusCode).toBe(403); // not a member of `tenant` at all

      const forged = await app.inject({ method: "GET", url: `/api/${rivalTenant}/pm/docs/${docId}/versions`, headers: asUser(rivalAdmin) });
      expect(forged.statusCode).toBe(404); // RLS scopes pm_docs to rivalTenant -> invisible
    });
  });

  // ---------------- P4-H1 (project time range) + P4-I1/I2/I3 (enforced chained tasks) ----------------
  // Plan: docs/superpowers/plans/2026-08-04-pm-repsona-parity-phase4-plan.md, workstreams H + I.
  // Each test uses its OWN project (freshProject), same discipline as "custom statuses" above, so
  // the default 5-status ladder (backlog/todo/in_progress/blocked/done) is never bled across cases
  // by a materialized custom registry.
  describe("P4-H1 project time range + P4-I1/I2/I3 dependency-chain enforcement", () => {
    const freshProject = (name: string) => createProject(tenant, name, manager);
    const newTask = async (pid: string, body: Record<string, unknown> = {}) =>
      (await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers: hdr(), payload: { projectId: pid, title: "T", ...body } }).then((r) => r.json())).id as string;
    const patchTask = (id: string, body: Record<string, unknown>, headers = hdr()) =>
      app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers, payload: body });
    const getTask = async (id: string) =>
      (await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers: hdr() })).json() as {
        status: string; blockReason: string | null; blockedBy: Array<{ id: string; title: string }>;
      };
    const getProject = async (pid: string) =>
      (await app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${pid}`, headers: hdr() })).json() as {
        startDate: string | null; dueDate: string | null; dependencyEnforcement: boolean;
      };
    const patchProject = (pid: string, body: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/${tenant}/pm/projects/${pid}`, headers: hdr(), payload: body });

    it("P4-H1: exposes + PATCHes the AUTHORED startDate/dueDate range, independent of task dates (decision 12)", async () => {
      const pid = await freshProject("H1 range");
      let proj = await getProject(pid);
      expect(proj.startDate).toBeNull();
      expect(proj.dueDate).toBeNull();
      expect(proj.dependencyEnforcement).toBe(true); // hard-enforced by default (decision 14)

      const r = await patchProject(pid, { startDate: "2026-09-01", dueDate: "2026-12-01" });
      expect(r.statusCode).toBe(200);
      proj = await getProject(pid);
      expect(proj.startDate).toBe("2026-09-01");
      expect(proj.dueDate).toBe("2026-12-01");

      // a task with WILDLY different dates never overwrites the authored range — the gap between
      // them is the slippage signal, not something the system silently closes.
      await newTask(pid, { startDate: "2020-01-01", dueDate: "2020-01-02" });
      proj = await getProject(pid);
      expect(proj.startDate).toBe("2026-09-01");
      expect(proj.dueDate).toBe("2026-12-01");
    });

    it("P4-I1: hard-rejects an explicit transition into ToDo/Doing while a dependency is open, naming the blocker", async () => {
      const pid = await freshProject("I1 gate");
      const blocker = await newTask(pid, { title: "Blocker" });
      const dependent = await newTask(pid, { title: "Dependent", status: "backlog" });
      await patchTask(dependent, { addDependency: blocker });

      const intoToDo = await patchTask(dependent, { status: "todo" });
      expect(intoToDo.statusCode).toBe(409);
      // "name the blocker" (decision 17) — the platform's global HttpErrorFilter collapses every
      // HttpException down to `{ error, field? }`, so the blocker's title travels in the message
      // text; the structured form is `blockedBy` on the task's own GET (checked below).
      expect((intoToDo.json() as { error: string }).error).toContain("Blocker");
      expect((await getTask(dependent)).blockedBy.map((d) => d.id)).toEqual([blocker]);

      const intoDoing = await patchTask(dependent, { status: "in_progress" });
      expect(intoDoing.statusCode).toBe(409);

      // rule 3 — the task's own CURRENT status is always reachable; an unrelated edit never 409s
      const noop = await patchTask(dependent, { title: "Dependent (renamed)" });
      expect(noop.statusCode).toBe(200);
      expect((await getTask(dependent)).status).toBe("backlog"); // unchanged by the rejected attempts
    });

    it("P4-I1 rule 2: closing a blocked task IS allowed despite an open dependency (an audited override, not a bypass)", async () => {
      const pid = await freshProject("I1 close override");
      const blocker = await newTask(pid, { title: "Blocker" });
      const dependent = await newTask(pid, { title: "Dependent" }); // default status: todo (ready)
      await patchTask(dependent, { addDependency: blocker });

      const close = await patchTask(dependent, { status: "done" });
      expect(close.statusCode).toBe(200);
      expect((await getTask(dependent)).status).toBe("done");
    });

    it("P4-I1: moving into Backlog while blocked is always allowed (the intake status is exempt)", async () => {
      const pid = await freshProject("I1 backlog exempt");
      const blocker = await newTask(pid, { title: "Blocker" });
      const dependent = await newTask(pid, { title: "Dependent" });
      await patchTask(dependent, { addDependency: blocker });
      const toBacklog = await patchTask(dependent, { status: "backlog" });
      expect(toBacklog.statusCode).toBe(200);
    });

    it("P4-I2/decision13: the last blocker completing auto-promotes a Backlog dependent to ToDo", async () => {
      const pid = await freshProject("I2 promote cross-task");
      const blocker = await newTask(pid, { title: "Blocker" });
      const dependent = await newTask(pid, { title: "Dependent" });
      await patchTask(dependent, { addDependency: blocker });
      await patchTask(dependent, { status: "backlog" }); // exempt even while blocked
      expect((await getTask(dependent)).status).toBe("backlog");

      const complete = await patchTask(blocker, { status: "done" });
      expect(complete.statusCode).toBe(200);
      expect((await getTask(dependent)).status).toBe("todo"); // readyStatus, never the literal "todo" by luck
    });

    it("P4-I2/decision13: removing the LAST dependency (self-triggered, no other task involved) also promotes Backlog -> ToDo", async () => {
      const pid = await freshProject("I2 promote self");
      const blocker = await newTask(pid, { title: "Blocker" });
      const dependent = await newTask(pid, { title: "Dependent" });
      await patchTask(dependent, { addDependency: blocker });
      await patchTask(dependent, { status: "backlog" });

      const removed = await patchTask(dependent, { removeDependency: blocker });
      expect(removed.statusCode).toBe(200);
      expect((await getTask(dependent)).status).toBe("todo");
    });

    it("decision 17: an open dependency forces SYSTEM attribution (block_reason null, blocker named); a human reason is stored once no dependency is open, and survives an unrelated edit", async () => {
      const pid = await freshProject("decision17 attribution");
      const blocker = await newTask(pid, { title: "Blocker" });
      const dependent = await newTask(pid, { title: "Dependent" });
      await patchTask(dependent, { addDependency: blocker });

      // system-set: an open dependency exists -> block_reason is forced null no matter what's sent
      const sys = await patchTask(dependent, { status: "blocked", blockReason: "ignored" });
      expect(sys.statusCode).toBe(200);
      let t = await getTask(dependent);
      expect(t.status).toBe("blocked");
      expect(t.blockReason).toBeNull();
      expect(t.blockedBy.map((d) => d.id)).toEqual([blocker]);

      // clearing the dependency auto-clears the SYSTEM-set block back to ToDo (decision 17)
      await patchTask(blocker, { status: "done" });
      t = await getTask(dependent);
      expect(t.status).toBe("todo");

      // now block it again with NO open dependency -> a human reason, stored verbatim
      const human = await patchTask(dependent, { status: "blocked", blockReason: "waiting on the client" });
      expect(human.statusCode).toBe(200);
      t = await getTask(dependent);
      expect(t.status).toBe("blocked");
      expect(t.blockReason).toBe("waiting on the client");
      expect(t.blockedBy).toEqual([]);

      // a HUMAN-set block is not dependency-driven, so an unrelated edit must not silently wipe it
      const unrelated = await patchTask(dependent, { title: "Dependent (edited)" });
      expect(unrelated.statusCode).toBe(200);
      expect((await getTask(dependent)).blockReason).toBe("waiting on the client");
    });

    it("P4-I3/decision14: a project may explicitly turn dependency enforcement OFF (audited via the same PATCH path)", async () => {
      const pid = await freshProject("I3 override");
      const blocker = await newTask(pid, { title: "Blocker" });
      const dependent = await newTask(pid, { title: "Dependent" });
      await patchTask(dependent, { addDependency: blocker });

      expect((await patchTask(dependent, { status: "in_progress" })).statusCode).toBe(409); // still hard-enforced

      const off = await patchProject(pid, { dependencyEnforcement: false });
      expect(off.statusCode).toBe(200);
      expect((await getProject(pid)).dependencyEnforcement).toBe(false);

      const started = await patchTask(dependent, { status: "in_progress" });
      expect(started.statusCode).toBe(200);
      expect((await getTask(dependent)).status).toBe("in_progress");
    });

    it("P4-I5: passing the ball on a blocked task is allowed, but bundling it with an explicit start in the SAME patch is not", async () => {
      const pid = await freshProject("I5 ball pass");
      const blocker = await newTask(pid, { title: "Blocker" });
      const dependent = await newTask(pid, {
        title: "Dependent",
        assignee: { kind: "person", refId: member, refName: "Member Mel", responsibleId: member, responsibleName: "Member Mel" },
      });
      await patchTask(dependent, { addDependency: blocker });

      // decision 4 (anyone may pass the ball) + this plan's §I5: handing over blocked work is fine
      const pass = await patchTask(dependent, {
        assignee: { kind: "person", refId: manager, refName: "Manager Mo", responsibleId: manager, responsibleName: "Manager Mo" },
      });
      expect(pass.statusCode).toBe(200);
      expect((await getTask(dependent)).status).not.toBe("in_progress");

      // the case the plan warns will be got wrong: a ball-pass must NOT smuggle a start through
      const passAndStart = await patchTask(dependent, {
        assignee: { kind: "person", refId: member, refName: "Member Mel", responsibleId: member, responsibleName: "Member Mel" },
        status: "in_progress",
      });
      expect(passAndStart.statusCode).toBe(409);
      expect((await getTask(dependent)).status).not.toBe("in_progress");
    });

    it("a dependency can point at a task in a DIFFERENT project; that project's OWN is_done flag decides openness", async () => {
      const pidA = await freshProject("I cross A");
      const pidB = await freshProject("I cross B");
      const blocker = await newTask(pidB, { title: "Blocker in B" });
      const dependent = await newTask(pidA, { title: "Dependent in A" });
      await patchTask(dependent, { addDependency: blocker });

      expect((await patchTask(dependent, { status: "in_progress" })).statusCode).toBe(409);
      await patchTask(blocker, { status: "done" });
      expect((await patchTask(dependent, { status: "in_progress" })).statusCode).toBe(200);
    });

    it("deleting a blocker counts as closing it: the last dependent auto-clears from a system-set Blocked", async () => {
      const pid = await freshProject("I delete cascades");
      const blocker = await newTask(pid, { title: "Blocker" });
      const dependent = await newTask(pid, { title: "Dependent" });
      await patchTask(dependent, { addDependency: blocker });
      await patchTask(dependent, { status: "blocked" }); // system-set: openDeps > 0 at the time
      expect((await getTask(dependent)).blockReason).toBeNull();

      const del = await app.inject({ method: "DELETE", url: `/api/${tenant}/pm/tasks/${blocker}`, headers: hdr() });
      expect(del.statusCode).toBe(200);
      expect((await getTask(dependent)).status).toBe("todo");
    });
  });

  // ---------------- P4-A1 — cross-project (`@all`) task list: facets + cursor pagination ----------------
  describe("P4-A1 — cross-project task list facets + pagination", () => {
    type ListItem = {
      id: string; projectId: string; status: string; priority: string; dueDate: string | null;
      isDone: boolean; isBlocked: boolean; assignee: { refId: string; responsibleId: string; kind: string } | null;
      tags: string[]; milestoneId: string | null;
    };
    const addDays = (n: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };

    // Every test below gets its OWN tenant. This endpoint is DELIBERATELY tenant-wide with no
    // project filter (the whole point of `@all`), so reusing the file's shared `tenant` would mean
    // every assertion also sees whatever every OTHER test in this 2000-line file left behind there
    // — harmless for a handful of tests, but this describe block runs enough "the list contains
    // exactly..." and "walked the full set" assertions that shared-tenant noise becomes a real
    // flake source once the whole suite (not just this filter) is run together. Isolation costs
    // one extra company/user per test and buys determinism regardless of run order.
    const isoPm = async (label: string) => {
      const t = await createCompany(`Agency A1 ${label} (isolated)`, ["agency", "pm"]);
      const mgr = await createUser(`${newId()}@x.test`, `A1 ${label} Manager`);
      const mem = await createUser(`${newId()}@x.test`, `A1 ${label} Member`);
      await addMembership(t, mgr);
      await addMembership(t, mem);
      await grantRole(mgr, await createRole("manager"), "company", t);
      const h = asUser(mgr);
      const newProject = (name: string) => createProject(t, name, mgr);
      const newTask = async (pid: string, body: Record<string, unknown> = {}) =>
        (await app.inject({ method: "POST", url: `/api/${t}/pm/tasks`, headers: h, payload: { projectId: pid, title: "T", ...body } }).then((r) => r.json())).id as string;
      const list = (qs = "", as = h) => app.inject({ method: "GET", url: `/api/${t}/pm/tasks${qs}`, headers: as });
      return { t, mgr, mem, hdr: h, newProject, newTask, list };
    };

    it("default (includeClosed=false) excludes done tasks; includeClosed=true reveals them", async () => {
      const iso = await isoPm("default visibility");
      const pid = await iso.newProject("A1 default visibility");
      const open = await iso.newTask(pid, { title: "Open one" });
      const done = await iso.newTask(pid, { title: "Done one", status: "done" });

      const r1 = await iso.list();
      expect(r1.statusCode).toBe(200);
      const { items: hidden } = r1.json() as { items: ListItem[]; nextCursor: string | null };
      const ids1 = hidden.map((t) => t.id);
      expect(ids1).toContain(open);
      expect(ids1).not.toContain(done);

      const r2 = await iso.list("?includeClosed=true");
      const { items: shown } = r2.json() as { items: ListItem[]; nextCursor: string | null };
      const ids2 = shown.map((t) => t.id);
      expect(ids2).toContain(open);
      expect(ids2).toContain(done);
      const doneRow = shown.find((t) => t.id === done)!;
      expect(doneRow.isDone).toBe(true);
    });

    it("isDone/isBlocked are FLAG-DRIVEN off the task's OWN project registry, not a literal status match", async () => {
      const iso = await isoPm("custom registry");
      const pid = await iso.newProject("A1 custom registry");
      await app.inject({ method: "POST", url: `/api/${iso.t}/pm/projects/${pid}/statuses`, headers: iso.hdr, payload: { label: "Shipped", color: "#4B7A5A", isDone: true } });
      await app.inject({ method: "POST", url: `/api/${iso.t}/pm/projects/${pid}/statuses`, headers: iso.hdr, payload: { label: "OnHold", color: "#FF7043", isBlocked: true } });
      const shipped = await iso.newTask(pid, { title: "Shipped one", status: "shipped" });
      const onHold = await iso.newTask(pid, { title: "On hold one", status: "onhold" });

      const r = await iso.list("?includeClosed=true");
      const { items } = r.json() as { items: ListItem[] };
      expect(items.find((t) => t.id === shipped)?.isDone).toBe(true);
      expect(items.find((t) => t.id === onHold)?.isBlocked).toBe(true);
      // an overdue "shipped" task must NOT surface under overdueOnly — done outranks the date.
      await app.inject({ method: "PATCH", url: `/api/${iso.t}/pm/tasks/${shipped}`, headers: iso.hdr, payload: { dueDate: addDays(-5) } });
      const overdue = await iso.list("?overdueOnly=true");
      const overdueIds = (overdue.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(overdueIds).not.toContain(shipped);
    });

    it("status[] / priority[] filter (repeated-key and comma-separated both parse); an invalid value 400s", async () => {
      const iso = await isoPm("status priority");
      const pid = await iso.newProject("A1 status priority");
      const todo = await iso.newTask(pid, { title: "todo one", priority: "high" });
      const blocked = await iso.newTask(pid, { title: "blocked one", status: "blocked", priority: "urgent" });
      await iso.newTask(pid, { title: "normal one" });

      const byStatusComma = await iso.list("?status=todo,blocked");
      const idsComma = (byStatusComma.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(idsComma).toEqual(expect.arrayContaining([todo, blocked]));

      const byStatusRepeated = await iso.list("?status=todo&status=blocked");
      const idsRepeated = (byStatusRepeated.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(idsRepeated.sort()).toEqual(idsComma.sort());

      const byPriority = await iso.list("?priority=high,urgent");
      const priIds = (byPriority.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(priIds).toEqual(expect.arrayContaining([todo, blocked]));

      const badPriority = await iso.list("?priority=extreme");
      expect(badPriority.statusCode).toBe(400);
      const badStatus = await iso.list("?status=" + "x".repeat(41));
      expect(badStatus.statusCode).toBe(400);
    });

    it("tag[] overlap, milestone[], responsible[] and ball[] (refId, kind-agnostic) all narrow the tenant-wide list", async () => {
      const iso = await isoPm("tag milestone assignee");
      const pid = await iso.newProject("A1 tag milestone assignee");
      const tag = (await app.inject({ method: "POST", url: `/api/${iso.t}/pm/projects/${pid}/tags`, headers: iso.hdr, payload: { label: "Urgent", color: "clay" } }).then((r) => r.json())) as { id: string };
      const ms = (await app.inject({ method: "POST", url: `/api/${iso.t}/pm/projects/${pid}/milestones`, headers: iso.hdr, payload: { name: "MVP" } }).then((r) => r.json())) as { id: string };
      const deptBallId = newId(); // Ball = assignee.refId, kind-agnostic — a department id works exactly like a person id here.

      const tagged = await iso.newTask(pid, { title: "tagged", tags: [tag.id] });
      const milestoned = await iso.newTask(pid, { title: "milestoned", milestoneId: ms.id });
      const respTask = await iso.newTask(pid, {
        title: "responsible target",
        assignee: { kind: "person", refId: iso.mem, refName: "Member", responsibleId: iso.mgr, responsibleName: "Manager" },
      });
      const ballTask = await iso.newTask(pid, {
        title: "ball target",
        assignee: { kind: "department", refId: deptBallId, refName: "Dept", responsibleId: iso.mem, responsibleName: "Member" },
      });
      const plain = await iso.newTask(pid, { title: "plain" });

      const byTag = await iso.list(`?tag=${tag.id}`);
      const tagIds = (byTag.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(tagIds).toContain(tagged);
      expect(tagIds).not.toContain(plain);

      const byMs = await iso.list(`?milestone=${ms.id}`);
      const msIds = (byMs.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(msIds).toContain(milestoned);
      expect(msIds).not.toContain(plain);

      const byResp = await iso.list(`?responsible=${iso.mgr}`);
      const respIds = (byResp.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(respIds).toContain(respTask);
      expect(respIds).not.toContain(ballTask);

      const byBall = await iso.list(`?ball=${deptBallId}`);
      const ballIds = (byBall.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(ballIds).toContain(ballTask);
      expect(ballIds).not.toContain(respTask);

      const badUuid = await iso.list("?tag=not-a-uuid");
      expect(badUuid.statusCode).toBe(400);
    });

    it("dueFrom/dueTo range + q keyword search (with literal %/_ in the term, not treated as a wildcard)", async () => {
      const iso = await isoPm("due range and q");
      const pid = await iso.newProject("A1 due range and q");
      const inRange = await iso.newTask(pid, { title: "In range", dueDate: addDays(5) });
      const outOfRange = await iso.newTask(pid, { title: "Out of range", dueDate: addDays(50) });
      const percentTitle = await iso.newTask(pid, { title: "50% done report" });
      const decoy = await iso.newTask(pid, { title: "50 days done report" }); // "50<anything> done" would match "50% done" as an UNESCAPED LIKE pattern (% as wildcard); must NOT match once % is escaped literal

      const byRange = await iso.list(`?dueFrom=${addDays(1)}&dueTo=${addDays(10)}`);
      const rangeIds = (byRange.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(rangeIds).toContain(inRange);
      expect(rangeIds).not.toContain(outOfRange);

      const byQ = await iso.list(`?q=${encodeURIComponent("50% done")}`);
      const qIds = (byQ.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(qIds).toContain(percentTitle);
      expect(qIds).not.toContain(decoy);

      const badDate = await iso.list("?dueFrom=not-a-date");
      expect(badDate.statusCode).toBe(400);
    });

    it("overdueOnly / dueSoon agree with lib/pmUrgency.ts's boundaries, and combine as a UNION when both are set", async () => {
      const iso = await isoPm("urgency");
      const pid = await iso.newProject("A1 urgency");
      const overdue = await iso.newTask(pid, { title: "Overdue", dueDate: addDays(-2) });
      const dueSoonEdge = await iso.newTask(pid, { title: "Due soon (boundary, day 3)", dueDate: addDays(3) });
      const onTrack = await iso.newTask(pid, { title: "On track (day 4)", dueDate: addDays(4) });
      const undated = await iso.newTask(pid, { title: "Undated" });

      const overdueOnly = await iso.list("?overdueOnly=true");
      const overdueIds = (overdueOnly.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(overdueIds).toContain(overdue);
      expect(overdueIds).not.toContain(dueSoonEdge);
      expect(overdueIds).not.toContain(onTrack);
      expect(overdueIds).not.toContain(undated);

      const dueSoonOnly = await iso.list("?dueSoon=true");
      const dueSoonIds = (dueSoonOnly.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(dueSoonIds).toContain(dueSoonEdge);
      expect(dueSoonIds).not.toContain(overdue);
      expect(dueSoonIds).not.toContain(onTrack);

      const both = await iso.list("?overdueOnly=true&dueSoon=true");
      const bothIds = (both.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(bothIds).toEqual(expect.arrayContaining([overdue, dueSoonEdge]));
      expect(bothIds).not.toContain(onTrack);
      expect(bothIds).not.toContain(undated);
    });

    it("cursor pagination walks the full set exactly once, in ascending due-date order, undated last", async () => {
      const iso = await isoPm("pagination");
      const pid = await iso.newProject("A1 pagination");
      const withDates = await Promise.all([0, 1, 2, 3].map((n) => iso.newTask(pid, { title: `Dated ${n}`, dueDate: addDays(n) })));
      const undated = await iso.newTask(pid, { title: "Undated tail" });
      const all = [...withDates, undated];

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r = await iso.list(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(r.statusCode).toBe(200);
        const { items, nextCursor } = r.json() as { items: ListItem[]; nextCursor: string | null };
        expect(items.length).toBeGreaterThan(0);
        expect(items.length).toBeLessThanOrEqual(2);
        seen.push(...items.map((t) => t.id));
        cursor = nextCursor;
        pages += 1;
      } while (cursor && pages < 20);

      expect(seen).toHaveLength(all.length);
      for (const id of all) expect(seen.filter((x) => x === id)).toHaveLength(1);
      const undatedIdx = seen.indexOf(undated);
      const lastDatedIdx = seen.indexOf(withDates[withDates.length - 1]);
      expect(undatedIdx).toBeGreaterThan(lastDatedIdx);

      const badCursor = await iso.list("?cursor=not-valid-base64url-json");
      expect(badCursor.statusCode).toBe(400);
      const badLimit = await iso.list("?limit=0");
      expect(badLimit.statusCode).toBe(400);
    });

    it("includeSubtasks is accepted but a no-op today (subtasks are a checklist blob, not first-class tasks)", async () => {
      const iso = await isoPm("include subtasks noop");
      const pid = await iso.newProject("A1 include subtasks noop");
      const id = await iso.newTask(pid, { title: "Has a checklist", subtasks: ["Step one"] });
      const withFlag = await iso.list("?includeSubtasks=true");
      const withoutFlag = await iso.list("?includeSubtasks=false");
      const idsWith = (withFlag.json() as { items: ListItem[] }).items.map((t) => t.id);
      const idsWithout = (withoutFlag.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(idsWith).toContain(id);
      expect(idsWithout).toContain(id);
    });

    it("RLS: a rival tenant's tasks never surface through ANY facet combination, and a forged cross-tenant URL 403s", async () => {
      const home = await isoPm("rls home");
      const pid = await home.newProject("A1 rls home");
      const homeTag = (await app.inject({ method: "POST", url: `/api/${home.t}/pm/projects/${pid}/tags`, headers: home.hdr, payload: { label: "Home", color: "olive" } }).then((r) => r.json())) as { id: string };
      const homeTask = await home.newTask(pid, {
        title: "Home task 50% overdue",
        status: "blocked",
        priority: "urgent",
        dueDate: addDays(-1),
        tags: [homeTag.id],
        assignee: { kind: "person", refId: home.mem, refName: "Member", responsibleId: home.mgr, responsibleName: "Manager" },
      });

      const rival = await isoPm("rls rival");
      const rivalPid = await rival.newProject("Rival A1 project");
      const rivalTag = (await app.inject({ method: "POST", url: `/api/${rival.t}/pm/projects/${rivalPid}/tags`, headers: rival.hdr, payload: { label: "Home", color: "olive" } }).then((r) => r.json())) as { id: string };
      // deliberately overlapping shape (same status/priority/dueDate/tag LABEL/assignee ids) so a
      // leak through shared literal values, not just distinct ids, would be caught.
      const rivalTask = (await app.inject({
        method: "POST", url: `/api/${rival.t}/pm/tasks`, headers: rival.hdr,
        payload: { projectId: rivalPid, title: "Home task 50% overdue", status: "blocked", priority: "urgent", dueDate: addDays(-1), tags: [rivalTag.id] },
      }).then((r) => r.json())) as { id: string };

      // Every facet this ticket adds, exercised at once, against the HOME tenant's URL.
      const qs = `?status=blocked&priority=urgent&tag=${homeTag.id}&responsible=${home.mgr}&ball=${home.mem}&dueFrom=${addDays(-30)}&dueTo=${addDays(0)}&q=${encodeURIComponent("50%")}&overdueOnly=true&includeClosed=true&limit=200`;
      const r = await home.list(qs);
      expect(r.statusCode).toBe(200);
      const ids = (r.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(ids).toContain(homeTask);
      expect(ids).not.toContain(rivalTask.id);

      // a forged cross-tenant tag/responsible/ball id (the RIVAL's own uuids) against the HOME
      // tenant's URL must find nothing under RLS — never silently ignored-vs-leaked ambiguity.
      const forgedFacets = await home.list(`?tag=${rivalTag.id}&responsible=${rival.mgr}`);
      const forgedIds = (forgedFacets.json() as { items: ListItem[] }).items.map((t) => t.id);
      expect(forgedIds).not.toContain(rivalTask.id);

      // and the base RBAC wall still applies underneath all of this: a rival principal simply
      // reading the home tenant's URL is denied outright.
      const cross = await home.list("", rival.hdr);
      expect(cross.statusCode).toBe(403);
    });
  });

  // ---------------- P4-A2 — cross-project (tenant-grain) burndown + flow ----------------
  describe("P4-A2 — tenant-grain burndown + flow", () => {
    const getTenantBurndown = (qs = "", as = hdr()) => app.inject({ method: "GET", url: `/api/${tenant}/pm/burndown${qs}`, headers: as });
    const getTenantFlow = (qs = "", as = hdr()) => app.inject({ method: "GET", url: `/api/${tenant}/pm/flow${qs}`, headers: as });
    const todayStr = () => new Date().toISOString().slice(0, 10);

    // Both aggregate EVERY project in the tenant (that's the whole point of "tenant-grain"), so
    // an exact-count assertion needs its own isolated tenant per test — the shared `tenant` above
    // already carries dozens of projects/tasks from every other test in this file by the time
    // these run, same reasoning as P4-A1's pagination-completeness test.
    const isolatedTenant = async (label: string) => {
      const t = await createCompany(`Agency A2 ${label} (isolated)`, ["agency", "pm"]);
      const mgr = await createUser(`a2-${label.replace(/\s+/g, "-")}@x.test`, `A2 ${label} Manager`);
      await addMembership(t, mgr);
      await grantRole(mgr, await createRole("manager"), "company", t);
      const h = asUser(mgr);
      const newProject = (name: string) => createProject(t, name, mgr);
      const newTask = async (pid: string, body: Record<string, unknown> = {}) =>
        (await app.inject({ method: "POST", url: `/api/${t}/pm/tasks`, headers: h, payload: { projectId: pid, title: "T", ...body } }).then((r) => r.json())).id as string;
      return { tenantId: t, hdr: h, newProject, newTask };
    };

    it("burndown sums open/done across every project and weights avgProgress by each project's own task count", async () => {
      const iso = await isolatedTenant("burndown");
      const p1 = await iso.newProject("A2 burndown p1");
      const p2 = await iso.newProject("A2 burndown p2");
      // p1: 1 task at 0% progress (open). p2: 1 open (0%) + 1 done (100%) -> avg 50 in p2 alone.
      await iso.newTask(p1);
      await iso.newTask(p2);
      const doneInP2 = await iso.newTask(p2, { status: "done" });
      await app.inject({ method: "PATCH", url: `/api/${iso.tenantId}/pm/tasks/${doneInP2}`, headers: iso.hdr, payload: { progress: 100 } });

      const r = await app.inject({ method: "GET", url: `/api/${iso.tenantId}/pm/burndown?from=${todayStr()}&to=${todayStr()}`, headers: iso.hdr });
      expect(r.statusCode).toBe(200);
      const rows = r.json() as Array<{ date: string; open: number; done: number; avgProgress: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].open).toBe(2); // p1's task + p2's open task
      expect(rows[0].done).toBe(1); // p2's done task
      // weighted mean: p1 contributes progress 0 over 1 task, p2 contributes (0+100)/2=50 over 2
      // tasks -> tenant-wide weighted avg = (1*0 + 2*50) / 3 = 33 (rounded).
      expect(rows[0].avgProgress).toBe(33);
    });

    it("flow merges per-project status_counts by summing the SAME literal status id across projects", async () => {
      const iso = await isolatedTenant("flow");
      const p1 = await iso.newProject("A2 flow p1");
      const p2 = await iso.newProject("A2 flow p2");
      await iso.newTask(p1, { status: "todo" });
      await iso.newTask(p1, { status: "todo" });
      await iso.newTask(p2, { status: "todo" });
      await iso.newTask(p2, { status: "done" });

      const r = await app.inject({ method: "GET", url: `/api/${iso.tenantId}/pm/flow?from=${todayStr()}&to=${todayStr()}`, headers: iso.hdr });
      expect(r.statusCode).toBe(200);
      const rows = r.json() as Array<{ date: string; counts: Record<string, number> }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].counts.todo).toBe(3);
      expect(rows[0].counts.done).toBe(1);
    });

    it("empty range returns [] for both; a plain member (read-gated) can still read", async () => {
      const b = await getTenantBurndown("?from=2000-01-01&to=2000-01-02");
      expect(b.statusCode).toBe(200);
      expect(b.json()).toEqual([]);
      const f = await getTenantFlow("?from=2000-01-01&to=2000-01-02");
      expect(f.statusCode).toBe(200);
      expect(f.json()).toEqual([]);

      const memberBurndown = await getTenantBurndown("", asUser(member));
      expect(memberBurndown.statusCode).toBe(200);
    });

    it("validates from/to and applies the SAME RLS wall as every other pm_project read", async () => {
      expect((await getTenantBurndown("?from=not-a-date")).statusCode).toBe(400);
      expect((await getTenantFlow("?to=07-24-2026")).statusCode).toBe(400);

      const rivalTenant = await createCompany("Rival Co (pm A2)", ["agency", "pm"]);
      const rivalAdmin = await createUser("rival-a2@x.test", "Rival A2 Admin");
      await addMembership(rivalTenant, rivalAdmin);
      await grantRole(rivalAdmin, await createRole("manager"), "company", rivalTenant);

      expect((await getTenantBurndown("", asUser(rivalAdmin))).statusCode).toBe(403);
      expect((await getTenantFlow("", asUser(rivalAdmin))).statusCode).toBe(403);
    });
  });
});
