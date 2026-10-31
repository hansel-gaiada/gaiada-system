import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// SCP-5h (BFF §63.29): DEMO_MODE's twin of client onboarding, in the server's order of checks. The store seeds from the day it is first touched, so the clock is pinned to Friday 16 October
// 2026 before the module is imported (hence vi.hoisted); only Date is faked. Every test starts from a fresh seed.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import {
  DEMO_ONBOARDING_PHASES, DEMO_ONBOARDING_STEPS, DEMO_ONBOARDING_TEMPLATE, demoDueDate, demoOnboarding, demoOnboardingPmRoute, demoOnboardingRoute, resetDemoOnboarding,
} from "./demoSocialOnboarding";
import { socialDemo } from "./demoSocial";
import { demoChooseTemplate, demoOnboardingTemplateRoute, resetDemoOnboardingTemplate } from "./demoSocialOnboardingTemplate";
import { getDemoResponse } from "./demoFixtures";
import { asOnboarding, groupByPhase } from "./socialOnboarding";

const USER = { officer: "u-social", hod: "u-pm", gm: "u-gm", owner: "demo-owner", superadmin: "demo-hansel", client: "demo-client" };
const [LARKSPUR, TIDEWATER] = ["onb-eng-1", "onb-eng-2"];
const NEW_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => { resetDemoOnboarding(); resetDemoOnboardingTemplate(); vi.setSystemTime(new Date("2026-10-16T04:00:00Z")); });

const call = (m: string, tail: string, user: string, body?: unknown) => {
  const r = demoOnboardingRoute(m, tail, body === undefined ? undefined : JSON.stringify(body), user);
  expect(r, `${m} ${tail} is an onboarding route`).not.toBeNull();
  return r!;
};
const pmCall = (m: string, path: string, user: string, body?: unknown) => demoOnboardingPmRoute(m, path, body === undefined ? undefined : JSON.stringify(body), user);
const error = (r: { json: unknown }) => (r.json as { error: string }).error;
const refused = (r: { status: number; json: unknown }, status: number, code: string) => { expect([r.status, error(r)]).toEqual([status, code]); };
const listing = (user = USER.hod) => asOnboarding(call("GET", "onboarding", user).json);
const larkspur = () => listing().items.find((i) => i.engagementId === LARKSPUR)!;
const tidewater = () => listing().items.find((i) => i.engagementId === TIDEWATER)!;

describe("the seeded template", () => {
  it("is the team's fifteen steps in six phases, reworded, with the lead, officer and client roles", () => {
    expect(DEMO_ONBOARDING_TEMPLATE.name).toBe("Social media client onboarding");
    expect(DEMO_ONBOARDING_STEPS).toHaveLength(15);
    expect(DEMO_ONBOARDING_PHASES.map((p) => p.title)).toEqual(["Kickoff", "Access", "Brand inputs", "Baseline audit", "Strategy", "First cycle"]);
    expect(new Set(DEMO_ONBOARDING_STEPS.map((s) => s.role))).toEqual(new Set(["lead", "officer", "client"]));
    expect(new Set(DEMO_ONBOARDING_STEPS.map((s) => s.phase))).toEqual(new Set(DEMO_ONBOARDING_PHASES.map((p) => p.key)));
    // the seeded offsets of 63.29.3: kickoff 0, access 2, brand inputs 5, baseline 8, strategy 10, first cycle 15 to 20
    expect(DEMO_ONBOARDING_STEPS.find((s) => s.key === "audit")!.offset).toBe(8);
    expect(Math.min(...DEMO_ONBOARDING_STEPS.filter((s) => s.phase === "first").map((s) => s.offset))).toBe(15);
    expect(Math.max(...DEMO_ONBOARDING_STEPS.map((s) => s.offset))).toBe(20);
  });
  it("keeps the repo public: no real names in the demo's template or clients", () => {
    const text = JSON.stringify([DEMO_ONBOARDING_STEPS, DEMO_ONBOARDING_PHASES, demoOnboarding(USER.hod)]);
    expect(text).not.toMatch(/repsona|gaiada|bimc|cosmedic/i);
  });
});

