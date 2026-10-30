// SCP-5h (W5-C4) — client onboarding's Social half, against REAL Postgres (the three walls) and REAL Cerbos, through the real HTTP layer: BFF §63.29.4 and §63.29.6.
//
//   GET onboarding   POST engagements/:engagementId/onboarding   GET settings / PUT settings (`onboardingTemplateId`)   and PM's own PATCH template-applications / PATCH tasks
//
// THE CLAIMS UNDER TEST (63.29.6, in its order)
//   1. THE SETTING. The four write the company's onboarding template; an officer, a company admin and a Web Dev head are 403 `not_a_social_approver` (before the body is read);
//      the template must be a live `project` template of THIS company: a `task` one, another company's, a deleted one and a malformed id are 400 `{field: 'onboardingTemplateId'}`;
//      null clears it; GET settings answers `onboardingTemplate: {id, name} | null`, and a template deleted since reads as none.
//   2. THE GATES OF THE START (SCP-Q36). It needs `plan` AND `pm_project` · `manage`: an officer, a company admin and a Web Dev head are 403 `not_a_social_approver` (even with a bad body),
//      an automation 403 `automation_cannot_act`, a seat holder WITHOUT the project right is PM's own 403; the HoD, the owner and the superadmin (with it) start. Order: 404, 403, 400, 409.
//   3. THE 409s with their reasons: `no_project` (checked before the template), `onboarding_template_not_set`, then PM's `template_already_applied` with the first application's id.
//   4. THE START THROUGH PM'S APPLY: tasks due in working days from the kickoff on the company's holiday calendar (a golden table), the people by role (lead to the caller, officer and
//      client steps to the officer, the body's `people` winning), one transaction, the activity `onboarding_started` once; a replayed id answers 200 with the same ids and makes nothing.
//   5. THE READ. The clients still in draft and those with a task open, each with progress, the next step and its lateness, the kickoff, the checklist by phase, the baseline audit
//      (the client's draft, then its final one) and why a client cannot be started; a finished onboarding of an active client leaves the list; another company's client never appears.
//   6. THE KICKOFF MOVE and a TICK are PM's own routes: the move re-dates only the open steps and the read follows; a tick moves progress.
//
// THE GOLDEN DATES (company A's calendar: Monday to Friday, one holiday, Wednesday 2026-11-04). The template's offsets: 0, 1, 2, 5, 5.
//   kickoff Mon 2026-11-02: 0 → 11-02 · 1 → Tue 11-03 · 2 → Thu 11-05 (the 4th is a holiday) · 5 → Tue 11-10
//   kickoff Mon 2026-11-09 (the move): 0 → 11-09 · 1 → 11-10 · 2 → 11-11 · 5 → 11-16
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import { config } from "../../../config";
import { newId, withGlobal, withTenants } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";

const SVC = { authorization: "Bearer svc-token" };
const as = (id: string) => ({ ...SVC, "x-user-id": id });

const PAYLOAD = {
  title: "Mock social client onboarding",
  phases: [
    { key: "kickoff", title: "Mock kickoff" }, { key: "access", title: "Mock access" }, { key: "brand", title: "Mock brand inputs" },
    { key: "baseline", title: "Mock baseline audit" },
  ],
  roles: [{ key: "lead", label: "Lead" }, { key: "officer", label: "Officer" }, { key: "client", label: "Client" }],
  tasks: [
    { key: "meet", title: "Mock kickoff meeting held", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0 },
    { key: "group", title: "Mock chat group opened", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 1 },
    { key: "meta", title: "Mock partner access granted", phase: "access", role: "officer", dueOffsetWorkingDays: 2 },
    { key: "brand", title: "Mock brand files received", phase: "brand", role: "client", dueOffsetWorkingDays: 5 },
    { key: "audit", title: "Mock baseline audit finalized", phase: "baseline", role: "officer", dueOffsetWorkingDays: 5 },
  ],
};
const KEYS = PAYLOAD.tasks.map((t) => t.key);

