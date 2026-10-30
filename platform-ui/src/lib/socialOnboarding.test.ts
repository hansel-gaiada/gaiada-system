import { describe, it, expect } from "vitest";
import {
  asOnboarding, asStarted, groupByPhase, kickoffProblem, lateCount, onboardingRefusalText, progressPercent, progressText, startBlockWords,
  type OnboardingItem, type OnboardingStep,
} from "./socialOnboarding";

// SCP-5h (BFF §63.29.4): the parser (a wrong shape is an error, never a plausible empty list), the checklist by phase, the words for the button and for each refusal.

const step = (over: Partial<OnboardingStep> = {}): OnboardingStep => ({
  key: "meet", taskId: "t1", title: "Kickoff meeting held", phase: "kickoff", phaseTitle: "Kickoff", role: "lead", roleLabel: "Lead", dueDate: "2026-11-02", done: false, late: false, ...over,
});
const item = (over: Partial<OnboardingItem> = {}): OnboardingItem => ({
  engagementId: "e1", clientId: "c1", clientName: "Mock Bakery", engagementStatus: "draft", officer: { id: "u1", name: "Mock Officer" }, projectId: "p1", applicationId: null, kickoff: null,
  progress: { done: 0, total: 0 }, next: null, baselineAudit: null, steps: [], doneStatusId: "done", startBlock: null, ...over,
});

describe("asOnboarding", () => {
  const raw = {
    template: { id: "tpl", name: "Mock onboarding" }, canStart: true,
    items: [{
      engagementId: "e1", clientId: "c1", clientName: "Mock Bakery", engagementStatus: "draft", officer: { id: "u1", name: "Mock Officer" }, projectId: "p1", applicationId: "a1", kickoff: "2026-11-02",
      progress: { done: 1, total: 2 }, next: { taskId: "t2", title: "Chat group opened", dueDate: "2026-11-03", late: true }, baselineAudit: { auditId: "au1", status: "final", overall: 71 },
      steps: [step(), step({ key: "group", taskId: "t2", title: "Chat group opened", done: false, late: true })], doneStatusId: "done", startBlock: null,
    }],
  };
  it("reads the contract's shape", () => {
    const o = asOnboarding(raw);
    expect(o.template).toEqual({ id: "tpl", name: "Mock onboarding" });
    expect(o.canStart).toBe(true);
    expect(o.items[0]).toMatchObject({
      applicationId: "a1", kickoff: "2026-11-02", progress: { done: 1, total: 2 }, next: { title: "Chat group opened", late: true }, baselineAudit: { auditId: "au1", status: "final", overall: 71 },
    });
    expect(o.items[0].steps).toHaveLength(2);
  });
  it("a null template, no baseline audit and no next step are real answers", () => {
    const o = asOnboarding({ template: null, canStart: false, items: [{ engagementId: "e", clientName: "A", officer: null, progress: { done: 0, total: 0 }, startBlock: "no_project" }] });
    expect(o.template).toBeNull();
    expect(o.items[0]).toMatchObject({ officer: null, next: null, baselineAudit: null, steps: [], applicationId: null, startBlock: "no_project" });
  });
  it("throws on a body that is not a list or a row, so the page says it cannot tell", () => {
    expect(() => asOnboarding(null)).toThrow();
    expect(() => asOnboarding({ items: "x" })).toThrow();
    expect(() => asOnboarding({ items: [{ clientName: "A" }] })).toThrow();
    expect(() => asOnboarding({ items: [{ engagementId: "e", clientName: "A", steps: [{ title: "no id" }] }] })).toThrow();
  });
  it("an unknown startBlock reads as none, and canStart is true only for true", () => {
    expect(asOnboarding({ items: [{ engagementId: "e", clientName: "A", startBlock: "weird" }], canStart: "yes" })).toMatchObject({ canStart: false, items: [{ startBlock: null }] });
  });
});