describe("the working-day maths", () => {
  it("counts Monday to Friday from the kickoff, and from the next working day when the kickoff is a day off", () => {
    expect(demoDueDate("2026-11-02", 0)).toBe("2026-11-02");
    expect(demoDueDate("2026-11-02", 5)).toBe("2026-11-09");
    expect(demoDueDate("2026-11-07", 0)).toBe("2026-11-09"); // a Saturday
    expect(demoDueDate("2026-11-07", 1)).toBe("2026-11-10");
    expect(demoDueDate("2026-12-31", 2)).toBe("2027-01-04"); // the year turn, over a weekend
  });
});

describe("the page's data", () => {
  it("has one client mid-onboarding with two late steps and one not started", () => {
    const o = listing();
    expect(o.template).toEqual(DEMO_ONBOARDING_TEMPLATE);
    expect(o.items.map((i) => i.clientName)).toEqual(["Larkspur Bakery", "Tidewater Surf School"]); // started first
    const l = larkspur();
    expect(l).toMatchObject({ applicationId: "onb-app-1", progress: { done: 5, total: 15 }, startBlock: null, baselineAudit: null, doneStatusId: "done" });
    expect(l.steps.filter((s) => s.late).map((s) => s.key)).toEqual(["logo", "library"]);
    expect(l.steps.filter((s) => s.done).map((s) => s.key)).toEqual(["meet", "chat", "meta", "networks", "folder"]);
    expect(l.next).toMatchObject({ title: "Logo, fonts and brand guide received", late: true });
    expect(l.officer?.name).toBe("Komang Lestari");
    expect(groupByPhase(l.steps).map((p) => [p.title, p.steps.length])).toEqual([["Kickoff", 2], ["Access", 3], ["Brand inputs", 3], ["Baseline audit", 1], ["Strategy", 3], ["First cycle", 3]]);
    expect(tidewater()).toMatchObject({ applicationId: null, kickoff: null, progress: { done: 0, total: 0 }, steps: [], next: null, startBlock: null });
  });
  it("has the same two late steps on every day of the week, weekends included (the kickoff is placed from today)", () => {
    for (let d = 0; d < 14; d++) {
      resetDemoOnboarding();
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 12 + d, 4)));
      expect(larkspur().steps.filter((s) => s.late).map((s) => s.key), `day ${d}`).toEqual(["logo", "library"]);
      expect(larkspur().steps.filter((s) => !s.done && !s.late).length, `day ${d}`).toBe(8);
    }
  });
  it("tells the four they can start and everyone else they cannot, and refuses a client contact the read", () => {
    for (const u of [USER.hod, USER.gm, USER.owner, USER.superadmin]) expect(listing(u).canStart, u).toBe(true);
    expect(listing(USER.officer).canStart).toBe(false);
    expect(call("GET", "onboarding", USER.client).status).toBe(403);
  });
  it("is served by the social router and by the generic demo dispatcher alike", () => {
    const r = socialDemo("GET", "/api/co-agency/modules/social/onboarding", new URLSearchParams(), undefined, USER.hod);
    expect(r?.status).toBe(200);
    expect(asOnboarding(r!.json).items).toHaveLength(2);
    const t = larkspur().steps.find((s) => s.key === "logo")!;
    const viaFixtures = getDemoResponse("PATCH", `/api/co-agency/pm/tasks/${t.taskId}`, USER.hod, JSON.stringify({ status: "done" }));
    expect(viaFixtures.status).toBe(200);
    expect(larkspur().progress.done).toBe(6);
  });
});

