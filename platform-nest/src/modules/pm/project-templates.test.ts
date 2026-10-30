// SCP-5h / W5-C3 — the PURE half of PM's project template (BFF §63.29.1, §63.29.6): the payload's refusals, the due dates on a
// GOLDEN working-day table, the milestones, and the kickoff move. No database, no clock.
//
// THE GOLDEN TABLE is written by hand from a printed calendar, never computed through the code under test:
//   2026-10-30 Fri · 10-31 Sat · 11-01 Sun · 11-02 Mon · 11-03 Tue · 11-04 Wed · 11-05 Thu · 11-06 Fri · 11-09 Mon
//   2026-12-24 Thu · 12-25 Fri (holiday) · 12-28 Mon · 12-29 Tue · 12-30 Wed · 12-31 Thu · 2027-01-01 Fri (holiday) · 01-04 Mon · 01-05 Tue
//   2027-02-26 Fri · 03-01 Mon · 2028-02-28 Mon · 02-29 Tue (leap day) · 03-01 Wed
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { WorkingCalendar } from "../hr/working-days";
import {
  validateProjectTemplatePayload, templateDueDate, planApplication, planKickoffMove, isKickoffDate, templateCalendarWindow,
  firstWorkingDayOnOrAfter, addWorkingDaysForward, isWorkingDay, type ProjectTemplatePayload, type AppliedTaskState,
} from "./project-templates";
import * as health from "../social/pipeline/schedule-health";

const MON_FRI: WorkingCalendar = {};
const HOLIDAYS: WorkingCalendar = {
  weekendDays: [6, 7],
  holidays: [
    { day: "2026-11-04", kind: "public" },
    { day: "2026-12-25", kind: "public" },
    { day: "2027-01-01", kind: "public" },
  ],
};

const base = (): ProjectTemplatePayload => ({
  title: "Mock client onboarding",
  phases: [{ key: "kickoff", title: "Kickoff" }, { key: "access", title: "Access" }, { key: "spare", title: "Spare" }],
  roles: [{ key: "lead", label: "Lead" }, { key: "officer", label: "Officer" }, { key: "client", label: "Client" }],
  tasks: [
    { key: "meet", title: "Mock kickoff meeting held", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0 },
    { key: "group", title: "Mock chat group opened", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 1, subtasks: ["Mock one", "Mock two"] },
    { key: "meta", title: "Mock partner access", phase: "access", role: "officer", dueOffsetWorkingDays: 2, description: "Mock note" },
    { key: "drive", title: "Mock folder linked", phase: "access", role: "client", dueOffsetWorkingDays: 5 },
  ],
});

function refusedAt(payload: unknown): string {
  try {
    validateProjectTemplatePayload(payload);
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const r = (e as BadRequestException).getResponse() as { message: string; field: string };
    expect(r.message).toBe("invalid_field");
    return r.field;
  }
  throw new Error("expected a refusal");
}

