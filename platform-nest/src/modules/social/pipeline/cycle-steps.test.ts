// SCP-5f — the monthly cycle's step tasks, PURE (no database): the plan of a cycle's steps from the company's rules (titles and due dates
// in working days) and each step's auto-close condition (BFF §63.27.2, §63.30.1). The database half, the lock order and the routes are
// proved against real Postgres and Cerbos in `cycle-steps.http.test.ts`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { WorkingCalendar } from "../../hr/working-days";
import { contentMonthFigures } from "./content-month-progress";
import { planCycleSteps, postMeets, stepFigures, type StepPost } from "./cycle-steps";
import { DEFAULT_RULES, cycleSteps, type CycleStepRule } from "./rules";
import {
  STEP_KEYS, latestSafeHandoffFor, remainingSteps, remainingWorkingDays, tallyCounts, type HealthPost, type StepEstimates, type StepKey,
} from "./schedule-health";

const SEED = cycleSteps(DEFAULT_RULES);
const KEYS = SEED.map((s) => s.key);
const E9: StepEstimates = { proofread: 1, hod: 1, design: 3, final: 1, client: 2, schedule: 1 };
const MON_FRI: WorkingCalendar = { weekendDays: [6, 7], holidays: [] };
const withHolidays = (...days: string[]): WorkingCalendar => ({ weekendDays: [6, 7], holidays: days.map((day) => ({ day, kind: "public" as const })) });
const dues = (month: string, ctx: Parameters<typeof planCycleSteps>[2], steps: readonly CycleStepRule[] = SEED) =>
  Object.fromEntries(planCycleSteps(steps, month, ctx).map((s) => [s.key, s.dueDate]));

describe("the seeded steps (BFF §63.27.2 through §63.30's seed)", () => {
  it("are the six, in order, each closing itself (SCP-Q31)", () => {
    expect(KEYS).toEqual(["report", "planning", "copy_lock", "artwork", "client_window", "deploy"]);
    expect(SEED.map((s) => s.autoClose.rule)).toEqual(["report_delivered", "plan_laid_out", "copy_locked", "artwork_done", "client_approved", "all_scheduled"]);
    expect(SEED[0].autoClose).toEqual({ rule: "report_delivered", reportMonthOffset: -2 });
  });

  it("titles say which month each step means: the report is on the month before last", () => {
    const plan = planCycleSteps(SEED, "2027-01", { readyBy: "2026-12-30", estimates: {}, reportDueDay: 5, calendar: MON_FRI });
    expect(plan.map((s) => s.title)).toEqual([
      "Monthly report for November 2026", "January 2027 plan", "January 2027 copy locked", "January 2027 artwork",
      "January 2027 client approval", "January 2027 scheduled",
    ]);
  });
});

describe("due dates in working days (hand-computed)", () => {
  it("without estimates every step but the report falls due on ready-by", () => {
    expect(dues("2027-01", { readyBy: "2026-12-30", estimates: {}, reportDueDay: 5, calendar: MON_FRI })).toEqual({
      report: "2026-12-05", planning: "2026-12-30", copy_lock: "2026-12-30", artwork: "2026-12-30", client_window: "2026-12-30", deploy: "2026-12-30",
    });
  });

  it("with estimates, across a holiday and the year turn (content month January 2027, ready-by Wednesday 30 December, 25 December a holiday)", () => {
    // client_window: R less schedule (1) = Tue 29. artwork: R less final+client+schedule (4): 29, 28, [27 Sun, 26 Sat, 25 holiday], 24, 23.
    // copy_lock: less design too (7): 22, 21, 18. planning: less all six (9): 17, 16.
    expect(dues("2027-01", { readyBy: "2026-12-30", estimates: E9, reportDueDay: 31, calendar: withHolidays("2026-12-25") })).toEqual({
      report: "2026-12-31", planning: "2026-12-16", copy_lock: "2026-12-18", artwork: "2026-12-23", client_window: "2026-12-29", deploy: "2026-12-30",
    });
    // The same without the holiday: artwork moves one working day later.
    expect(dues("2027-01", { readyBy: "2026-12-30", estimates: E9, reportDueDay: 31, calendar: MON_FRI }).artwork).toBe("2026-12-24");
  });

  it("the report's day is clamped to a short month's last day (63.18's rule), and there is none without a report day", () => {
    const ctx = { readyBy: "2026-02-27", estimates: { schedule: 1 }, reportDueDay: 31, calendar: MON_FRI };
    expect(dues("2026-03", ctx)).toMatchObject({ report: "2026-02-28", client_window: "2026-02-26", deploy: "2026-02-27" });
    expect(dues("2026-03", { ...ctx, reportDueDay: null }).report).toBeNull();
  });

  it("a company's own steps: their order, a `none` rule, extra working days and a report on the month before", () => {
    const own: CycleStepRule[] = [
      { key: "brief", title: "{month} brief", due: { rule: "ready_by", lessEstimatesFrom: "design", lessWorkingDays: 2 }, autoClose: { rule: "manual" } },
      { key: "review", title: "Review {month-1}", due: { rule: "report_due_day", monthOffset: 0 }, autoClose: { rule: "report_delivered", reportMonthOffset: -1 } },
      { key: "wrap", title: "{month} wrap", due: { rule: "none" }, autoClose: { rule: "all_scheduled" } },
    ];
    const plan = planCycleSteps(own, "2026-12", { readyBy: "2026-11-20", estimates: E9, reportDueDay: 10, calendar: MON_FRI });
    // brief: R (Fri 20 Nov) less design+final+client+schedule (7) less 2 = 9 working days: 19, 18, 17, 16, 13, 12, 11, 10, 9.
    expect(plan).toEqual([
      { key: "brief", title: "December 2026 brief", dueDate: "2026-11-09", autoClose: { rule: "manual" } },
      { key: "review", title: "Review November 2026", dueDate: "2026-12-10", autoClose: { rule: "report_delivered", reportMonthOffset: -1 } },
      { key: "wrap", title: "December 2026 wrap", dueDate: null, autoClose: { rule: "all_scheduled" } },
    ]);
  });
});

