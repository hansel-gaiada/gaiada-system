import { describe, it, expect } from "vitest";
import { REFUSAL_WORDS } from "./socialPipeline";
import { PLAN_REFUSAL_REASON, asSocialSettings } from "./socialCycles";
import {
  asPayload, asProjectTemplates, newPhase, newRole, newTask, offsetWords, payloadFieldWords, phaseInUse, roleInUse, tasksByPhase, templateBody, templateRefusalText, type TemplatePayload,
} from "./socialOnboardingTemplate";

// SCP-5 W5-C5 (BFF §63.29): the onboarding template as the rules page reads, builds and words it.
const payload = (): TemplatePayload => ({
  title: "Client onboarding",
  phases: [{ key: "kickoff", title: "Kickoff" }, { key: "access", title: "Access" }],
  roles: [{ key: "lead", label: "Lead" }, { key: "officer", label: "Officer" }],
  tasks: [
    { key: "meet", title: "Kickoff meeting", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0 },
    { key: "meta", title: "Partner access", phase: "access", role: "officer", dueOffsetWorkingDays: 2, description: "Meta business tools", subtasks: ["Ask for the invite", "Accept it"] },
    { key: "chat", title: "Chat group", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0 },
  ],
});

describe("the settings answer carries the company's template", () => {
  const base = { bufferWorkingDays: 1, boostCandidateFactor: 1.25, holidayCalendar: { known: false, name: null }, canPlan: true };
  it("reads the chosen template, and none as null", () => {
    expect(asSocialSettings({ ...base, onboardingTemplate: { id: "t1", name: "Client onboarding" } }).onboardingTemplate).toEqual({ id: "t1", name: "Client onboarding" });
    expect(asSocialSettings({ ...base, onboardingTemplate: null }).onboardingTemplate).toBeNull();
    expect(asSocialSettings(base).onboardingTemplate).toBeNull();
    expect(asSocialSettings({ ...base, onboardingTemplate: { name: "x" } }).onboardingTemplate).toBeNull();
  });
});

describe("the parsers", () => {
  it("reads a project template's payload", () => {
    const t = asProjectTemplates([{ id: "t1", kind: "project", name: "Client onboarding", updatedAt: "2026-10-30T09:00:00.000Z", payload: payload() }]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ id: "t1", name: "Client onboarding", updatedAt: "2026-10-30T09:00:00.000Z" });
    expect(t[0].payload.tasks[1]).toEqual(payload().tasks[1]);
  });
  it("keeps only project templates, and names an unnamed one", () => {
    expect(asProjectTemplates([{ id: "a", kind: "task", name: "Bug" }, { id: "b", kind: "project" }, { name: "no id" }]).map((t) => [t.id, t.name])).toEqual([["b", "Untitled template"]]);
  });
  it("throws on a body that is not a list, so the page says it cannot tell", () => {
    expect(() => asProjectTemplates({})).toThrow();
    expect(() => asProjectTemplates(null)).toThrow();
  });
  it("reads a thin payload without throwing, as empty lists", () => {
    expect(asPayload(null)).toEqual({ title: "", phases: [], roles: [], tasks: [] });
    expect(asPayload({ tasks: [{ key: "a", title: "A", phase: "p", role: "r" }] }).tasks[0].dueOffsetWorkingDays).toBe(0);
  });
});

describe("the body of the PATCH", () => {
  it("sends the payload alone, with an empty description and blank sub-steps left out", () => {
    const p = payload();
    p.tasks[0].description = "   ";
    p.tasks[1].subtasks = ["Ask for the invite", "", "  ", "Accept it"];
    p.tasks[2].subtasks = [];
    const b = templateBody(p);
    expect(Object.keys(b)).toEqual(["payload"]);
    expect(b.payload.tasks[0]).toEqual({ key: "meet", title: "Kickoff meeting", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0 });
    expect(b.payload.tasks[1].subtasks).toEqual(["Ask for the invite", "Accept it"]);
    expect(b.payload.tasks[2]).not.toHaveProperty("subtasks");
    expect(b.payload.title).toBe("Client onboarding");
  });
});

describe("the lists' helpers", () => {
  it("builds new items with a free key, and a step in the first phase and role", () => {
    const p = payload();
    expect(newPhase(p.phases.map((x) => x.key)).key).toBe("phase");
    expect(newRole(["role"]).key).toBe("role_2");
    expect(newTask(p)).toEqual({ key: "step", title: "New step", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0 });
  });
  it("groups the steps by phase in the template's phase order, keeping each step's place in the list", () => {
    const g = tasksByPhase(payload());
    expect(g.map((x) => x.phase.key)).toEqual(["kickoff", "access"]);
    expect(g[0].tasks.map((t) => [t.task.key, t.index])).toEqual([["meet", 0], ["chat", 2]]);
    expect(g[1].tasks.map((t) => t.index)).toEqual([1]);
  });
  it("knows a phase or a role a step still uses", () => {
    const p = payload();
    expect(phaseInUse(p, "access")).toBe(true);
    expect(roleInUse(p, "officer")).toBe(true);
    expect(phaseInUse(p, "nope")).toBe(false);
    p.tasks = p.tasks.filter((t) => t.phase !== "access");
    expect(phaseInUse(p, "access")).toBe(false);
  });
  it("words an offset", () => {
    expect(offsetWords(0)).toBe("On the kickoff day");
    expect(offsetWords(1)).toBe("1 working day after the kickoff");
    expect(offsetWords(5)).toBe("5 working days after the kickoff");
  });
});

describe("the words for a refusal", () => {
  const r = (error: string, status: number, field?: string) => ({ status, error, ...(field ? { field } : {}) });
  it("names a refused payload field in words, with the rule where it helps", () => {
    expect(payloadFieldWords("payload.tasks.3.phase")).toBe("Step 4, the phase");
    expect(payloadFieldWords("payload.tasks.0.subtasks.1")).toBe("Step 1, sub-step 2");
    expect(payloadFieldWords("payload.title")).toBe("The title");
    expect(templateRefusalText(r("invalid_field", 400, "payload.tasks.3.dueOffsetWorkingDays"), "save")).toBe("Step 4, the working days after the kickoff is not valid. Use a whole number of working days from 0 to 250.");
    expect(templateRefusalText(r("invalid_field", 400, "payload.phases.1.key"), "save")).toContain("A key is unique");
    expect(templateRefusalText(r("invalid_field", 400, "payload.tasks"), "save")).toBe("The steps is not valid. Keep one to 80 steps.");
  });
  it("says the chosen template is not a live project template of this company", () => {
    expect(templateRefusalText(r("invalid_field", 400, "onboardingTemplateId"), "choose")).toContain("not a live project template");
  });
  it("says who may choose, and who may edit the steps", () => {
    expect(templateRefusalText(r("not_a_social_approver", 403), "choose")).toBe(PLAN_REFUSAL_REASON.replace("change this", "choose the onboarding template"));
    expect(templateRefusalText(r("not authorized: cerbos denied manage on pm_task", 403), "save")).toContain("right to manage Project Management templates");
    expect(templateRefusalText(r("template not found", 404), "save")).toContain("That template is gone");
    expect(templateRefusalText(r("anything", 500), "save")).toBe("That did not work. Reload the page and try again.");
    expect(templateRefusalText(r("status_changed", 409), "save")).toBe(REFUSAL_WORDS.status_changed);
  });
});