interface Answer { applicationId: string; tasks: Array<{ key: string; taskId: string; dueDate: string }>; milestones: Array<{ phase: string; milestoneId: string; dueDate: string | null }> }
interface Step { key: string; taskId: string; title: string; phase: string; phaseTitle: string; role: string; roleLabel: string; dueDate: string | null; done: boolean; late: boolean }
interface Item {
  engagementId: string; clientId: string; clientName: string; engagementStatus: string; officer: { id: string; name: string } | null; projectId: string | null;
  applicationId: string | null; kickoff: string | null; progress: { done: number; total: number }; next: { taskId: string; title: string; dueDate: string | null; late: boolean } | null;
  baselineAudit: { auditId: string; status: string; overall: number | null } | null; steps: Step[]; doneStatusId: string | null; startBlock: string | null;
}
interface Listing { template: { id: string; name: string } | null; items: Item[]; canStart: boolean }
interface Eng { id: string; clientId: string; projectId: string | null; name: string }

describe.skipIf(!TEST_URL)("SCP-5h · client onboarding, Social's half (BFF §63.29)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  const U: Record<string, string> = {};
  let templateId: string;
  let seq = 0;

  const base = (t = A) => `/api/${t}/modules/social`;
  const get = (who: string, path: string, t = A) => app.inject({ method: "GET", url: `${base(t)}/${path}`, headers: as(U[who] ?? who) });
  const send = (method: "POST" | "PATCH" | "PUT", who: string, path: string, payload?: unknown, t = A) =>
    app.inject({ method, url: `${base(t)}/${path}`, headers: as(U[who] ?? who), ...(payload === undefined ? {} : { payload: payload as object }) });
  const pm = (method: "PATCH", who: string, path: string, payload: unknown, t = A) =>
    app.inject({ method, url: `/api/${t}/pm/${path}`, headers: as(U[who] ?? who), payload: payload as object });
  const start = (who: string, e: Eng | string, payload?: unknown, t = A) =>
    send("POST", who, `engagements/${typeof e === "string" ? e : e.id}/onboarding`, payload, t);
  const body = (over: Record<string, unknown> = {}) => ({ id: newId(), kickoff: "2026-11-02", ...over });
  const setTemplate = (who: string, id: string | null | undefined) => send("PUT", who, "settings", { onboardingTemplateId: id });
  const listing = async (who = "staff", t = A): Promise<Listing> => ok<Listing>(await get(who, "onboarding", t), 200, `${who} reads onboarding`);
  const itemOf = async (e: Eng): Promise<Item | undefined> => (await listing()).items.find((i) => i.engagementId === e.id);

  function ok<T = Record<string, unknown>>(r: LightMyRequestResponse, status: number, label: string): T {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json() as T;
  }
  function refused(r: LightMyRequestResponse, status: number, error: string, label: string, field?: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    expect(r.json().error, label).toBe(error);
    if (field !== undefined) expect(r.json().field, label).toBe(field);
  }
  function deniedGeneric(r: LightMyRequestResponse, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(403);
    expect(String(r.json().error), label).toMatch(/^not authorized/);
  }
  const count = async (sql: string, params: unknown[]) => Number((await adminPool().query(sql, params)).rows[0].n);
  const tasksOf = (projectId: string) => count(`SELECT count(*)::int AS n FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL`, [projectId]);
  const activities = async (engagementId: string): Promise<string[]> =>
    (await adminPool().query<{ verb: string }>(
      `SELECT verb FROM activities WHERE tenant_id = $1 AND target_entity_type = 'social_engagement' AND target_entity_id = $2 ORDER BY occurred_at, id`, [A, engagementId])).rows.map((r) => r.verb);

  interface EngOpts { status?: string; officer?: string | null; project?: boolean; tenant?: string }
  async function makeEngagement(label: string, o: EngOpts = {}): Promise<Eng> {
    const tenant = o.tenant ?? A;
    const name = `${label} ${++seq}`;
    const clientId = await createClient(tenant, name);
    const projectId = o.project === false ? null : await createProject(tenant, `${name} project`, U.hod);
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, owner_id, project_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, tenant, clientId, `${name} engagement`, o.status ?? "draft", o.officer === undefined ? U.officer : o.officer, projectId],
    );
    return { id, clientId, projectId, name };
  }
  const insertTemplate = async (tenant: string, kind: string, name: string, payload: unknown = PAYLOAD): Promise<string> => {
    const id = newId();
    await adminPool().query(`INSERT INTO pm_templates (id, tenant_id, kind, name, payload, origin_site) VALUES ($1, $2, $3, $4, $5, 'central')`, [id, tenant, kind, name, JSON.stringify(payload)]);
    return id;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("W5C4 Mock Agency", ["social", "pm", "hr"]);
    C = await createCompany("W5C4 Mock Other Co", ["social", "pm", "hr"]);
    const units = await seedSocialOrgTree(A);
    await seedSocialOrgTree(C);
    const people = ["officer", "otherOfficer", "hod", "gm", "owner", "platformAdmin", "companyAdmin", "webHead", "staff", "bot", "outsider"];
    for (const p of people) U[p] = await createUser(`w5c4-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of people.filter((x) => x !== "outsider")) await addMembership(A, U[p]);
    await addMembership(C, U.outsider);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));
    for (const p of ["officer", "otherOfficer", "hod", "gm", "owner", "webHead", "staff", "bot"]) await grantSocialRole(A, U[p], "social_staff");
    for (const p of ["officer", "otherOfficer", "bot"]) await grantSocialRole(A, U[p], "member");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantSocialSeat(A, units.webDev, U.webHead);
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialRole(C, U.outsider, "social_staff");
    // PM's right on a project (`manage`) is the manager's: the HoD, the owner and the Web Dev head hold it; the GM's seat deliberately does NOT (the "both" gate).
    for (const p of ["hod", "owner", "webHead"]) await grantSocialRole(A, U[p], "manager");

    // Company A's default holiday calendar: Wednesday 2026-11-04.
    await withTenants([A], async (c) => {
      const calId = newId();
      await c.query(`INSERT INTO hr_holiday_calendars (id, tenant_id, name, is_default) VALUES ($1, $2, 'Mock Calendar', true)`, [calId, A]);
      await c.query(`INSERT INTO hr_holidays (tenant_id, calendar_id, day, name, kind) VALUES ($1, $2, '2026-11-04'::date, 'Mock Holiday', 'public')`, [A, calId]);
    }, { modules: ["hr"] });

    templateId = await insertTemplate(A, "project", "Mock social client onboarding");
    app = await buildApp();
  }, 240_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) the setting
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("the company's onboarding template setting (63.29.2)", () => {
    it("reads as none before one is chosen, to the team's read tier", async () => {
      const r = ok<{ onboardingTemplate: unknown; canPlan: boolean }>(await get("staff", "settings"), 200, "staff reads settings");
      expect(r.onboardingTemplate).toBeNull();
      expect(r.canPlan).toBe(false);
      expect((await listing()).template).toBeNull();
    });

    it("an officer, a company admin and a Web Dev head are 403 `not_a_social_approver`, before the body is read", async () => {
      for (const who of ["officer", "companyAdmin", "webHead"]) {
        refused(await setTemplate(who, templateId), 403, "not_a_social_approver", `${who} sets it`);
        refused(await setTemplate(who, "not-a-uuid"), 403, "not_a_social_approver", `${who} with a bad body is still 403`);
      }
      expect((await adminPool().query(`SELECT onboarding_template_id FROM social_settings WHERE tenant_id = $1`, [A])).rows[0]?.onboarding_template_id ?? null).toBeNull();
    });

    it("must be a live `project` template of THIS company: a task one, another company's, a deleted one and a malformed id are 400, and nothing is written", async () => {
      const taskTpl = await insertTemplate(A, "task", "Mock task template", { title: "Mock" });
      const foreign = await insertTemplate(C, "project", "Mock foreign template");
      const deleted = await insertTemplate(A, "project", "Mock deleted template");
      await adminPool().query(`UPDATE pm_templates SET deleted_at = now() WHERE id = $1`, [deleted]);
      for (const [label, id] of [["a task template", taskTpl], ["another company's", foreign], ["a deleted one", deleted], ["an unknown id", newId()], ["a malformed id", "nope"], ["a number", 5 as unknown as string]] as const) {
        refused(await setTemplate("hod", id), 400, "invalid_field", label, "onboardingTemplateId");
      }
      expect((await adminPool().query(`SELECT count(*)::int AS n FROM social_settings WHERE tenant_id = $1 AND onboarding_template_id IS NOT NULL`, [A])).rows[0].n).toBe(0);
    });

    it("the four write it (the HoD), GET settings answers it, and the other two settings are untouched; null clears it", async () => {
      const set = ok<{ onboardingTemplate: { id: string; name: string } | null; bufferWorkingDays: number; boostCandidateFactor: number }>(await setTemplate("hod", templateId), 200, "hod sets it");
      expect(set.onboardingTemplate).toEqual({ id: templateId, name: "Mock social client onboarding" });
      expect(set.bufferWorkingDays).toBe(1);
      expect(set.boostCandidateFactor).toBe(1.25);
      expect(ok<{ onboardingTemplate: unknown }>(await get("staff", "settings"), 200, "read").onboardingTemplate).toEqual({ id: templateId, name: "Mock social client onboarding" });
      // a PUT of the buffer alone keeps the template
      ok(await send("PUT", "owner", "settings", { bufferWorkingDays: 2 }), 200, "owner sets the buffer");
      expect(ok<{ onboardingTemplate: unknown; bufferWorkingDays: number }>(await get("staff", "settings"), 200, "read").onboardingTemplate).toEqual({ id: templateId, name: "Mock social client onboarding" });
      ok(await send("PUT", "owner", "settings", { bufferWorkingDays: 1 }), 200, "owner puts the buffer back");
      expect(ok<{ onboardingTemplate: unknown }>(await setTemplate("gm", null), 200, "gm clears it").onboardingTemplate).toBeNull();
      expect((await listing()).template).toBeNull();
      ok(await setTemplate("hod", templateId), 200, "hod sets it again");
    });

    it("a template deleted since reads as none, on settings and on the list, and the start is 409 `onboarding_template_not_set`", async () => {
      const t2 = await insertTemplate(A, "project", "Mock second template");
      ok(await setTemplate("hod", t2), 200, "set the second");
      await adminPool().query(`UPDATE pm_templates SET deleted_at = now() WHERE id = $1`, [t2]);
      expect(ok<{ onboardingTemplate: unknown }>(await get("staff", "settings"), 200, "read").onboardingTemplate).toBeNull();
      expect((await listing()).template).toBeNull();
      const e = await makeEngagement("Deleted template");
      refused(await start("hod", e, body()), 409, "onboarding_template_not_set", "the start");
      expect(await tasksOf(e.projectId!)).toBe(0);
      ok(await setTemplate("hod", templateId), 200, "back to the first");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) and (3) the gates and the 409s
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("who may start it, and in what order it refuses (SCP-Q36)", () => {
    it("404 `engagement_not_found` first: unknown, another company's and malformed ids, even for a caller who may not start", async () => {
      const foreign = await makeEngagement("Foreign", { tenant: C, officer: null, project: false });
      for (const who of ["hod", "officer"]) {
        refused(await start(who, newId(), body()), 404, "engagement_not_found", `${who}: unknown`);
        refused(await start(who, foreign.id, body()), 404, "engagement_not_found", `${who}: another company's`);
        refused(await start(who, "nope", body()), 404, "engagement_not_found", `${who}: malformed`);
      }
    });

    it("an officer, a company admin, a Web Dev head and a staff member are 403 `not_a_social_approver`, whatever the body, and nothing is made", async () => {
      const e = await makeEngagement("Gate refused");
      for (const who of ["officer", "otherOfficer", "companyAdmin", "webHead", "staff"]) {
        refused(await start(who, e, body()), 403, "not_a_social_approver", `${who} starts`);
        refused(await start(who, e, { id: "bad", kickoff: "nonsense" }), 403, "not_a_social_approver", `${who} with a bad body is still 403`);
      }
      refused(await start("bot", e, body()), 403, "automation_cannot_act", "an automation");
      expect(await tasksOf(e.projectId!)).toBe(0);
      expect(await count(`SELECT count(*)::int AS n FROM pm_template_applications WHERE project_id = $1`, [e.projectId])).toBe(0);
    });

    it("a seat holder WITHOUT `pm_project` · manage is refused by PM's own gate: it takes both", async () => {
      const e = await makeEngagement("Needs both");
      deniedGeneric(await start("gm", e, body()), "the GM's seat has plan, not the project right");
      deniedGeneric(await start("gm", e, { id: "bad" }), "and a bad body is still 403");
      expect(await tasksOf(e.projectId!)).toBe(0);
    });

    it("the HoD, the owner and the superadmin start it; the application, tasks and activity are the caller's", async () => {
      for (const who of ["hod", "owner", "platformAdmin"]) {
        const e = await makeEngagement(`Start by ${who}`);
        const b = body();
        const a = ok<Answer>(await start(who, e, b), 201, `${who} starts`);
        expect(a.applicationId).toBe(b.id);
        expect(a.tasks.map((t) => t.key)).toEqual(KEYS);
        expect(await tasksOf(e.projectId!)).toBe(5);
        expect(await activities(e.id)).toEqual(["onboarding_started"]);
        const row = (await adminPool().query(`SELECT created_by FROM pm_template_applications WHERE id = $1`, [b.id])).rows[0];
        expect(row.created_by).toBe(U[who]);
      }
    });

    it("400 names the field, after the gates and before the 409s", async () => {
      const noProject = await makeEngagement("No project 400", { project: false });
      const e = await makeEngagement("Bad body");
      refused(await start("hod", e, { kickoff: "2026-11-02" }), 400, "invalid_field", "no id", "id");
      refused(await start("hod", e, { id: "nope", kickoff: "2026-11-02" }), 400, "invalid_field", "a bad id", "id");
      refused(await start("hod", e, { id: newId() }), 400, "invalid_field", "no kickoff", "kickoff");
      refused(await start("hod", e, { id: newId(), kickoff: "2026-02-30" }), 400, "invalid_field", "an impossible kickoff", "kickoff");
      refused(await start("hod", e, body({ people: [] })), 400, "invalid_field", "people as a list", "people");
      refused(await start("hod", e, body({ people: { lead: "x" } })), 400, "invalid_field", "a bad person", "people.lead");
      // a 400 comes before the 409 for a client with no project
      refused(await start("hod", noProject, { id: "bad", kickoff: "2026-11-02" }), 400, "invalid_field", "400 before no_project", "id");
      expect(await tasksOf(e.projectId!)).toBe(0);
    });

    it("409 `no_project` for a client with no project (checked before the template), and PM's refusals for a person who is not a member or a role the template lacks pass through", async () => {
      const noProject = await makeEngagement("No project", { project: false });
      refused(await start("hod", noProject, body()), 409, "no_project", "no project");
      const e = await makeEngagement("People refused");
      refused(await start("hod", e, body({ people: { lead: U.outsider } })), 400, "invalid_field", "a person of another company", "people.lead");
      refused(await start("hod", e, body({ people: { ghost: U.officer } })), 400, "invalid_field", "a role the template does not have", "people.ghost");
      expect(await tasksOf(e.projectId!)).toBe(0);
      expect(await count(`SELECT count(*)::int AS n FROM pm_template_applications WHERE project_id = $1`, [e.projectId])).toBe(0);
    });

    it("409 `onboarding_template_not_set` when the company chose none", async () => {
      ok(await setTemplate("hod", null), 200, "clear");
      const e = await makeEngagement("No template");
      const noProject = await makeEngagement("No template, no project", { project: false });
      refused(await start("hod", e, body()), 409, "onboarding_template_not_set", "no template");
      refused(await start("hod", noProject, body()), 409, "no_project", "the project comes first");
      const item = await itemOf(e);
      expect(item?.startBlock).toBe("onboarding_template_not_set");
      expect((await itemOf(noProject))?.startBlock).toBe("no_project");
      expect(await tasksOf(e.projectId!)).toBe(0);
      ok(await setTemplate("hod", templateId), 200, "restore");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) the start through PM's apply
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("the start applies the company's template through PM (63.29.1, 63.29.4)", () => {
    let e: Eng;
    let first: Answer;
    let appId: string;

    it("makes a task per step due in working days from the kickoff on the company's calendar (the golden table), and a milestone per phase", async () => {
      e = await makeEngagement("Golden", { status: "active" });
      appId = newId();
      first = ok<Answer>(await start("hod", e, { id: appId, kickoff: "2026-11-02" }), 201, "start");
      expect(first.applicationId).toBe(appId);
      expect(first.tasks.map((t) => [t.key, t.dueDate])).toEqual([["meet", "2026-11-02"], ["group", "2026-11-03"], ["meta", "2026-11-05"], ["brand", "2026-11-10"], ["audit", "2026-11-10"]]);
      expect(first.milestones.map((m) => [m.phase, m.dueDate])).toEqual([["kickoff", "2026-11-03"], ["access", "2026-11-05"], ["brand", "2026-11-10"], ["baseline", "2026-11-10"]]);
      expect(await tasksOf(e.projectId!)).toBe(5);
    });

    it("gives the lead steps to the caller, the officer and client steps to the engagement's officer", async () => {
      const rows = (await adminPool().query(`SELECT id, assignee FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL`, [e.projectId])).rows;
      const assignee = (key: string) => rows.find((r) => r.id === first.tasks.find((t) => t.key === key)!.taskId).assignee;
      expect(assignee("meet")).toMatchObject({ kind: "person", refId: U.hod, responsibleId: U.hod });
      expect(assignee("meta")).toMatchObject({ refId: U.officer, responsibleId: U.officer });
      expect(assignee("brand")).toMatchObject({ refId: U.officer }); // the client's step, chased by the officer
      expect(assignee("audit")).toMatchObject({ refId: U.officer });
    });

    it("the body's `people` wins, and a client with no officer leaves those steps unassigned", async () => {
      const named = await makeEngagement("Named people");
      const a = ok<Answer>(await start("hod", named, body({ people: { lead: U.otherOfficer, client: null } })), 201, "named");
      const rows = (await adminPool().query(`SELECT id, assignee FROM pm_tasks WHERE project_id = $1`, [named.projectId])).rows;
      const assignee = (key: string) => rows.find((r) => r.id === a.tasks.find((t) => t.key === key)!.taskId).assignee;
      expect(assignee("meet")).toMatchObject({ refId: U.otherOfficer });
      expect(assignee("brand")).toBeNull();
      expect(assignee("meta")).toMatchObject({ refId: U.officer });
      const noOfficer = await makeEngagement("No officer", { officer: null });
      const b = ok<Answer>(await start("hod", noOfficer, body()), 201, "no officer");
      const rows2 = (await adminPool().query(`SELECT id, assignee FROM pm_tasks WHERE project_id = $1`, [noOfficer.projectId])).rows;
      const assignee2 = (key: string) => rows2.find((r) => r.id === b.tasks.find((t) => t.key === key)!.taskId).assignee;
      expect(assignee2("meet")).toMatchObject({ refId: U.hod });
      expect(assignee2("meta")).toBeNull();
      expect(assignee2("brand")).toBeNull();
    });

    it("is idempotent: a replayed id answers 200 with the same ids and makes nothing; a NEW id is 409 `template_already_applied` naming the first application", async () => {
      const again = ok<Answer>(await start("hod", e, { id: appId, kickoff: "2026-11-02" }), 200, "replay");
      expect(again.applicationId).toBe(first.applicationId);
      expect(again.tasks.map((t) => t.taskId)).toEqual(first.tasks.map((t) => t.taskId));
      expect(await tasksOf(e.projectId!)).toBe(5);
      const second = await start("hod", e, body());
      refused(second, 409, "template_already_applied", "a new id");
      expect(second.json().detail).toEqual({ applicationId: appId });
      expect(await tasksOf(e.projectId!)).toBe(5);
      expect(await count(`SELECT count(*)::int AS n FROM pm_template_applications WHERE project_id = $1`, [e.projectId])).toBe(1);
    });

    it("writes the engagement's activity `onboarding_started` once, with the application and the kickoff", async () => {
      expect(await activities(e.id)).toEqual(["onboarding_started"]);
      const meta = (await adminPool().query(
        `SELECT metadata FROM activities WHERE tenant_id = $1 AND target_entity_type = 'social_engagement' AND target_entity_id = $2 AND verb = 'onboarding_started'`, [A, e.id])).rows[0].metadata;
      expect(meta).toMatchObject({ applicationId: appId, kickoff: "2026-11-02" });
    });

    it("two starts at once make one application", async () => {
      const racing = await makeEngagement("Racing");
      const rs = await Promise.all([start("hod", racing, body()), start("owner", racing, body())]);
      expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(await tasksOf(racing.projectId!)).toBe(5);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) and (6) the read, a tick and the kickoff move
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("the list: who is in onboarding, with what (63.29.4)", () => {
    let fresh: Eng; let noProject: Eng; let late: Eng; let finished: Eng; let ahead: Eng; let baseline: Eng;
    let lateApp: Answer; let aheadApp: Answer;

    beforeAll(async () => {
      fresh = await makeEngagement("List fresh", { status: "draft" });
      noProject = await makeEngagement("List no project", { status: "draft", project: false });
      late = await makeEngagement("List late", { status: "active" });
      ahead = await makeEngagement("List ahead", { status: "active" });
      finished = await makeEngagement("List finished", { status: "active" });
      baseline = await makeEngagement("List baseline", { status: "draft" });
      // kickoff long past: every step is due, none is done; kickoff far ahead: none is
      lateApp = ok<Answer>(await start("hod", late, { id: newId(), kickoff: "2026-01-05" }), 201, "start late");
      aheadApp = ok<Answer>(await start("hod", ahead, { id: newId(), kickoff: "2030-01-07" }), 201, "start ahead");
      ok<Answer>(await start("hod", finished, { id: newId(), kickoff: "2030-01-07" }), 201, "start finished");
    });

    it("is the team's to read: staff read it, an outsider and another company's reader do not, and only the four's `canStart` is true", async () => {
      expect((await listing("staff")).canStart).toBe(false);
      expect((await listing("hod")).canStart).toBe(true);
      expect((await listing("owner")).canStart).toBe(true);
      expect((await get("outsider", "onboarding")).statusCode).toBe(403);
      expect((await listing("outsider", C)).canStart).toBe(false);
    });

    it("lists the drafts (started or not) and the active clients with a task open, never another company's, with the template", async () => {
      const l = await listing();
      expect(l.template).toEqual({ id: templateId, name: "Mock social client onboarding" });
      const ids = l.items.map((i) => i.engagementId);
      for (const e of [fresh, noProject, late, ahead, baseline]) expect(ids, e.name).toContain(e.id);
      const foreign = await makeEngagement("Foreign draft", { tenant: C, project: false, officer: null });
      expect((await listing()).items.map((i) => i.engagementId)).not.toContain(foreign.id);
      const theirs = (await listing("outsider", C)).items.map((i) => i.engagementId);
      expect(theirs).toContain(foreign.id);
      for (const e of [fresh, late, ahead]) expect(theirs).not.toContain(e.id);
    });

    it("a client not started says why it cannot be, and shows no progress", async () => {
      const f = (await itemOf(fresh))!;
      expect(f).toMatchObject({ applicationId: null, kickoff: null, progress: { done: 0, total: 0 }, next: null, steps: [], startBlock: null, engagementStatus: "draft" });
      expect(f.officer).toEqual({ id: U.officer, name: "Mock officer" });
      expect(f.projectId).toBe(fresh.projectId);
      expect((await itemOf(noProject))).toMatchObject({ applicationId: null, projectId: null, startBlock: "no_project" });
    });

    it("a client mid-onboarding: progress, kickoff, the next step with its lateness and the checklist by phase", async () => {
      const i = (await itemOf(late))!;
      expect(i).toMatchObject({ applicationId: lateApp.applicationId, kickoff: "2026-01-05", progress: { done: 0, total: 5 }, startBlock: null, projectId: late.projectId });
      expect(i.next).toMatchObject({ title: "Mock kickoff meeting held", dueDate: "2026-01-05", late: true });
      expect(i.steps.map((s) => s.key)).toEqual(KEYS);
      expect(i.steps.filter((s) => s.late)).toHaveLength(5);
      expect(i.steps[0]).toMatchObject({ phase: "kickoff", phaseTitle: "Mock kickoff", role: "lead", roleLabel: "Lead", done: false, dueDate: "2026-01-05" });
      expect(i.steps[3]).toMatchObject({ phase: "brand", role: "client", roleLabel: "Client", dueDate: "2026-01-12" });
      expect(i.doneStatusId).toBe("done");
      const a = (await itemOf(ahead))!;
      expect(a.steps.filter((s) => s.late)).toHaveLength(0);
      expect(a.next).toMatchObject({ late: false, dueDate: "2030-01-07" });
      // the started clients come before the others, the soonest next step first
      const ids = (await listing()).items.map((x) => x.engagementId);
      expect(ids.indexOf(late.id)).toBeLessThan(ids.indexOf(ahead.id));
      expect(ids.indexOf(ahead.id)).toBeLessThan(ids.indexOf(fresh.id));
    });

    it("ticking a step is PM's own route and moves the progress, the next step and the late mark", async () => {
      const i = (await itemOf(late))!;
      const meet = i.steps.find((s) => s.key === "meet")!;
      ok(await pm("PATCH", "hod", `tasks/${meet.taskId}`, { status: i.doneStatusId }), 200, "the HoD ticks the first step");
      const after = (await itemOf(late))!;
      expect(after.progress).toEqual({ done: 1, total: 5 });
      expect(after.steps.find((s) => s.key === "meet")).toMatchObject({ done: true, late: false });
      expect(after.steps.filter((s) => s.late)).toHaveLength(4);
      expect(after.next).toMatchObject({ title: "Mock chat group opened", late: true });
    });

    it("the kickoff move is PM's own route (the manager's right on the project) and re-dates only the open steps", async () => {
      const i = (await itemOf(late))!;
      deniedGeneric(await pm("PATCH", "officer", `template-applications/${i.applicationId}`, { kickoff: "2026-11-09" }), "an officer may not move it");
      const moved = ok<{ kickoff: string }>(await pm("PATCH", "hod", `template-applications/${i.applicationId}`, { kickoff: "2026-11-09" }), 200, "the HoD moves it");
      expect(moved.kickoff).toBe("2026-11-09");
      const after = (await itemOf(late))!;
      expect(after.kickoff).toBe("2026-11-09");
      expect(after.steps.map((s) => [s.key, s.dueDate, s.done])).toEqual([
        ["meet", "2026-01-05", true], // done: never moved
        ["group", "2026-11-10", false], ["meta", "2026-11-11", false], ["brand", "2026-11-16", false], ["audit", "2026-11-16", false],
      ]);
      expect(after.steps.filter((s) => s.late)).toHaveLength(0);
      refused(await pm("PATCH", "hod", `template-applications/${newId()}`, { kickoff: "2026-11-09" }), 404, "application_not_found", "an unknown application");
    });

    it("the baseline audit link: none, then the client's draft, then its final audit (its overall)", async () => {
      expect((await itemOf(baseline))!.baselineAudit).toBeNull();
      const created = ok<{ audit: { id: string } }>(await send("POST", "hod", "audits", { subject: "client", engagementId: baseline.id }), 201, "the HoD opens the audit");
      expect((await itemOf(baseline))!.baselineAudit).toEqual({ auditId: created.audit.id, status: "draft", overall: null });
      ok(await send("PATCH", "hod", `audits/${created.audit.id}`, { scores: { profile: { score: 4, note: "" }, visual: { score: 3, note: "" } } }), 200, "typed scores");
      const fin = ok<{ audit: { overall: number | null } }>(await send("POST", "hod", `audits/${created.audit.id}/finalize`, {}), 200, "finalize");
      const link = (await itemOf(baseline))!.baselineAudit!;
      expect(link).toMatchObject({ auditId: created.audit.id, status: "final" });
      expect(link.overall).toBe(fin.audit.overall);
      expect(link.overall).not.toBeNull();
    });

    it("a finished onboarding of an ACTIVE client leaves the list; a finished one of a DRAFT client stays, whole", async () => {
      const i = (await itemOf(finished))!;
      expect(i).toBeDefined();
      for (const s of i.steps) ok(await pm("PATCH", "hod", `tasks/${s.taskId}`, { status: i.doneStatusId }), 200, `tick ${s.key}`);
      expect((await itemOf(finished))).toBeUndefined();
      // a draft client that finished stays (it is still a draft), as 100%, never as "not started"
      const draftDone = await makeEngagement("List draft done", { status: "draft" });
      ok<Answer>(await start("hod", draftDone, body({ kickoff: "2030-01-07" })), 201, "start");
      const d = (await itemOf(draftDone))!;
      for (const s of d.steps) ok(await pm("PATCH", "hod", `tasks/${s.taskId}`, { status: d.doneStatusId }), 200, `tick ${s.key}`);
      const after = (await itemOf(draftDone))!;
      expect(after).toMatchObject({ progress: { done: 5, total: 5 }, next: null, startBlock: null });
      expect(after.applicationId).not.toBeNull();
    });

    it("the started client's list entry is the same for every reader (the answer holds no per-reader data but `canStart`)", async () => {
      const a = (await listing("staff")).items;
      const b = (await listing("hod")).items;
      expect(a).toEqual(b);
    });
  });
});
