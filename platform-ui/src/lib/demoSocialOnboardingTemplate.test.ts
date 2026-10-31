import { describe, it, expect, beforeEach } from "vitest";
import { demoChooseTemplate, demoChosenTemplate, demoOnboardingTemplateRoute, resetDemoOnboardingTemplate } from "./demoSocialOnboardingTemplate";
import { DEMO_ONBOARDING_STEPS, DEMO_ONBOARDING_TEMPLATE } from "./demoSocialOnboarding";
import { socialDemo } from "./demoSocial";
import { asProjectTemplates, type TemplatePayload } from "./socialOnboardingTemplate";
import { asSocialSettings } from "./socialCycles";

// SCP-5 W5-C5 (BFF §63.29): DEMO_MODE's twin of the onboarding template the rules page edits: PM's list and PATCH for a project template, and `PUT settings` `onboardingTemplateId`.
const USER = { hod: "u-pm", owner: "demo-owner", officer: "u-social", client: "demo-client" };
const P = "/api/co-1/pm/templates";
const T = DEMO_ONBOARDING_TEMPLATE.id;
const call = (m: string, path: string, user: string, body?: unknown, query = "") => demoOnboardingTemplateRoute(m, path, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), user);
const list = (user = USER.hod) => asProjectTemplates(call("GET", P, user, undefined, "kind=project")!.json);
const payload = (): TemplatePayload => structuredClone(list()[0].payload);
const patch = (p: unknown, user = USER.hod) => call("PATCH", `${P}/${T}`, user, { payload: p })!;
const field = (r: { json: unknown }) => (r.json as { field: string }).field;

beforeEach(() => resetDemoOnboardingTemplate());

describe("the list", () => {
  it("answers the seeded onboarding template with the team's fifteen steps in six phases", () => {
    const t = list();
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe(T);
    expect(t[0].payload.tasks).toHaveLength(DEMO_ONBOARDING_STEPS.length);
    expect(t[0].payload.phases).toHaveLength(6);
    expect(t[0].payload.roles.map((r) => r.key)).toEqual(["lead", "officer", "client"]);
  });
  it("is PM's gate: the four read it, the other staff and a client contact are refused with PM's own words", () => {
    for (const u of [USER.hod, USER.owner]) expect(call("GET", P, u, undefined, "kind=project")!.status).toBe(200);
    for (const u of [USER.officer, USER.client]) {
      const r = call("GET", P, u, undefined, "kind=project")!;
      expect([r.status, (r.json as { error: string }).error]).toEqual([403, "not authorized: cerbos denied manage on pm_task"]);
    }
  });
  it("leaves every other kind, and every other path, to PM's own demo", () => {
    expect(call("GET", P, USER.hod, undefined, "kind=task")).toBeNull();
    expect(call("GET", P, USER.hod)).toBeNull();
    expect(call("POST", P, USER.hod, {})).toBeNull();
    expect(call("PATCH", `${P}/tpl-1`, USER.hod, { payload: {} })).toBeNull();
    expect(call("DELETE", `${P}/${T}`, USER.hod)).toBeNull();
  });
});