describe("SCP-5h · validateProjectTemplatePayload (§63.29.1)", () => {
  it("accepts the shape and normalizes it (trimmed strings, known keys only, empty optional parts dropped)", () => {
    const p = base() as unknown as Record<string, unknown>;
    (p as { extra?: number }).extra = 1;
    const t = (p.tasks as Array<Record<string, unknown>>);
    t[0].title = "  Mock kickoff meeting held  ";
    t[0].description = "";
    t[0].subtasks = [];
    t[0].unknown = true;
    const out = validateProjectTemplatePayload(p);
    expect(out).not.toHaveProperty("extra");
    expect(out.tasks[0]).toEqual({ key: "meet", title: "Mock kickoff meeting held", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0 });
    expect(out.tasks[1].subtasks).toEqual(["Mock one", "Mock two"]);
    expect(out.tasks[2].description).toBe("Mock note");
  });

  it("names the path of every refusal", () => {
    const with_ = (f: (p: ProjectTemplatePayload) => void): unknown => { const p = base(); f(p); return p; };
    expect(refusedAt(null)).toBe("payload");
    expect(refusedAt([])).toBe("payload");
    expect(refusedAt(with_((p) => { p.title = "  "; }))).toBe("payload.title");
    expect(refusedAt(with_((p) => { p.title = "x".repeat(201); }))).toBe("payload.title");
    expect(refusedAt(with_((p) => { p.phases = []; }))).toBe("payload.phases");
    expect(refusedAt(with_((p) => { p.phases = Array.from({ length: 13 }, (_, i) => ({ key: `p${i}`, title: "P" })); }))).toBe("payload.phases");
    expect(refusedAt(with_((p) => { p.roles = []; }))).toBe("payload.roles");
    expect(refusedAt(with_((p) => { p.roles = Array.from({ length: 11 }, (_, i) => ({ key: `r${i}`, label: "R" })); }))).toBe("payload.roles");
    expect(refusedAt(with_((p) => { p.tasks = []; }))).toBe("payload.tasks");
    // a repeated key, in each list
    expect(refusedAt(with_((p) => { p.phases[1].key = "kickoff"; }))).toBe("payload.phases.1.key");
    expect(refusedAt(with_((p) => { p.roles[2].key = "lead"; }))).toBe("payload.roles.2.key");
    expect(refusedAt(with_((p) => { p.tasks[3].key = "meet"; }))).toBe("payload.tasks.3.key");
    // an unknown phase or role
    expect(refusedAt(with_((p) => { p.tasks[1].phase = "nowhere"; }))).toBe("payload.tasks.1.phase");
    expect(refusedAt(with_((p) => { p.tasks[2].role = "nobody"; }))).toBe("payload.tasks.2.role");
    // offsets out of range, or not an integer
    expect(refusedAt(with_((p) => { p.tasks[0].dueOffsetWorkingDays = -1; }))).toBe("payload.tasks.0.dueOffsetWorkingDays");
    expect(refusedAt(with_((p) => { p.tasks[0].dueOffsetWorkingDays = 251; }))).toBe("payload.tasks.0.dueOffsetWorkingDays");
    expect(refusedAt(with_((p) => { p.tasks[0].dueOffsetWorkingDays = 1.5; }))).toBe("payload.tasks.0.dueOffsetWorkingDays");
    expect(refusedAt(with_((p) => { (p.tasks[0] as { dueOffsetWorkingDays: unknown }).dueOffsetWorkingDays = "3"; }))).toBe("payload.tasks.0.dueOffsetWorkingDays");
    expect(refusedAt(with_((p) => { delete (p.tasks[0] as Partial<typeof p.tasks[0]>).dueOffsetWorkingDays; }))).toBe("payload.tasks.0.dueOffsetWorkingDays");
    // lengths
    expect(refusedAt(with_((p) => { p.tasks[0].title = "x".repeat(201); }))).toBe("payload.tasks.0.title");
    expect(refusedAt(with_((p) => { p.tasks[0].description = "x".repeat(2001); }))).toBe("payload.tasks.0.description");
    expect(refusedAt(with_((p) => { p.tasks[0].subtasks = Array.from({ length: 21 }, () => "s"); }))).toBe("payload.tasks.0.subtasks");
    expect(refusedAt(with_((p) => { p.tasks[0].subtasks = ["ok", " "]; }))).toBe("payload.tasks.0.subtasks.1");
    // keys: shape
    expect(refusedAt(with_((p) => { p.roles[0].key = "Lead"; }))).toBe("payload.roles.0.key");
    expect(refusedAt(with_((p) => { p.roles[0].key = ""; }))).toBe("payload.roles.0.key");
    expect(refusedAt(with_((p) => { p.phases[0].key = "a".repeat(41); }))).toBe("payload.phases.0.key");
  });

  it("takes the limits at their edges: 12 phases, 10 roles, 80 tasks, offsets 0 and 250, 20 subtasks", () => {
    const p: ProjectTemplatePayload = {
      title: "Mock",
      phases: Array.from({ length: 12 }, (_, i) => ({ key: `p${i}`, title: `P${i}` })),
      roles: Array.from({ length: 10 }, (_, i) => ({ key: `r${i}`, label: `R${i}` })),
      tasks: Array.from({ length: 80 }, (_, i) => ({
        key: `t${i}`, title: `T${i}`, phase: `p${i % 12}`, role: `r${i % 10}`, dueOffsetWorkingDays: i === 0 ? 0 : 250,
        subtasks: i === 1 ? Array.from({ length: 20 }, (_, j) => `S${j}`) : undefined,
      })),
    };
    expect(validateProjectTemplatePayload(p).tasks).toHaveLength(80);
    p.tasks.push({ key: "t80", title: "T", phase: "p0", role: "r0", dueOffsetWorkingDays: 0 });
    expect(refusedAt(p)).toBe("payload.tasks");
  });
});

