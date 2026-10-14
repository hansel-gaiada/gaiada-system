import { describe, it, expect } from "vitest";
import { appraisalNextStep, appraisalStatusText, appraisalView, learningView, scoreText } from "./overviewGrowth";
import type { MyEnrollment, MyLearning } from "./lms";
import type { AppraisalStatus } from "./appraisals";
import { selectBands } from "./overview";
import { WORKSPACES, isPlanned } from "./workspaces";

const ok = <T,>(data: T) => ({ kind: "ok" as const, data });
const refused = { kind: "forbidden" as const };
const failed = { kind: "unavailable" as const, reason: "boom" };

const enrol = (id: string, over: Partial<MyEnrollment> = {}): MyEnrollment => ({
  id, pathId: `p-${id}`, pathKey: id, title: `Path ${id}`, isMandatory: false, status: "assigned", source: "x",
  dueOn: null, completedAt: null, overdue: false, startedAt: null, coursesRequired: 1, coursesCompleted: 0, ...over,
});
const mine = (...enrolments: MyEnrollment[]): MyLearning => ({ enrolments, certifications: [] });

describe("learningView", () => {
  it("never turns a refused or failed read into a count", () => {
    expect(learningView(refused)).toEqual({ kind: "forbidden" });
    expect(learningView(failed)).toEqual({ kind: "unavailable" });
  });

  it("an ok read with nothing assigned is a real zero with nothing due", () => {
    expect(learningView(ok(mine()))).toEqual({ kind: "ok", outstanding: 0, inProgress: 0, overdue: 0, nextDue: null });
  });

  it("counts only assigned and in progress as outstanding, and flags overdue ones", () => {
    const v = learningView(ok(mine(
      enrol("a", { status: "assigned", overdue: true, dueOn: "2026-08-18" }),
      enrol("b", { status: "in_progress" }),
      enrol("c", { status: "completed", dueOn: "2026-07-01" }),
      enrol("d", { status: "waived" }),
      enrol("e", { status: "expired", overdue: true }),
    )));
    expect(v).toMatchObject({ kind: "ok", outstanding: 2, inProgress: 1, overdue: 1 });
  });

  it("next due is the soonest dated outstanding item, with its overdue flag", () => {
    const v = learningView(ok(mine(
      enrol("late", { dueOn: "2026-12-01" }),
      enrol("soon", { dueOn: "2026-11-01", title: "Soonest" }),
      enrol("undated", { dueOn: null }),
      enrol("done", { status: "completed", dueOn: "2026-01-01" }),
    )));
    expect(v).toMatchObject({ nextDue: { title: "Soonest", dueOn: "2026-11-01", overdue: false } });
    const past = learningView(ok(mine(enrol("p", { dueOn: "2026-08-18", overdue: true }), enrol("q", { dueOn: "2026-09-01" }))));
    expect(past).toMatchObject({ nextDue: { dueOn: "2026-08-18", overdue: true } });
  });

  it("has no next due when nothing outstanding is dated", () => {
    expect(learningView(ok(mine(enrol("a"), enrol("b", { status: "in_progress" }))))).toMatchObject({ outstanding: 2, nextDue: null });
  });
});

const pack = (id: string, status: AppraisalStatus, over: Record<string, unknown> = {}) => ({
  id, cycleName: `Cycle ${id}`, status, composite: null as number | null, submittedAt: "2026-06-01T00:00:00Z",
  finalizedAt: null as string | null, createdAt: "2026-05-01T00:00:00Z", ...over,
});

describe("appraisalView", () => {
  it("never turns a refused or failed read into 'no appraisal'", () => {
    expect(appraisalView(refused)).toEqual({ kind: "forbidden" });
    expect(appraisalView(failed)).toEqual({ kind: "unavailable" });
  });

  it("an ok read with no packs has neither a current pack nor a last result", () => {
    expect(appraisalView(ok({ appraisals: [] }))).toEqual({ kind: "ok", current: null, last: null });
  });

  it("the current pack is the latest one not finalized; the last result is the latest finalized", () => {
    const v = appraisalView(ok({ appraisals: [
      pack("old", "finalized", { composite: 3.5, finalizedAt: "2026-01-10T00:00:00Z" }),
      pack("new-fin", "finalized", { composite: 4.256, finalizedAt: "2026-04-10T00:00:00Z" }),
      pack("a", "acknowledged", { submittedAt: "2026-02-01T00:00:00Z" }),
      pack("b", "submitted", { submittedAt: "2026-07-01T00:00:00Z" }),
    ] }));
    expect(v).toMatchObject({
      current: { cycleName: "Cycle b", status: "submitted", statusText: "Submitted to you" },
      last: { cycleName: "Cycle new-fin", composite: 4.256, scoreText: "4.26 of 5" },
    });
  });

  it("with only finalized packs there is no current one; with only open ones there is no last result", () => {
    expect(appraisalView(ok({ appraisals: [pack("f", "finalized", { composite: 4, finalizedAt: "2026-04-10T00:00:00Z" })] })))
      .toMatchObject({ current: null, last: { scoreText: "4.00 of 5" } });
    expect(appraisalView(ok({ appraisals: [pack("d", "disputed")] }))).toMatchObject({ current: { status: "disputed" }, last: null });
  });

  it("a finalized pack without a score says so instead of inventing one", () => {
    expect(appraisalView(ok({ appraisals: [pack("f", "finalized", { finalizedAt: "2026-04-10T00:00:00Z" })] })))
      .toMatchObject({ last: { composite: null, scoreText: null } });
    expect(scoreText(null)).toBeNull();
  });
});

describe("the next step comes from the status alone", () => {
  it("only a submitted pack asks the subject to act", () => {
    expect(appraisalNextStep("submitted")).toMatch(/acknowledge or dispute/);
    for (const s of ["draft", "acknowledged", "disputed", "finalized"] as const) expect(appraisalNextStep(s), s).toBeNull();
    expect(appraisalNextStep("something-new" as never)).toBeNull();
  });

  it("every status has words", () => {
    expect((["draft", "submitted", "acknowledged", "disputed", "finalized"] as const).map(appraisalStatusText))
      .toEqual(["Draft", "Submitted to you", "Acknowledged", "Disputed", "Finalized"]);
  });
});

describe("the Growth band's placement in the registry", () => {
  it("every department workspace lists Learning and Appraisal as built blocks; the company frame lists none of them", () => {
    for (const ws of WORKSPACES) {
      const growth = ws.overview.filter((w) => w.band === "growth");
      if (ws.overview[0].key === "decisions") { expect(growth.every(isPlanned), ws.key).toBe(true); continue; }
      expect(growth.map((w) => [w.key, isPlanned(w)]), ws.key).toEqual([["learning", false], ["appraisal", false]]);
    }
  });

  it("selectBands keeps the Growth band only while a block of it is placed", () => {
    const widgets = [{ key: "learning", band: "growth" as const, label: "Learning" }];
    const ctx = { me: { userId: "u" } as never, tenantId: "t", unitPath: [] };
    expect(selectBands(widgets, ctx, () => true).map((b) => b.band)).toEqual(["growth"]);
    expect(selectBands(widgets, ctx, () => false)).toEqual([]);
  });
});
