// SCP-5h / W5-C3 — PM's project template through the real HTTP layer, on REAL Postgres (RLS) and REAL Cerbos (BFF §63.29.1, §63.29.6,
// PERMISSION §57). Needs DATABASE_URL_TEST and the CI Cerbos; skipped without them, and a skip is not a pass.
//
// THE CLAIMS UNDER TEST
//   1. The templates routes take `kind: 'project'`, validate its payload with 400 `invalid_field` `{field: 'payload.<path>'}`, and a
//      PATCH validates against the stored kind.
//   2. Apply makes a milestone per phase and a task per step, due in working days from the kickoff on the company's default HR holiday
//      calendar (the golden dates below, written from a printed calendar), starting on the kickoff, Ball and Responsible the role's
//      person (none for a role left unmapped), in the project's ready status, with the subtasks; then the application row with a
//      copy of the template. The person given tasks is told once.
//   3. ONE transaction: a failure after the tasks are written (the application row's own CHECK refusing) leaves no task, no
//      milestone and no application.
//   4. Idempotent: a replayed id answers 200 with the same ids and makes nothing; the same template again under a new id is 409
//      `template_already_applied` with the first application's id; two applies at once make one set of tasks; an id used for
//      another project is 400 `{field: 'id'}`.
//   5. Refusals: a template that is `task`, deleted or another company's is 400 `{field: 'templateId'}`; a person who is not an
//      active member, or a role the template does not have, is 400 `{field: 'people.<role>'}`; a bad kickoff is 400.
//   6. The gates: `pm_project` · `manage` applies and moves the kickoff (a manager); a member and another company's manager are
//      403; a member reads the applications (`read`), the outsider does not.
//   7. The applications read: progress over the live tasks (done by the project's status flags) and the next open step with `late`.
//   8. The kickoff move re-dates only the tasks not yet done, and the milestones with them; 404 `application_not_found`.
//
// THE GOLDEN DATES (company A's calendar: Mon to Fri, holidays Fri 2026-12-25 and Fri 2027-01-01)
//   kickoff Thu 2026-12-24: offset 0 → 12-24 · 1 → Mon 12-28 · 2 → Tue 12-29 · 3 → Wed 12-30 · 5 → Mon 2027-01-04
//   kickoff Fri 2027-01-01 (a holiday, so counted from Mon 01-04): 0 → 01-04 · 1 → Tue 01-05 · 2 → Wed 01-06 · 5 → Mon 01-11
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../../testing/fixtures";
import { todayIsoInTz } from "../reports/person-scope";
import { parseApplyTemplateBody } from "./pm.controller";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const PAYLOAD = {
  title: "Mock client onboarding",
  phases: [{ key: "kickoff", title: "Mock kickoff" }, { key: "access", title: "Mock access" }, { key: "spare", title: "Mock spare" }],
  roles: [{ key: "lead", label: "Lead" }, { key: "officer", label: "Officer" }, { key: "client", label: "Client" }, { key: "guest", label: "Guest" }],
  tasks: [
    { key: "meet", title: "Mock kickoff meeting held", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0, subtasks: ["Mock agenda sent"] },
    { key: "group", title: "Mock chat group opened", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 1 },
    { key: "meta", title: "Mock partner access granted", phase: "access", role: "officer", dueOffsetWorkingDays: 2, description: "Mock note" },
    { key: "extra", title: "Mock unassigned step", phase: "access", role: "guest", dueOffsetWorkingDays: 3 },
    { key: "drive", title: "Mock brand files received", phase: "access", role: "client", dueOffsetWorkingDays: 5 },
  ],
};

interface Answer { applicationId: string; tasks: Array<{ key: string; taskId: string; dueDate: string }>; milestones: Array<{ phase: string; milestoneId: string; dueDate: string | null }> }