describe("starting onboarding, in the server's order of checks", () => {
  const start = (user: string, eng: string, body: unknown) => call("POST", `engagements/${eng}/onboarding`, user, body);
  it("404 first, then 403 for everyone but the four, whatever the body", () => {
    refused(start(USER.hod, "nope", { id: NEW_ID, kickoff: "2026-11-02" }), 404, "engagement_not_found");
    refused(start(USER.officer, "nope", { id: NEW_ID, kickoff: "2026-11-02" }), 404, "engagement_not_found");
    refused(start(USER.officer, TIDEWATER, { id: NEW_ID, kickoff: "2026-11-02" }), 403, "not_a_social_approver");
    refused(start(USER.officer, TIDEWATER, {}), 403, "not_a_social_approver");
    expect(tidewater().applicationId).toBeNull();
  });
  it("400 names the field", () => {
    expect(start(USER.hod, TIDEWATER, { kickoff: "2026-11-02" }).json).toMatchObject({ error: "invalid_field", field: "id" });
    expect(start(USER.hod, TIDEWATER, { id: NEW_ID }).json).toMatchObject({ error: "invalid_field", field: "kickoff" });
    expect(start(USER.hod, TIDEWATER, { id: NEW_ID, kickoff: "2026-02-30" }).json).toMatchObject({ error: "invalid_field", field: "kickoff" });
  });
  it("makes the fifteen tasks, due in working days from the kickoff, and the client then reads as started", () => {
    const r = start(USER.hod, TIDEWATER, { id: NEW_ID, kickoff: "2026-11-02" });
    expect(r.status).toBe(201);
    const a = r.json as { applicationId: string; tasks: Array<{ key: string; dueDate: string }> };
    expect(a.applicationId).toBe(NEW_ID);
    expect(a.tasks).toHaveLength(15);
    expect(a.tasks.find((t) => t.key === "audit")!.dueDate).toBe("2026-11-12");
    expect(a.tasks.find((t) => t.key === "scheduled")!.dueDate).toBe("2026-11-30");
    expect(tidewater()).toMatchObject({ applicationId: NEW_ID, kickoff: "2026-11-02", progress: { done: 0, total: 15 } });
  });
  it("is idempotent on the id (200, the same ids) and refuses a second application (409, naming the first)", () => {
    const first = start(USER.owner, TIDEWATER, { id: NEW_ID, kickoff: "2026-11-02" }).json as { tasks: unknown[] };
    const again = start(USER.owner, TIDEWATER, { id: NEW_ID, kickoff: "2026-11-02" });
    expect(again.status).toBe(200);
    expect((again.json as { tasks: unknown[] }).tasks).toEqual(first.tasks);
    const other = start(USER.owner, TIDEWATER, { id: "22222222-2222-4222-8222-222222222222", kickoff: "2026-11-02" });
    refused(other, 409, "template_already_applied");
    expect(other.json).toMatchObject({ detail: { applicationId: NEW_ID } });
    refused(start(USER.owner, LARKSPUR, { id: "33333333-3333-4333-8333-333333333333", kickoff: "2026-11-02" }), 409, "template_already_applied");
  });
});

describe("a tick and the kickoff move are PM's own routes", () => {
  it("a tick closes the task: the progress and the next step move; a client contact may not", () => {
    const logo = larkspur().steps.find((s) => s.key === "logo")!;
    expect(pmCall("PATCH", `/api/co-agency/pm/tasks/${logo.taskId}`, USER.client, { status: "done" })?.status).toBe(403);
    expect(pmCall("PATCH", `/api/co-agency/pm/tasks/${logo.taskId}`, USER.officer, { status: "done" })?.status).toBe(200);
    const l = larkspur();
    expect(l.progress.done).toBe(6);
    expect(l.steps.filter((s) => s.late).map((s) => s.key)).toEqual(["library"]);
    expect(l.next?.title).toMatch(/Photo and video library/);
  });
  it("answers null for a task or application that is not onboarding's, so PM's own demo answers", () => {
    expect(pmCall("PATCH", "/api/co-agency/pm/tasks/t-123", USER.hod, { status: "done" })).toBeNull();
    expect(pmCall("PATCH", "/api/co-agency/pm/template-applications/other", USER.hod, { kickoff: "2026-11-02" })).toBeNull();
    expect(pmCall("GET", "/api/co-agency/pm/tasks/onb-t-x", USER.hod)).toBeNull();
  });
  it("the kickoff move re-dates the open steps and never a done one; only the four", () => {
    const before = larkspur();
    const doneDue = before.steps.filter((s) => s.done).map((s) => s.dueDate);
    expect(pmCall("PATCH", "/api/co-agency/pm/template-applications/onb-app-1", USER.officer, { kickoff: "2026-11-09" })?.status).toBe(403);
    expect(pmCall("PATCH", "/api/co-agency/pm/template-applications/onb-app-1", USER.hod, { kickoff: "2026-02-30" })?.json).toMatchObject({ field: "kickoff" });
    expect(pmCall("PATCH", "/api/co-agency/pm/template-applications/onb-app-1", USER.hod, { kickoff: "2026-11-09" })?.status).toBe(200);
    const after = larkspur();
    expect(after.kickoff).toBe("2026-11-09");
    expect(after.steps.filter((s) => s.done).map((s) => s.dueDate)).toEqual(doneDue);
    expect(after.steps.find((s) => s.key === "logo")!.dueDate).toBe("2026-11-16");
    expect(after.steps.filter((s) => s.late)).toEqual([]);
  });
});