describe("asStarted", () => {
  it("takes PM's apply answer", () => {
    expect(asStarted({ applicationId: "a1", tasks: [{}, {}], milestones: [] })).toEqual({ applicationId: "a1", taskCount: 2 });
    expect(() => asStarted({})).toThrow();
  });
});

describe("the checklist by phase", () => {
  it("keeps the template's order, counts done and late per phase", () => {
    const g = groupByPhase([
      step({ key: "a", taskId: "1", done: true }), step({ key: "b", taskId: "2", late: true }),
      step({ key: "c", taskId: "3", phase: "access", phaseTitle: "Access" }), step({ key: "d", taskId: "4", phase: "kickoff", late: true }),
    ]);
    expect(g.map((p) => [p.phase, p.title, p.steps.length, p.done, p.late])).toEqual([["kickoff", "Kickoff", 3, 1, 2], ["access", "Access", 1, 0, 0]]);
  });
  it("counts the late steps of a client", () => {
    expect(lateCount(item({ steps: [step({ late: true }), step({ taskId: "2" }), step({ taskId: "3", late: true })] }))).toBe(2);
  });
});

describe("progress words", () => {
  it("says Not started before an application, and the figures after", () => {
    expect(progressText(item())).toBe("Not started");
    expect(progressText(item({ applicationId: "a", progress: { done: 5, total: 15 } }))).toBe("5 of 15 steps");
    expect(progressText(item({ applicationId: "a", progress: { done: 0, total: 0 } }))).toBe("No steps");
    expect(progressPercent(item({ progress: { done: 5, total: 15 } }))).toBe(33);
    expect(progressPercent(item())).toBe(0);
  });
});

describe("why Start onboarding cannot be used", () => {
  it("names who may, then the missing project, then the missing template, and is silent when it can", () => {
    expect(startBlockWords(item(), false)).toBe("Only the Social Media head, the GM, the owner and the superadmin can start onboarding.");
    expect(startBlockWords(item({ startBlock: "no_project" }), true)).toMatch(/no ERP project/);
    expect(startBlockWords(item({ startBlock: "onboarding_template_not_set" }), true)).toMatch(/not chosen an onboarding template/);
    expect(startBlockWords(item(), true)).toBeNull();
  });
});

describe("kickoffProblem", () => {
  it("accepts a real day and names the problem otherwise", () => {
    expect(kickoffProblem("2026-11-02")).toBeNull();
    expect(kickoffProblem("")).toMatch(/Choose/);
    expect(kickoffProblem("2026-02-30")).toMatch(/not a day/);
    expect(kickoffProblem("1999-12-31")).toMatch(/not a day/);
    expect(kickoffProblem("2101-01-01")).toMatch(/not a day/);
  });
});

describe("onboardingRefusalText", () => {
  it("has words for every code the routes answer, never a bare token", () => {
    for (const code of ["not_a_social_approver", "automation_cannot_act", "engagement_not_found", "no_project", "onboarding_template_not_set", "template_already_applied", "application_not_found", "session_expired", "no_company"]) {
      const words = onboardingRefusalText(code, "start");
      expect(words, code).not.toBe(code);
      expect(words.length, code).toBeGreaterThan(20);
    }
  });
  it("says PM's own bare 403 by what was tried", () => {
    expect(onboardingRefusalText("not authorized: cerbos denied manage on pm_project", "start")).toMatch(/manage this client's project/);
    expect(onboardingRefusalText("not authorized: cerbos denied manage on pm_project", "move")).toMatch(/Moving the kickoff/);
    expect(onboardingRefusalText("not authorized: cerbos denied update on pm_task", "tick")).toBe("You cannot change this step.");
  });
  it("names the field of a 400", () => {
    expect(onboardingRefusalText("invalid_field", "start", "kickoff")).toMatch(/kickoff day/);
    expect(onboardingRefusalText("invalid_field", "start", "people.lead")).toMatch(/active member/);
    expect(onboardingRefusalText("invalid_field", "start", "x")).toBe("x is not valid.");
  });
});