describe.skipIf(!TEST_URL)("SCP-5h · PM project templates: apply, applications, kickoff move (BFF §63.29.1)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let manager: string;
  let member: string;
  let officer: string;
  let stranger: string;
  let leaver: string;
  let outsider: string;
  let project: string;
  let templateId: string;
  let taskTemplateId: string;
  let otherCompanyTemplate: string;

  const tpl = (body: unknown, who = manager, method: "POST" | "PATCH" = "POST", id = "") =>
    app.inject({ method, url: `/api/${A}/pm/templates${id ? `/${id}` : ""}`, headers: asUser(who), payload: body as Record<string, unknown> });
  const apply = (projectId: string, body: Record<string, unknown>, who = manager, tenant = A) =>
    app.inject({ method: "POST", url: `/api/${tenant}/pm/projects/${projectId}/apply-template`, headers: asUser(who), payload: body });
  const list = (projectId: string, who = manager, tenant = A) =>
    app.inject({ method: "GET", url: `/api/${tenant}/pm/projects/${projectId}/template-applications`, headers: asUser(who) });
  const move = (applicationId: string, body: unknown, who = manager, tenant = A) =>
    app.inject({ method: "PATCH", url: `/api/${tenant}/pm/template-applications/${applicationId}`, headers: asUser(who), payload: body as Record<string, unknown> });
  const body = (over: Record<string, unknown> = {}) => ({
    id: newId(), templateId, kickoff: "2026-12-24", people: { lead: manager, officer, client: officer }, ...over,
  });
  const count = async (sql: string, params: unknown[]) => Number((await adminPool().query(sql, params)).rows[0].n);
  const tasksOf = (projectId: string) => count(`SELECT count(*)::int AS n FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL`, [projectId]);
  const milestonesOf = (projectId: string) => count(`SELECT count(*)::int AS n FROM pm_milestones WHERE project_id = $1 AND deleted_at IS NULL`, [projectId]);
  const applicationsOf = (projectId: string) => count(`SELECT count(*)::int AS n FROM pm_template_applications WHERE project_id = $1`, [projectId]);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    A = await createCompany("Mock Agency PT", ["agency", "pm", "hr"]);
    B = await createCompany("Mock Other PT", ["agency", "pm"]);
    manager = await createUser("pt-manager@a.test", "Mock Manager");
    member = await createUser("pt-member@a.test", "Mock Member");
    officer = await createUser("pt-officer@a.test", "Mock Officer");
    stranger = await createUser("pt-stranger@a.test", "Mock Stranger");
    leaver = await createUser("pt-leaver@a.test", "Mock Leaver");
    outsider = await createUser("pt-outsider@b.test", "Mock Outsider");
    for (const u of [manager, member, officer, leaver]) await addMembership(A, u);
    await addMembership(B, outsider);
    await adminPool().query(`UPDATE company_memberships SET status = 'inactive' WHERE tenant_id = $1 AND user_id = $2`, [A, leaver]);
    const mgrRole = await createRole("manager");
    const memRole = await createRole("member");
    await grantRole(manager, mgrRole, "company", A);
    await grantRole(member, memRole, "company", A);
    await grantRole(officer, memRole, "company", A);
    await grantRole(outsider, mgrRole, "company", B);
    project = await createProject(A, "Mock client project", manager);

    // Company A's default holiday calendar.
    await withTenants([A], async (c) => {
      const calId = newId();
      await c.query(`INSERT INTO hr_holiday_calendars (id, tenant_id, name, is_default) VALUES ($1, $2, 'Mock Calendar', true)`, [calId, A]);
      for (const day of ["2026-12-25", "2027-01-01"]) {
        await c.query(`INSERT INTO hr_holidays (tenant_id, calendar_id, day, name, kind) VALUES ($1, $2, $3::date, 'Mock Holiday', 'public')`, [A, calId, day]);
      }
    }, { modules: ["hr"] });

    app = await buildApp();

    const made = await tpl({ kind: "project", name: "Mock onboarding template", payload: PAYLOAD });
    expect(made.statusCode).toBe(201);
    templateId = (made.json() as { id: string }).id;
    taskTemplateId = ((await tpl({ kind: "task", name: "Mock task template", payload: { title: "Mock" } })).json() as { id: string }).id;
    otherCompanyTemplate = newId();
    await adminPool().query(
      `INSERT INTO pm_templates (id, tenant_id, kind, name, payload, origin_site) VALUES ($1, $2, 'project', 'Mock B template', $3, 'central')`,
      [otherCompanyTemplate, B, JSON.stringify(PAYLOAD)],
    );
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("the templates routes take kind 'project' and name the path of a refused payload", async () => {
    const bad = await tpl({ kind: "project", name: "Mock bad", payload: { ...PAYLOAD, tasks: [{ ...PAYLOAD.tasks[0], phase: "nowhere" }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_field", field: "payload.tasks.0.phase" });
    const dup = await tpl({ kind: "project", name: "Mock bad", payload: { ...PAYLOAD, roles: [...PAYLOAD.roles, { key: "lead", label: "Again" }] } });
    expect(dup.json()).toMatchObject({ error: "invalid_field", field: "payload.roles.4.key" });
    const range = await tpl({ kind: "project", name: "Mock bad", payload: { ...PAYLOAD, tasks: [{ ...PAYLOAD.tasks[0], dueOffsetWorkingDays: 251 }] } });
    expect(range.json()).toMatchObject({ error: "invalid_field", field: "payload.tasks.0.dueOffsetWorkingDays" });
    // A PATCH validates against the STORED kind.
    const patch = await tpl({ payload: { ...PAYLOAD, phases: [] } }, manager, "PATCH", templateId);
    expect(patch.statusCode).toBe(400);
    expect(patch.json()).toMatchObject({ field: "payload.phases" });
    const listed = await app.inject({ method: "GET", url: `/api/${A}/pm/templates?kind=project`, headers: asUser(manager) });
    expect((listed.json() as Array<{ id: string }>).map((t) => t.id)).toEqual([templateId]);
    // A member may not manage templates (pm_task · manage, unchanged).
    expect((await tpl({ kind: "project", name: "Mock", payload: PAYLOAD }, member)).statusCode).toBe(403);
  });

  it("the body: 400 {field} for each malformed part (pure)", () => {
    const field = (b: unknown): string => {
      try { parseApplyTemplateBody(b); } catch (e) { return ((e as { getResponse(): { field: string } }).getResponse()).field; }
      return "accepted";
    };
    expect(field({ ...body(), id: "x" })).toBe("id");
    expect(field({ ...body(), templateId: undefined })).toBe("templateId");
    expect(field({ ...body(), kickoff: "2027-02-29" })).toBe("kickoff");
    expect(field({ ...body(), people: [] })).toBe("people");
    expect(field({ ...body(), people: { lead: "nope" } })).toBe("people.lead");
    expect(field({ ...body(), people: { lead: null } })).toBe("accepted");
    expect(field({ ...body(), people: undefined })).toBe("accepted");
  });

  let first: Answer;

  it("apply: milestones per phase and tasks due in working days on the company calendar, assigned by role, told once", async () => {
    const b = body();
    const r = await apply(project, b);
    expect(r.statusCode).toBe(201);
    first = r.json() as Answer;
    expect(first.applicationId).toBe(b.id);
    expect(first.tasks.map((t) => [t.key, t.dueDate])).toEqual([
      ["meet", "2026-12-24"], ["group", "2026-12-28"], ["meta", "2026-12-29"], ["extra", "2026-12-30"], ["drive", "2027-01-04"],
    ]);
    expect(first.milestones.map((m) => [m.phase, m.dueDate])).toEqual([["kickoff", "2026-12-28"], ["access", "2027-01-04"], ["spare", null]]);

    const rows = await adminPool().query(
      `SELECT id, title, description, status, progress, to_char(start_date, 'YYYY-MM-DD') AS start, to_char(due_date, 'YYYY-MM-DD') AS due,
              assignee, subtasks, milestone_id FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL`, [project]);
    expect(rows.rows).toHaveLength(5);
    const byId = new Map(rows.rows.map((x) => [x.id, x]));
    const t = (key: string) => byId.get(first.tasks.find((x) => x.key === key)!.taskId)!;
    for (const row of rows.rows) {
      expect(row.status).toBe("todo"); // the project's ready status
      expect(row.progress).toBe(0);
      expect(row.start).toBe("2026-12-24"); // starting on the kickoff
    }
    expect(t("meet").assignee).toMatchObject({ kind: "person", refId: manager, responsibleId: manager, refName: "Mock Manager" });
    expect(t("meta").assignee).toMatchObject({ kind: "person", refId: officer, responsibleId: officer });
    expect(t("drive").assignee).toMatchObject({ refId: officer }); // the client's step, mapped to the officer who chases it
    expect(t("extra").assignee).toBeNull(); // a role left unmapped
    expect(t("meta").description).toBe("Mock note");
    expect((t("meet").subtasks as Array<{ title: string; done: boolean }>).map((s) => [s.title, s.done])).toEqual([["Mock agenda sent", false]]);
    expect(t("meet").milestone_id).toBe(first.milestones[0].milestoneId);
    expect(t("drive").milestone_id).toBe(first.milestones[1].milestoneId);
    // The assignee dual-write ran (TR-02): the officer holds an open owner row on their task.
    expect(await count(`SELECT count(*)::int AS n FROM pm_task_assignees WHERE task_id = $1 AND role = 'owner' AND user_id = $2 AND valid_to IS NULL`,
      [t("meta").id, officer])).toBe(1);

    const appRow = (await adminPool().query(`SELECT * FROM pm_template_applications WHERE id = $1`, [b.id])).rows[0];
    expect(appRow.template_name).toBe("Mock onboarding template");
    expect(appRow.people).toEqual({ lead: manager, officer, client: officer });
    expect(appRow.template_payload.tasks).toHaveLength(5);
    expect(appRow.created_by).toBe(manager);

    // The officer is told once (two tasks); the manager applied, so is not told about their own.
    expect(await count(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'assignment'`, [A, officer])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM activities WHERE tenant_id = $1 AND verb = 'template_applied' AND target_entity_id = $2`, [A, project])).toBe(1);
  });

  it("a replayed id answers 200 with the same ids and makes nothing", async () => {
    const before = await tasksOf(project);
    const r = await apply(project, body({ id: first.applicationId }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(first);
    expect(await tasksOf(project)).toBe(before);
    expect(await milestonesOf(project)).toBe(3);
    expect(await applicationsOf(project)).toBe(1);
  });

  it("the same template under a new id is 409 template_already_applied with the first application; an id used elsewhere is 400 {field: 'id'}", async () => {
    const r = await apply(project, body());
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "template_already_applied", detail: { applicationId: first.applicationId } });
    const other = await createProject(A, "Mock other project");
    const reuse = await apply(other, body({ id: first.applicationId }));
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json()).toMatchObject({ error: "invalid_field", field: "id" });
    expect(await tasksOf(other)).toBe(0);
    expect(await tasksOf(project)).toBe(5);
  });

  it("two applies at once make one set of tasks: one 201 and one 409", async () => {
    const p = await createProject(A, "Mock race project");
    const [x, y] = await Promise.all([apply(p, body()), apply(p, body())]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409]);
    expect(await tasksOf(p)).toBe(5);
    expect(await milestonesOf(p)).toBe(3);
    expect(await applicationsOf(p)).toBe(1);
  });

  it("ONE transaction: a failure after the tasks are written leaves no task, no milestone and no application", async () => {
    // A template whose name the application row's CHECK refuses (only reachable by a direct write): the apply writes every milestone
    // and task, then the application INSERT fails, and the whole transaction rolls back.
    const broken = newId();
    await adminPool().query(
      `INSERT INTO pm_templates (id, tenant_id, kind, name, payload, origin_site) VALUES ($1, $2, 'project', '   ', $3, 'central')`,
      [broken, A, JSON.stringify(PAYLOAD)],
    );
    const p = await createProject(A, "Mock rollback project");
    const r = await apply(p, body({ templateId: broken }));
    expect(r.statusCode).toBe(500);
    expect(await tasksOf(p)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM pm_tasks WHERE project_id = $1`, [p])).toBe(0);
    expect(await milestonesOf(p)).toBe(0);
    expect(await applicationsOf(p)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM pm_task_assignees a JOIN pm_tasks t ON t.id = a.task_id WHERE t.project_id = $1`, [p])).toBe(0);
  });

  it("refuses a template that is not a live project template of this company, and people who cannot take the work", async () => {
    const p = await createProject(A, "Mock refusals project");
    const field = async (b: Record<string, unknown>) => { const r = await apply(p, b); expect(r.statusCode).toBe(400); return (r.json() as { field: string }).field; };
    expect(await field(body({ templateId: taskTemplateId }))).toBe("templateId");
    expect(await field(body({ templateId: otherCompanyTemplate }))).toBe("templateId");
    expect(await field(body({ templateId: newId() }))).toBe("templateId");
    const gone = ((await tpl({ kind: "project", name: "Mock deleted", payload: PAYLOAD })).json() as { id: string }).id;
    expect((await app.inject({ method: "DELETE", url: `/api/${A}/pm/templates/${gone}`, headers: asUser(manager) })).statusCode).toBe(200);
    expect(await field(body({ templateId: gone }))).toBe("templateId");
    expect(await field(body({ people: { lead: manager, officer: stranger } }))).toBe("people.officer"); // not a member
    expect(await field(body({ people: { lead: leaver } }))).toBe("people.lead"); // membership not active
    expect(await field(body({ people: { lead: outsider } }))).toBe("people.lead"); // another company's
    expect(await field(body({ people: { ghost: manager } }))).toBe("people.ghost"); // not a role of the template
    expect(await field(body({ kickoff: "2026-12-32" }))).toBe("kickoff");
    expect(await tasksOf(p)).toBe(0);
    const missing = await apply(newId(), body());
    expect(missing.statusCode).toBe(404);
  });

  it("the gates: a member and another company's manager may not apply; a member reads the applications, the outsider does not", async () => {
    const p = await createProject(A, "Mock gate project");
    const m = await apply(p, body(), member);
    expect(m.statusCode).toBe(403);
    const o = await apply(p, body(), outsider);
    expect(o.statusCode).toBe(403);
    expect(await tasksOf(p)).toBe(0);
    expect((await list(project, member)).statusCode).toBe(200);
    expect((await list(project, outsider)).statusCode).toBe(403);
    expect((await move(first.applicationId, { kickoff: "2027-01-01" }, member)).statusCode).toBe(403);
    expect((await move(first.applicationId, { kickoff: "2027-01-01" }, outsider)).statusCode).toBe(403);
  });

  it("the applications read: progress over the live tasks and the next open step", async () => {
    const today = todayIsoInTz(config.reportsTz);
    let items = (await list(project)).json() as Array<{ id: string; templateId: string; templateName: string; kickoff: string; people: unknown; progress: { done: number; total: number }; next: { taskId: string; title: string; dueDate: string; late: boolean } | null }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: first.applicationId, templateId, templateName: "Mock onboarding template", kickoff: "2026-12-24",
      people: { lead: manager, officer, client: officer }, progress: { done: 0, total: 5 },
      next: { taskId: first.tasks[0].taskId, title: "Mock kickoff meeting held", dueDate: "2026-12-24", late: "2026-12-24" < today },
    });
    // Tick the first step through PM's own route: progress counts it and the next step moves on.
    const meet = first.tasks[0].taskId;
    expect((await app.inject({ method: "PATCH", url: `/api/${A}/pm/tasks/${meet}`, headers: asUser(manager), payload: { status: "done" } })).statusCode).toBe(200);
    items = (await list(project)).json() as typeof items;
    expect(items[0].progress).toEqual({ done: 1, total: 5 });
    expect(items[0].next).toMatchObject({ taskId: first.tasks[1].taskId, dueDate: "2026-12-28" });
    // A step deleted since leaves the count.
    const extra = first.tasks.find((t) => t.key === "extra")!.taskId;
    expect((await app.inject({ method: "DELETE", url: `/api/${A}/pm/tasks/${extra}`, headers: asUser(manager) })).statusCode).toBe(200);
    items = (await list(project)).json() as typeof items;
    expect(items[0].progress).toEqual({ done: 1, total: 4 });
    // A project with none answers an empty list; a project that does not exist is 404.
    expect((await list(await createProject(A, "Mock empty project"))).json()).toEqual([]);
  });

  it("a step due in the past is late", async () => {
    const p = await createProject(A, "Mock late project");
    const r = await apply(p, body({ kickoff: "2020-03-02" }));
    expect(r.statusCode).toBe(201);
    const items = (await list(p)).json() as Array<{ next: { late: boolean; dueDate: string } }>;
    expect(items[0].next).toMatchObject({ dueDate: "2020-03-02", late: true });
  });

  it("the kickoff move re-dates only the tasks not yet done, and the milestones with them", async () => {
    // 'meet' is done (ticked above) and 'extra' deleted: neither moves.
    const before = await adminPool().query(
      `SELECT id, to_char(start_date, 'YYYY-MM-DD') AS start, to_char(due_date, 'YYYY-MM-DD') AS due FROM pm_tasks WHERE id = ANY($1::uuid[])`,
      [first.tasks.map((t) => t.taskId)]);
    const was = new Map(before.rows.map((r) => [r.id, r]));
    const r = await move(first.applicationId, { kickoff: "2027-01-01" });
    expect(r.statusCode).toBe(200);
    const out = r.json() as { kickoff: string; moved: Array<{ taskId: string; dueDate: string }>; progress: { done: number; total: number } };
    expect(out.kickoff).toBe("2027-01-01");
    const id = (key: string) => first.tasks.find((t) => t.key === key)!.taskId;
    expect(out.moved).toEqual([
      { taskId: id("group"), dueDate: "2027-01-05" },
      { taskId: id("meta"), dueDate: "2027-01-06" },
      { taskId: id("drive"), dueDate: "2027-01-11" },
    ]);
    const after = await adminPool().query(
      `SELECT id, to_char(start_date, 'YYYY-MM-DD') AS start, to_char(due_date, 'YYYY-MM-DD') AS due FROM pm_tasks WHERE id = ANY($1::uuid[])`,
      [first.tasks.map((t) => t.taskId)]);
    const now = new Map(after.rows.map((x) => [x.id, x]));
    expect(now.get(id("meet"))).toEqual(was.get(id("meet"))); // done: never moves
    expect(now.get(id("extra"))).toEqual(was.get(id("extra"))); // deleted: never moves
    expect(now.get(id("group"))).toMatchObject({ start: "2027-01-01", due: "2027-01-05" });
    expect(now.get(id("drive"))).toMatchObject({ start: "2027-01-01", due: "2027-01-11" });
    const ms = await adminPool().query(`SELECT id, to_char(due_date, 'YYYY-MM-DD') AS due FROM pm_milestones WHERE project_id = $1`, [project]);
    const msDue = new Map(ms.rows.map((x) => [x.id, x.due]));
    expect(msDue.get(first.milestones[0].milestoneId)).toBe("2027-01-05"); // kickoff: max(done meet 12-24, group 01-05)
    expect(msDue.get(first.milestones[1].milestoneId)).toBe("2027-01-11");
    expect(msDue.get(first.milestones[2].milestoneId)).toBeNull();
    expect((await adminPool().query(`SELECT to_char(kickoff, 'YYYY-MM-DD') AS k FROM pm_template_applications WHERE id = $1`, [first.applicationId])).rows[0].k).toBe("2027-01-01");
    // A replay of the apply now answers the CURRENT dates.
    const replay = (await apply(project, body({ id: first.applicationId }))).json() as Answer;
    expect(replay.tasks.find((t) => t.key === "drive")!.dueDate).toBe("2027-01-11");
  });

  it("the move's refusals: 400 kickoff, 404 application_not_found", async () => {
    const bad = await move(first.applicationId, { kickoff: "soon" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ field: "kickoff" });
    const nf = await move(newId(), { kickoff: "2027-01-04" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toMatchObject({ error: "application_not_found" });
    expect((await move("not-a-uuid", { kickoff: "2027-01-04" })).statusCode).toBe(404);
    // Another company's URL does not see A's application.
    expect((await move(first.applicationId, { kickoff: "2027-01-04" }, outsider, B)).statusCode).toBe(404);
  });
});