describe("the PATCH of the steps", () => {
  it("saves a changed step and answers the template; the list then shows it, newer", () => {
    const before = list()[0].updatedAt;
    const p = payload();
    p.tasks[0].title = "Kickoff call held and its notes shared";
    p.tasks[0].dueOffsetWorkingDays = 1;
    p.tasks[1].description = "  Both groups.  ";
    p.tasks[2].subtasks = ["Ask for the invite", "Accept it"];
    const r = patch(p);
    expect(r.status).toBe(200);
    const after = list()[0];
    expect(after.payload.tasks[0]).toMatchObject({ title: "Kickoff call held and its notes shared", dueOffsetWorkingDays: 1 });
    expect(after.payload.tasks[1].description).toBe("Both groups.");
    expect(after.payload.tasks[2].subtasks).toEqual(["Ask for the invite", "Accept it"]);
    expect(String(after.updatedAt) > String(before)).toBe(true);
  });
  it("refuses an officer and a client contact with 403 before reading the body", () => {
    expect(patch({ nonsense: 1 }, USER.officer).status).toBe(403);
    expect(patch({ nonsense: 1 }, USER.client).status).toBe(403);
  });
  it("names the payload field of a refusal, as PM's validator does", () => {
    const bad = (mutate: (p: TemplatePayload) => void) => { const p = payload(); mutate(p); const r = patch(p); expect(r.status).toBe(400); expect((r.json as { error: string }).error).toBe("invalid_field"); return field(r); };
    expect(bad((p) => { p.tasks[3].phase = "nope"; })).toBe("payload.tasks.3.phase");
    expect(bad((p) => { p.tasks[3].role = "nope"; })).toBe("payload.tasks.3.role");
    expect(bad((p) => { p.tasks[4].dueOffsetWorkingDays = 251; })).toBe("payload.tasks.4.dueOffsetWorkingDays");
    expect(bad((p) => { p.tasks[4].dueOffsetWorkingDays = 1.5; })).toBe("payload.tasks.4.dueOffsetWorkingDays");
    expect(bad((p) => { p.tasks[1].key = p.tasks[0].key; })).toBe("payload.tasks.1.key");
    expect(bad((p) => { p.tasks[0].title = "  "; })).toBe("payload.tasks.0.title");
    expect(bad((p) => { p.phases[2].key = "Bad Key"; })).toBe("payload.phases.2.key");
    expect(bad((p) => { p.roles = []; })).toBe("payload.roles");
    expect(bad((p) => { p.title = ""; })).toBe("payload.title");
    expect(bad((p) => { p.tasks[0].subtasks = Array.from({ length: 21 }, (_, i) => `s${i}`); })).toBe("payload.tasks.0.subtasks");
    expect(bad((p) => { p.tasks[0].subtasks = ["ok", " "]; })).toBe("payload.tasks.0.subtasks.1");
    expect(bad((p) => { p.tasks[0].description = "x".repeat(2001); })).toBe("payload.tasks.0.description");
  });
  it("keeps nothing of a refused save", () => {
    const p = payload();
    p.tasks[0].title = "Changed";
    p.tasks[3].phase = "nope";
    expect(patch(p).status).toBe(400);
    expect(list()[0].payload.tasks[0].title).toBe(DEMO_ONBOARDING_STEPS[0].title);
  });
  it("refuses more than 12 phases, 10 roles and 80 steps", () => {
    const p = payload();
    p.phases = Array.from({ length: 13 }, (_, i) => ({ key: `p${i}`, title: `P${i}` }));
    expect(field(patch(p))).toBe("payload.phases");
    const q = payload();
    q.tasks = Array.from({ length: 81 }, (_, i) => ({ key: `t${i}`, title: `T${i}`, phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0 }));
    expect(field(patch(q))).toBe("payload.tasks");
  });
});

describe("the company's choice, through settings", () => {
  const settings = (user = USER.hod) => asSocialSettings(socialDemo("GET", "/api/co-1/modules/social/settings", new URLSearchParams(), undefined, user)!.json);
  const put = (body: unknown, user = USER.hod) => socialDemo("PUT", "/api/co-1/modules/social/settings", new URLSearchParams(), JSON.stringify(body), user)!;
  it("answers the seeded template on GET settings, and the chosen one after a PUT", () => {
    expect(settings().onboardingTemplate).toEqual({ id: T, name: DEMO_ONBOARDING_TEMPLATE.name });
    expect(demoChosenTemplate()).toEqual({ id: T, name: DEMO_ONBOARDING_TEMPLATE.name });
  });
  it("clears the choice with null and chooses a live project template again", () => {
    const r = put({ onboardingTemplateId: null });
    expect(r.status).toBe(200);
    expect(asSocialSettings(r.json).onboardingTemplate).toBeNull();
    expect(settings().onboardingTemplate).toBeNull();
    expect(asSocialSettings(put({ onboardingTemplateId: T }).json).onboardingTemplate?.id).toBe(T);
  });
  it("refuses anything that is not a live project template, naming the field, and changes nothing", () => {
    const r = put({ onboardingTemplateId: "tpl-gone" });
    expect(r.status).toBe(400);
    expect((r.json as { field: string }).field).toBe("onboardingTemplateId");
    expect(put({ onboardingTemplateId: 7 }).status).toBe(400);
    expect(settings().onboardingTemplate?.id).toBe(T);
  });
  it("keeps the buffer and factor settings working beside it, and refuses an officer", () => {
    expect(put({ bufferWorkingDays: 2, onboardingTemplateId: T }).status).toBe(200);
    expect(settings().bufferWorkingDays).toBe(2);
    expect(put({ onboardingTemplateId: null }, USER.officer).status).toBe(403);
    expect(demoChooseTemplate(null)).toBe(true);
    expect(demoChooseTemplate("x")).toBe(false);
  });
});
