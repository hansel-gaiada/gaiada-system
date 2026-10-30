// SCP-5h (W5-C4) — the pure half of client onboarding (BFF §63.29.4): the start body, the default people, the start's block, the list's order.
import { describe, it, expect } from "vitest";
import { hasOpenTask, isLateDay, parseStartBody, sortOnboarding, startBlockOf, startPeople, type OnboardingItem } from "./onboarding";

const ID = "11111111-1111-4111-8111-111111111111";
const OFFICER = "22222222-2222-4222-8222-222222222222";
const CALLER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

const fieldOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return ((e as { getResponse: () => { field?: string } }).getResponse()).field; }
  return undefined;
};

describe("parseStartBody (BFF §63.29.4)", () => {
  it("takes {id, kickoff, people?} and lower-cases the ids", () => {
    expect(parseStartBody({ id: ID.toUpperCase(), kickoff: "2026-11-02" })).toEqual({ id: ID, kickoff: "2026-11-02", people: {} });
    expect(parseStartBody({ id: ID, kickoff: "2026-11-02", people: { lead: OTHER.toUpperCase(), officer: null } }).people).toEqual({ lead: OTHER, officer: null });
  });
  it("names the field it refuses", () => {
    expect(fieldOf(() => parseStartBody(null))).toBe("id");
    expect(fieldOf(() => parseStartBody({ kickoff: "2026-11-02" }))).toBe("id");
    expect(fieldOf(() => parseStartBody({ id: "nope", kickoff: "2026-11-02" }))).toBe("id");
    expect(fieldOf(() => parseStartBody({ id: ID }))).toBe("kickoff");
    expect(fieldOf(() => parseStartBody({ id: ID, kickoff: "2026-02-30" }))).toBe("kickoff");
    expect(fieldOf(() => parseStartBody({ id: ID, kickoff: "1999-12-31" }))).toBe("kickoff");
    expect(fieldOf(() => parseStartBody({ id: ID, kickoff: "2026-11-02", people: [] }))).toBe("people");
    expect(fieldOf(() => parseStartBody({ id: ID, kickoff: "2026-11-02", people: { lead: "x" } }))).toBe("people.lead");
    expect(fieldOf(() => parseStartBody({ id: ID, kickoff: "2026-11-02", people: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`r${i}`, null])) }))).toBe("people");
  });
});

describe("startPeople (BFF §63.29.4: officer to the officer, lead to the caller, client steps to the officer)", () => {
  it("defaults the three seeded roles", () => {
    expect(startPeople(["lead", "officer", "client"], {}, OFFICER, CALLER)).toEqual({ lead: CALLER, officer: OFFICER, client: OFFICER });
  });
  it("gives a default only to a role the template has", () => {
    expect(startPeople(["lead"], {}, OFFICER, CALLER)).toEqual({ lead: CALLER });
    expect(startPeople(["designer"], {}, OFFICER, CALLER)).toEqual({});
  });
  it("leaves out a default with no person to give (a client with no officer)", () => {
    expect(startPeople(["lead", "officer", "client"], {}, null, CALLER)).toEqual({ lead: CALLER });
  });
  it("the body wins, and a null leaves the role unassigned", () => {
    expect(startPeople(["lead", "officer", "client"], { lead: OTHER, client: null }, OFFICER, CALLER)).toEqual({ lead: OTHER, client: null, officer: OFFICER });
  });
  it("passes a role the template does not have through, for PM to refuse", () => {
    expect(startPeople(["lead"], { ghost: OTHER }, OFFICER, CALLER)).toEqual({ ghost: OTHER, lead: CALLER });
  });
});

describe("the start's block, lateness and open work", () => {
  it("the project comes before the template", () => {
    expect(startBlockOf(null, null)).toBe("no_project");
    expect(startBlockOf(null, { id: "t" })).toBe("no_project");
    expect(startBlockOf("p", null)).toBe("onboarding_template_not_set");
    expect(startBlockOf("p", { id: "t" })).toBeNull();
  });
  it("a step is late only when open and due before today", () => {
    expect(isLateDay("2026-11-01", false, "2026-11-02")).toBe(true);
    expect(isLateDay("2026-11-02", false, "2026-11-02")).toBe(false);
    expect(isLateDay("2026-11-01", true, "2026-11-02")).toBe(false);
    expect(isLateDay(null, false, "2026-11-02")).toBe(false);
  });
  it("an application is open while a task is not done", () => {
    expect(hasOpenTask({ done: 3, total: 15 })).toBe(true);
    expect(hasOpenTask({ done: 15, total: 15 })).toBe(false);
    expect(hasOpenTask({ done: 0, total: 0 })).toBe(false);
  });
});

const item = (over: Partial<OnboardingItem>): OnboardingItem => ({
  engagementId: "e", clientId: "c", clientName: "Mock", engagementStatus: "draft", officer: null, projectId: "p", applicationId: null, kickoff: null,
  progress: { done: 0, total: 0 }, next: null, baselineAudit: null, steps: [], doneStatusId: null, startBlock: null, ...over,
});

describe("sortOnboarding", () => {
  it("started clients first by their next due day (none last), then the others by name", () => {
    const a = item({ engagementId: "a", clientName: "Zed", applicationId: "x", next: { taskId: "t", title: "T", dueDate: "2026-11-09", late: false } });
    const b = item({ engagementId: "b", clientName: "Amy", applicationId: "y", next: { taskId: "t", title: "T", dueDate: "2026-11-03", late: false } });
    const c = item({ engagementId: "c", clientName: "Bob", applicationId: "z", next: null });
    const d = item({ engagementId: "d", clientName: "Cat" });
    const e = item({ engagementId: "e", clientName: "Abe" });
    expect(sortOnboarding([d, c, a, e, b]).map((i) => i.engagementId)).toEqual(["b", "a", "c", "e", "d"]);
  });
});