describe("SCP-5h · the due dates (golden working-day table)", () => {
  // [kickoff, offset, calendar, due] — each written out from the calendar in the header.
  const golden: Array<[string, number, WorkingCalendar, string, string]> = [
    ["2026-10-30", 0, MON_FRI, "2026-10-30", "a Friday kickoff, offset 0: the kickoff itself"],
    ["2026-10-30", 1, MON_FRI, "2026-11-02", "Friday + 1 crosses the weekend and the month end"],
    ["2026-10-31", 0, MON_FRI, "2026-11-02", "a Saturday kickoff counts from the Monday; offset 0 is that Monday"],
    ["2026-11-01", 0, MON_FRI, "2026-11-02", "a Sunday kickoff, offset 0: the Monday"],
    ["2026-11-01", 2, MON_FRI, "2026-11-04", "Sunday kickoff + 2: Mon start, Tue, Wed"],
    ["2026-11-02", 2, HOLIDAYS, "2026-11-05", "Mon + 2 with Wed 11-04 a holiday: Tue, Thu"],
    ["2026-11-04", 0, HOLIDAYS, "2026-11-05", "a kickoff ON a holiday counts from the next working day"],
    ["2026-11-04", 2, HOLIDAYS, "2026-11-09", "holiday kickoff + 2: Thu start, Fri, Mon"],
    ["2026-11-02", 5, MON_FRI, "2026-11-09", "a full week: Mon + 5 is the next Mon"],
    ["2026-12-24", 1, HOLIDAYS, "2026-12-28", "Thu + 1 over Christmas (Fri) and the weekend"],
    ["2026-12-24", 5, HOLIDAYS, "2027-01-04", "the year turn: Mon 28, Tue 29, Wed 30, Thu 31, (Fri 1 Jan holiday), Mon 4 Jan"],
    ["2026-12-31", 1, HOLIDAYS, "2027-01-04", "New Year's Eve + 1 skips the New Year holiday and the weekend"],
    ["2027-01-01", 0, HOLIDAYS, "2027-01-04", "a kickoff on New Year's Day (a holiday) counts from Mon 4 Jan"],
    ["2027-02-26", 1, MON_FRI, "2027-03-01", "February's end in a common year"],
    ["2028-02-28", 1, MON_FRI, "2028-02-29", "a leap day is an ordinary working day"],
    ["2028-02-28", 2, MON_FRI, "2028-03-01", "and the month turns after it"],
  ];
  it.each(golden)("kickoff %s + %i working days", (kickoff, offset, cal, due) => {
    expect(templateDueDate(kickoff, offset, cal)).toBe(due);
  });

  it("an empty weekendDays reads as Saturday and Sunday (the HR rule this inherits)", () => {
    expect(templateDueDate("2026-10-30", 1, { weekendDays: [] })).toBe("2026-11-02");
  });

  it("a custom weekend (Friday and Saturday off) is honoured", () => {
    // Thu 2026-10-29 + 1: Fri off, Sat off, Sun works.
    expect(templateDueDate("2026-10-29", 1, { weekendDays: [5, 6] })).toBe("2026-11-01");
  });

  it("250 working days on a plain calendar is 50 full weeks: exactly 350 calendar days on from a Monday", () => {
    expect(templateDueDate("2026-11-02", 250, MON_FRI)).toBe("2027-10-18");
  });

  it("uses the SAME working-day definitions as Social's schedule health (no second calendar)", () => {
    let d = "2026-12-20";
    for (let i = 0; i < 30; i++) {
      expect(isWorkingDay(d, HOLIDAYS)).toBe(health.isWorkingDay(d, HOLIDAYS));
      expect(firstWorkingDayOnOrAfter(d, HOLIDAYS)).toBe(health.firstWorkingDayOnOrAfter(d, HOLIDAYS));
      for (const n of [0, 1, 3, 7]) expect(addWorkingDaysForward(d, n, HOLIDAYS)).toBe(health.addWorkingDays(d, n, HOLIDAYS));
      d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    }
  });

  it("the calendar window covers the longest offset", () => {
    const w = templateCalendarWindow("2026-11-02", 250);
    expect(w.from).toBe("2026-11-02");
    expect(w.to >= "2027-10-18").toBe(true);
  });

  it("a kickoff is a real day between 2000 and 2100", () => {
    for (const ok of ["2026-11-02", "2028-02-29", "2000-01-01", "2100-12-31"]) expect(isKickoffDate(ok)).toBe(true);
    for (const no of ["2027-02-29", "2026-13-01", "2026-11-2", "1999-12-31", "2101-01-01", "", null, 20261102, "2026-11-02T00:00:00Z"]) {
      expect(isKickoffDate(no)).toBe(false);
    }
  });
});