describe("Open baseline audit", () => {
  it("creates the client's audit once and then answers it; another client's audit is not this demo's", () => {
    const first = call("POST", "audits", USER.hod, { subject: "client", engagementId: LARKSPUR });
    expect([first.status, (first.json as { created: boolean }).created]).toEqual([201, true]);
    const id = (first.json as { audit: { id: string } }).audit.id;
    const second = call("POST", "audits", USER.hod, { subject: "client", engagementId: LARKSPUR });
    expect([second.status, (second.json as { audit: { id: string }; created: boolean }).audit.id, (second.json as { created: boolean }).created]).toEqual([200, id, false]);
    expect(larkspur().baselineAudit).toEqual({ auditId: id, status: "draft", overall: null });
    expect(demoOnboardingRoute("POST", "audits", JSON.stringify({ subject: "client", engagementId: "soc-eng-1" }), USER.hod)).toBeNull();
  });
});

describe("GET onboarding follows the template chosen in Settings", () => {
  it("with none chosen: template null, no application listed, every client with a project blocked by onboarding_template_not_set, and a start is refused", () => {
    expect(demoChooseTemplate(null)).toBe(true);
    const l = listing();
    expect(l.template).toBeNull();
    expect(l.items.every((i) => i.applicationId === null && i.steps.length === 0 && i.startBlock === "onboarding_template_not_set")).toBe(true);
    refused(call("POST", `engagements/${TIDEWATER}/onboarding`, USER.hod, { id: NEW_ID, kickoff: "2026-10-19" }), 409, "onboarding_template_not_set");
    expect(demoChooseTemplate(DEMO_ONBOARDING_TEMPLATE.id)).toBe(true);
    expect(larkspur().progress).toEqual({ done: 5, total: 15 }); // choosing it again brings the running onboarding back
  });
  it("a start copies the chosen template's steps as edited; a running onboarding keeps its own copy", () => {
    const T = `/api/co-1/pm/templates/${DEMO_ONBOARDING_TEMPLATE.id}`;
    const list_ = demoOnboardingTemplateRoute("GET", "/api/co-1/pm/templates", new URLSearchParams("kind=project"), undefined, USER.hod)!.json as Array<{ payload: { tasks: Array<{ title: string }> } }>;
    const payload = structuredClone(list_[0].payload);
    payload.tasks[0].title = "Kickoff call held";
    expect(demoOnboardingTemplateRoute("PATCH", T, new URLSearchParams(), JSON.stringify({ payload }), USER.hod)!.status).toBe(200);
    expect(call("POST", `engagements/${TIDEWATER}/onboarding`, USER.hod, { id: NEW_ID, kickoff: "2026-10-19" }).status).toBe(201);
    expect(tidewater().steps[0].title).toBe("Kickoff call held");
    expect(larkspur().steps[0].title).toBe(DEMO_ONBOARDING_STEPS[0].title);
    expect(listing().template).toEqual(DEMO_ONBOARDING_TEMPLATE);
  });
});