// ── against 63.5's golden working-day table: a step's day is a post's latest safe hand-off with the steps after it remaining ─────────
interface GoldenCalendar { weekendDays?: number[]; holidays?: string[] }
const golden = JSON.parse(readFileSync(join(__dirname, "schedule-health-golden.json"), "utf8")) as {
  health: Array<{ name: string; readyBy: string; calendar: GoldenCalendar | null; estimates: "E9" | StepEstimates; post: HealthPost; expect: { latestSafeHandoff: string | null } }>;
};
const cal = (c: GoldenCalendar | null): WorkingCalendar =>
  c === null ? {} : { ...(c.weekendDays ? { weekendDays: c.weekendDays } : {}), holidays: (c.holidays ?? []).map((day) => ({ day, kind: "public" as const })) };
/** The estimated steps each seeded ready_by step leaves for after it (§63.27.2's "Due" column). */
const AFTER: Record<string, readonly StepKey[]> = {
  planning: STEP_KEYS, copy_lock: ["design", "final", "client", "schedule"], artwork: ["final", "client", "schedule"], client_window: ["schedule"], deploy: [],
};

describe("due dates against 63.5's golden table (holidays, custom weekends, month ends, the year turn)", () => {
  it("every golden calendar: each step is latestSafeHandoffFor(R, the estimates after it)", () => {
    expect(golden.health.length).toBeGreaterThanOrEqual(60);
    for (const row of golden.health) {
      const estimates = row.estimates === "E9" ? E9 : row.estimates;
      const calendar = cal(row.calendar);
      const got = dues("2027-01", { readyBy: row.readyBy, estimates, reportDueDay: null, calendar });
      for (const [key, after] of Object.entries(AFTER)) {
        expect(got[key], `${row.name} · ${key}`).toBe(latestSafeHandoffFor(row.readyBy, remainingWorkingDays(after, estimates), calendar));
      }
    }
  });

  it("where a golden post has exactly a step's remaining steps, the step falls on the golden (hand-computed) hand-off", () => {
    let matched = 0;
    for (const row of golden.health) {
      const rem = remainingSteps(row.post);
      if (!rem || row.expect.latestSafeHandoff === null) continue;
      const key = Object.keys(AFTER).find((k) => AFTER[k].length === rem.length && AFTER[k].every((s, i) => s === rem[i]));
      if (!key) continue;
      const estimates = row.estimates === "E9" ? E9 : row.estimates;
      const got = dues("2027-01", { readyBy: row.readyBy, estimates, reportDueDay: null, calendar: cal(row.calendar) });
      expect(got[key], `${row.name} · ${key}`).toBe(row.expect.latestSafeHandoff);
      matched += 1;
    }
    expect(matched).toBeGreaterThanOrEqual(5);
  });
});

// ── the conditions ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const post = (status: string, extra: Partial<StepPost> = {}): StepPost => ({ status, isExtra: false, format: "feed", ...extra });
const change = (changeBy: string, changeKind: string, returnTo: string, extra: Partial<StepPost> = {}) => post("changes", { changeBy, changeKind, returnTo, ...extra });
const auto = (key: string) => SEED.find((s) => s.key === key)!.autoClose;
const fig = (key: string, posts: StepPost[], target: number | null = null, delivered = false) => stepFigures(auto(key), posts, target, delivered)!;