describe("SCP-5h · planApplication: tasks and milestones", () => {
  it("dates every task from the kickoff, starts it on the kickoff as typed, and dues each milestone on its phase's last task", () => {
    const plan = planApplication(validateProjectTemplatePayload(base()), "2026-10-31", HOLIDAYS);
    expect(plan.tasks.map((t) => [t.key, t.startDate, t.dueDate])).toEqual([
      ["meet", "2026-10-31", "2026-11-02"],
      ["group", "2026-10-31", "2026-11-03"],
      ["meta", "2026-10-31", "2026-11-05"], // Mon start, Tue, (Wed holiday), Thu
      ["drive", "2026-10-31", "2026-11-10"], // Tue, Thu, Fri, Mon 9, Tue 10
    ]);
    expect(plan.tasks[1].subtasks).toEqual(["Mock one", "Mock two"]);
    expect(plan.tasks[0].subtasks).toEqual([]);
    expect(plan.tasks[2].description).toBe("Mock note");
    expect(plan.milestones).toEqual([
      { phase: "kickoff", title: "Kickoff", dueDate: "2026-11-03" },
      { phase: "access", title: "Access", dueDate: "2026-11-10" },
      { phase: "spare", title: "Spare", dueDate: null }, // a phase with no task: a milestone with no date
    ]);
  });
});

describe("SCP-5h · planKickoffMove: only the open tasks move", () => {
  const payload = validateProjectTemplatePayload(base());
  const msIds = [{ phase: "kickoff", milestoneId: "m1" }, { phase: "access", milestoneId: "m2" }, { phase: "spare", milestoneId: "m3" }];
  const applied = (over: Partial<Record<string, Partial<AppliedTaskState>>> = {}): AppliedTaskState[] => {
    const first = planApplication(payload, "2026-11-02", MON_FRI).tasks;
    return first.map((t, i) => ({ key: t.key, taskId: `t${i}`, phase: t.phase, dueDate: t.dueDate, done: false, live: true, ...(over[t.key] ?? {}) }));
  };

  it("re-dates every open task from the new kickoff and the milestones with them", () => {
    const r = planKickoffMove(payload, "2026-12-24", HOLIDAYS, applied(), msIds);
    expect(r.moves).toEqual([
      { taskId: "t0", startDate: "2026-12-24", dueDate: "2026-12-24" },
      { taskId: "t1", startDate: "2026-12-24", dueDate: "2026-12-28" },
      { taskId: "t2", startDate: "2026-12-24", dueDate: "2026-12-29" },
      { taskId: "t3", startDate: "2026-12-24", dueDate: "2027-01-04" },
    ]);
    expect(r.milestones).toEqual([
      { phase: "kickoff", milestoneId: "m1", dueDate: "2026-12-28" },
      { phase: "access", milestoneId: "m2", dueDate: "2027-01-04" },
      { phase: "spare", milestoneId: "m3", dueDate: null },
    ]);
  });

  it("a done task never moves, a deleted one neither, and the milestone counts the done task's own date", () => {
    const r = planKickoffMove(payload, "2026-11-30", MON_FRI, applied({ group: { done: true, dueDate: "2026-12-31" }, drive: { live: false } }), msIds);
    expect(r.moves.map((m) => m.taskId)).toEqual(["t0", "t2"]);
    expect(r.moves).toEqual([
      { taskId: "t0", startDate: "2026-11-30", dueDate: "2026-11-30" },
      { taskId: "t2", startDate: "2026-11-30", dueDate: "2026-12-02" },
    ]);
    // kickoff: the done task's later date stands; access: the deleted task no longer counts.
    expect(r.milestones[0].dueDate).toBe("2026-12-31");
    expect(r.milestones[1].dueDate).toBe("2026-12-02");
  });

  it("moving back to an earlier kickoff works the same way", () => {
    const r = planKickoffMove(payload, "2026-10-30", MON_FRI, applied(), msIds);
    expect(r.moves.map((m) => m.dueDate)).toEqual(["2026-10-30", "2026-11-02", "2026-11-03", "2026-11-06"]);
  });
});
