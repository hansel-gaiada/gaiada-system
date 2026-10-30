// SCP-5f — the PURE side of the step reads (BFF §63.27.4): `composeCycleSteps` (health's `steps`), `isStepLate` and `lateStepAttention` (the Team
// dashboard's `cycle_step_late`). No database: the routes' proof is `cycle-steps.http.test.ts` and `team.http.test.ts` on real Postgres and Cerbos.
import { describe, it, expect } from "vitest";
import { DEFAULT_RULES, cycleSteps, type CycleStepRule } from "./rules";
import { composeCycleSteps, isStepLate, lateStepAttention, type StepTaskFact } from "./cycle-steps-read";

const RULES = cycleSteps(DEFAULT_RULES);
const KEYS = ["report", "planning", "copy_lock", "artwork", "client_window", "deploy"];
const TODAY = "2026-10-30";

const task = (step: string, o: Partial<StepTaskFact> = {}): StepTaskFact => ({
  id: `t-${step}`, step, title: `Mock ${step}`, dueDate: "2026-11-20", progress: 0, done: false, ...o,
});
const byStep = (...ts: StepTaskFact[]): Map<string, StepTaskFact> => new Map(ts.map((t) => [t.step, t]));

describe("isStepLate: past its due date and not done", () => {
  it("is late the day after the date, not on it, not without one, and never once done", () => {
    expect(isStepLate("2026-10-29", false, TODAY)).toBe(true);
    expect(isStepLate("2026-10-30", false, TODAY)).toBe(false);
    expect(isStepLate("2026-10-31", false, TODAY)).toBe(false);
    expect(isStepLate(null, false, TODAY)).toBe(false);
    expect(isStepLate("2020-01-01", true, TODAY)).toBe(false);
  });
});

describe("composeCycleSteps: the rules' steps, each from its task", () => {
  it("the seeded six, in the rules' order, whatever order the tasks arrive in", () => {
    expect(RULES.map((r) => r.key)).toEqual(KEYS);
    const out = composeCycleSteps(RULES, "2026-12", byStep(...[...KEYS].reverse().map((k) => task(k))), TODAY);
    expect(out.map((s) => s.step)).toEqual(KEYS);
    expect(out.map((s) => s.taskId)).toEqual(KEYS.map((k) => `t-${k}`));
    expect(out.every((s) => s.autoClose === "auto")).toBe(true);
  });

  it("each state: open, late, done, and done-though-past-due", () => {
    const out = composeCycleSteps(RULES, "2026-12", byStep(
      task("report", { dueDate: "2026-10-10" }), // open, past due: late
      task("planning", { dueDate: "2026-10-10", done: true, progress: 100 }), // done, past due: not late
      task("copy_lock", { progress: 40 }), // open, in time
      task("artwork", { dueDate: null }), // no date
    ), TODAY);
    const [report, planning, copyLock, artwork, clientWindow] = out;
    expect(report).toMatchObject({ done: false, late: true, holder: { role: "officer", label: "The officer" } });
    expect(planning).toMatchObject({ done: true, late: false, progress: 100, holder: null });
    expect(copyLock).toMatchObject({ done: false, late: false, progress: 40 });
    expect(artwork).toMatchObject({ dueDate: null, late: false });
    // no task at all (a cycle made before SCP-5f): the rules' title, nothing else
    expect(clientWindow).toEqual({
      step: "client_window", title: "December 2026 client approval", taskId: null, dueDate: null, done: false, progress: 0, autoClose: "auto",
      holder: { role: "officer", label: "The officer" }, late: false,
    });
  });

  it("progress stays 0 to 99 until done and is 100 when done", () => {
    const [a, b, c] = composeCycleSteps(RULES, "2026-12", byStep(task("report", { progress: 100 }), task("planning", { progress: 55, done: true }), task("copy_lock", { progress: -5 })), TODAY);
    expect(a.progress).toBe(99); // open with 100 recorded: 100 is what done means
    expect(b.progress).toBe(100);
    expect(c.progress).toBe(0);
  });

  it("a step set to manual says so; the holder is a role word, never a person", () => {
    const rules: CycleStepRule[] = [{ ...RULES[1], autoClose: { rule: "manual" } }, RULES[5]];
    const out = composeCycleSteps(rules, "2026-12", byStep(task("planning"), task("deploy")), TODAY);
    expect(out.map((s) => [s.step, s.autoClose])).toEqual([["planning", "manual"], ["deploy", "auto"]]);
    expect(JSON.stringify(out)).not.toMatch(/userId|email|name"/);
  });
});

describe("lateStepAttention: the Team dashboard's cycle_step_late", () => {
  it("carries the client, the step, the date and the step's title; since is the due date; no holder, post or person", () => {
    const [i] = lateStepAttention([{ engagementId: "e1", clientName: "Mock Client", cycleId: "cy1", step: "planning", title: "December 2026 plan", dueDate: "2026-10-12" }]);
    expect(i).toEqual({
      kind: "cycle_step_late", engagementId: "e1", clientName: "Mock Client", step: "planning", dueDate: "2026-10-12", title: "December 2026 plan", since: "2026-10-12",
    });
    expect(Object.keys(i)).not.toContain("holder");
    expect(Object.keys(i)).not.toContain("postId");
  });
});