describe("each step closes on its condition, and reopens when it stops holding (SCP-Q31)", () => {
  it("report: done only when the report is delivered; 0 until then", () => {
    expect(fig("report", [post("live")], null, false)).toEqual({ progress: 0, done: false });
    expect(fig("report", [], null, true)).toEqual({ progress: 100, done: true });
  });

  it("planning: the target met and no counted post planned or drafting; a new counted post reopens it", () => {
    expect(fig("planning", [], 2)).toEqual({ progress: 0, done: false });
    expect(fig("planning", [post("proofread"), post("drafting")], 2)).toEqual({ progress: 50, done: false });
    expect(fig("planning", [post("proofread")], 2)).toEqual({ progress: 99, done: false }); // every post is past drafting, the target is not met
    expect(fig("planning", [post("proofread"), post("hod")], 2)).toEqual({ progress: 100, done: true });
    expect(fig("planning", [post("proofread"), post("hod"), post("planned")], 2).done).toBe(false); // reopened
    // Without a target, at least one counted post. A story and an extra post are not counted.
    expect(fig("planning", [post("hod")], null).done).toBe(true);
    expect(fig("planning", [post("planned", { format: "story" }), post("drafting", { isExtra: true })], null)).toEqual({ progress: 0, done: false });
    expect(fig("planning", [post("hod"), post("planned", { format: "story" })], null).done).toBe(true);
  });

  it("copy_lock: every counted post past the HoD approval; a design change keeps it, a copy change reopens it", () => {
    expect(fig("copy_lock", [post("design"), post("final")]).done).toBe(true);
    expect(fig("copy_lock", [post("design"), change("final", "design", "final")]).done).toBe(true); // final_design
    expect(fig("copy_lock", [post("design"), change("client", "design", "final")]).done).toBe(true); // client_design
    expect(fig("copy_lock", [post("design"), change("client", "copy", "proofread")])).toEqual({ progress: 50, done: false }); // client_copy
    expect(fig("copy_lock", [post("design"), post("hod")]).done).toBe(false);
    expect(fig("copy_lock", []).done).toBe(false);
  });

  it("artwork: every counted post out of Creative; a design change reopens it, a copy change after design keeps it", () => {
    expect(fig("artwork", [post("final"), post("client"), post("live")]).done).toBe(true);
    expect(fig("artwork", [post("final"), change("final", "design", "final")])).toEqual({ progress: 50, done: false }); // final_design: reopened
    expect(fig("artwork", [post("final"), change("client", "design", "final")]).done).toBe(false); // client_design
    expect(fig("artwork", [post("final"), change("final", "copy", "final")]).done).toBe(true); // final_copy
    expect(fig("artwork", [post("final"), change("client", "copy", "proofread")]).done).toBe(true); // client_copy
    // The client's copy change re-proofs only the copy (changed_only): the post has not gone back to Creative.
    expect(fig("artwork", [post("final"), post("proofread", { changedOnly: true })]).done).toBe(true);
    expect(fig("artwork", [post("final"), post("proofread")]).done).toBe(false);
    expect(fig("artwork", [post("final"), post("design")]).done).toBe(false);
  });

  it("client_window: 63.13's content-month rule exactly; a reschedule (back to the client) reopens it", () => {
    expect(fig("client_window", [post("approved"), post("scheduled")], 2).done).toBe(true);
    expect(fig("client_window", [post("approved"), post("client")], 2)).toEqual({ progress: 50, done: false });
    expect(fig("client_window", [post("approved")], 2).done).toBe(false); // the target is not met
    // The same answer as the content-month task for every mix (63.13's rule, §63.27.2).
    const statuses = ["planned", "drafting", "proofread", "hod", "design", "final", "client", "approved", "scheduled", "live"];
    for (const target of [null, 0, 1, 2, 3]) {
      for (let i = 0; i < statuses.length; i++) {
        for (let j = i; j < statuses.length; j++) {
          const ps = [post(statuses[i]), post(statuses[j]), post("approved", { isExtra: true })];
          expect(fig("client_window", ps, target).done, `${statuses[i]} ${statuses[j]} target ${target}`).toBe(contentMonthFigures(tallyCounts(ps), target).done);
        }
      }
    }
  });

  it("deploy: every counted post scheduled or live, and the target met; a reschedule reopens it", () => {
    expect(fig("deploy", [post("scheduled"), post("live")], 2).done).toBe(true);
    expect(fig("deploy", [post("scheduled"), post("approved")], 2)).toEqual({ progress: 50, done: false });
    expect(fig("deploy", [post("scheduled"), post("client")], 2).done).toBe(false); // rescheduled: back with the client
    expect(fig("deploy", [post("scheduled")], 2).done).toBe(false);
  });

  it("a blocked post counts from blocked_from and its change case", () => {
    expect(postMeets("plan_laid_out", post("blocked", { blockedFrom: "drafting" }))).toBe(false);
    expect(postMeets("copy_locked", post("blocked", { blockedFrom: "design" }))).toBe(true);
    expect(postMeets("copy_locked", post("blocked", { blockedFrom: "changes", changeBy: "final", changeKind: "design", returnTo: "final" }))).toBe(true);
    expect(postMeets("artwork_done", post("blocked", { blockedFrom: "changes", changeBy: "final", changeKind: "design", returnTo: "final" }))).toBe(false);
  });

  it("progress is the share of counted posts meeting the condition, kept at 99 or below until done", () => {
    const ps = [post("final"), post("final"), post("design")];
    expect(fig("artwork", ps)).toEqual({ progress: 67, done: false });
    expect(fig("deploy", [post("scheduled"), post("scheduled")], 3)).toEqual({ progress: 99, done: false });
  });

  it("a step set to `manual` is never closed or reopened by the pipeline", () => {
    expect(stepFigures({ rule: "manual" }, [post("live")], null, true)).toBeNull();
    expect(stepFigures({ rule: "manual" }, [], null, false)).toBeNull();
  });
});
