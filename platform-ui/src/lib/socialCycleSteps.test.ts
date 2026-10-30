import { describe, it, expect } from "vitest";
import { asCycleSteps, asStepsReason, dayText, stepStateOf, stepStateText, stepTaskHref, stepsSummary, type CycleStep } from "./socialCycleSteps";
import { asCycleView } from "./socialClient";

// SCP-5f (BFF §63.27.4): the cycle health's `steps` as the UI reads them: the parser (a wrong shape reads as "cannot tell", never as "no steps") and the words each state is
// said in (never colour alone).

const raw = (over: Record<string, unknown> = {}) => ({
  step: "planning", title: "March 2027 plan", taskId: "t-1", dueDate: "2027-02-12", done: false, progress: 40, autoClose: "auto", holder: { role: "officer", label: "The officer" }, late: false, ...over,
});
const step = (over: Partial<CycleStep> = {}): CycleStep => ({
  step: "planning", title: "March 2027 plan", taskId: "t-1", dueDate: "2027-02-12", done: false, progress: 0, autoClose: "auto", holder: "The officer", late: false, ...over,
});

describe("asCycleSteps: the parser", () => {
  it("reads the contract's shape, in the server's order", () => {
    expect(asCycleSteps([raw(), raw({ step: "deploy", title: "March 2027 scheduled", taskId: null, dueDate: null, autoClose: "manual", holder: null })])).toEqual([
      { step: "planning", title: "March 2027 plan", taskId: "t-1", dueDate: "2027-02-12", done: false, progress: 40, autoClose: "auto", holder: "The officer", late: false },
      { step: "deploy", title: "March 2027 scheduled", taskId: null, dueDate: null, done: false, progress: 40, autoClose: "manual", holder: null, late: false },
    ]);
  });
  it("no `steps` at all is null (an older server: nothing is claimed); an empty list is an empty list", () => {
    expect(asCycleSteps(undefined)).toBeNull();
    expect(asCycleSteps("steps")).toBeNull();
    expect(asCycleSteps([])).toEqual([]);
  });
  it("drops a row that is not a step, never invents one", () => {
    expect(asCycleSteps([null, 3, {}, { step: "" }, raw({ step: "report" })])?.map((s) => s.step)).toEqual(["report"]);
  });
  it("keeps progress between 0 and 99 until done, and a done step is 100 and never late", () => {
    const [a, b, c] = asCycleSteps([raw({ progress: 250 }), raw({ progress: -3, step: "b" }), raw({ step: "c", done: true, progress: 10, late: true })])!;
    expect(a.progress).toBe(99);
    expect(b.progress).toBe(0);
    expect(c).toMatchObject({ done: true, progress: 100, late: false });
  });
  it("an unknown auto-close reads as auto; only `manual` is manual; a holder without a label reads as none", () => {
    expect(asCycleSteps([raw({ autoClose: "x" }), raw({ step: "m", autoClose: "manual" }), raw({ step: "h", holder: { role: "officer" } })])?.map((s) => [s.autoClose, s.holder]))
      .toEqual([["auto", "The officer"], ["manual", "The officer"], ["auto", null]]);
  });
  it("is read through the cycle health parser, with the reason", () => {
    const body = { cycleId: "cy-1", posts: [], steps: [raw()], stepsReason: null };
    expect(asCycleView(body)).toMatchObject({ steps: [{ step: "planning" }], stepsReason: null });
    expect(asCycleView({ cycleId: "cy-1", posts: [], steps: [], stepsReason: "no_project" })).toMatchObject({ steps: [], stepsReason: "no_project" });
    expect(asCycleView({ cycleId: "cy-1", posts: [] })).toMatchObject({ steps: null, stepsReason: null });
    expect(asStepsReason("project_not_found")).toBe("project_not_found");
    expect(asStepsReason("whatever")).toBeNull();
  });
});

describe("the words of each state", () => {
  it("says every state in words, with the day", () => {
    expect(stepStateText(step({ done: true, progress: 100 }))).toBe("Done");
    expect(stepStateText(step({ late: true }))).toBe("Late, was due 12 Feb");
    expect(stepStateText(step())).toBe("Open, due 12 Feb");
    expect(stepStateText(step({ dueDate: null }))).toBe("Open, no due date");
    expect(stepStateText(step({ taskId: null, dueDate: null }))).toBe("No task yet");
    expect(stepStateText(step({ progress: 40 }))).toBe("Open, due 12 Feb, 40% of the way");
    expect(stepStateText(step({ late: true, progress: 40 }))).toBe("Late, was due 12 Feb, 40% of the way");
    expect(stepStateText(step({ autoClose: "manual" }))).toBe("Open, due 12 Feb, closed by hand only");
  });
  it("the state and the summary follow the same facts", () => {
    expect(stepStateOf(step({ done: true }))).toBe("done");
    expect(stepStateOf(step({ late: true }))).toBe("late");
    expect(stepStateOf(step({ taskId: null }))).toBe("untracked");
    expect(stepStateOf(step())).toBe("open");
    expect(stepsSummary([step({ done: true }), step({ late: true }), step()])).toBe("1 of 3 done, 1 late");
    expect(stepsSummary([step({ done: true })])).toBe("1 of 1 done");
  });
  it("names the day, and a task's page", () => {
    expect(dayText("2027-03-01")).toBe("1 Mar");
    expect(dayText(null)).toBe("an unknown day");
    expect(stepTaskHref("t 1")).toBe("/tasks/t%201");
  });
});
