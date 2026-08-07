import { describe, it, expect } from "vitest";
import {
  taskUrgency, projectUrgency, rollUpUrgency, dayDiff,
  DUE_SOON_DAYS_DEFAULT, URGENCY_SEVERITY, URGENCY_LABEL,
  type UrgencyInput, type UrgencyTier,
} from "./pmUrgency";

const TODAY = "2026-08-06";
const open = (dueDate: string | null): UrgencyInput => ({ dueDate, isDone: false });
const done = (dueDate: string | null): UrgencyInput => ({ dueDate, isDone: true });

describe("dayDiff", () => {
  it("counts whole calendar days, signed", () => {
    expect(dayDiff(TODAY, "2026-08-09")).toBe(3);
    expect(dayDiff(TODAY, TODAY)).toBe(0);
    expect(dayDiff(TODAY, "2026-08-01")).toBe(-5);
  });

  it("crosses month and year boundaries", () => {
    expect(dayDiff("2026-08-31", "2026-09-01")).toBe(1);
    expect(dayDiff("2026-12-31", "2027-01-01")).toBe(1);
  });

  // The whole reason both arguments are date strings parsed at UTC midnight: a DST transition must
  // not make a calendar day 23 or 25 hours long and round the difference to the wrong integer.
  it("is unaffected by DST transitions", () => {
    expect(dayDiff("2026-03-28", "2026-03-30")).toBe(2); // EU spring-forward is 2026-03-29
    expect(dayDiff("2026-10-24", "2026-10-26")).toBe(2); // EU fall-back is 2026-10-25
  });

  it("tolerates a full ISO timestamp by truncating to its date part", () => {
    expect(dayDiff(TODAY, "2026-08-09T17:45:00.000Z")).toBe(3);
  });

  it("returns 0 rather than NaN on unparseable input", () => {
    expect(dayDiff(TODAY, "not-a-date")).toBe(0);
  });
});

describe("taskUrgency", () => {
  it("flags a past due date as overdue", () => {
    expect(taskUrgency(open("2026-08-05"), TODAY)).toBe("overdue");
    expect(taskUrgency(open("2025-01-01"), TODAY)).toBe("overdue");
  });

  // Boundary cases people actually notice and complain about.
  it("treats due TODAY as almost late, not overdue — you still have the day", () => {
    expect(taskUrgency(open(TODAY), TODAY)).toBe("due-soon");
  });

  it("puts the far edge of the window inside it, and one day past it outside", () => {
    expect(taskUrgency(open("2026-08-09"), TODAY)).toBe("due-soon");  // +3, the default window
    expect(taskUrgency(open("2026-08-10"), TODAY)).toBe("on-track");  // +4
  });

  it("is on-track well ahead of the window", () => {
    expect(taskUrgency(open("2026-12-01"), TODAY)).toBe("on-track");
  });

  it("reports undated when there is no due date", () => {
    expect(taskUrgency(open(null), TODAY)).toBe("undated");
  });

  it("reports undated on a malformed due date rather than guessing", () => {
    expect(taskUrgency(open("soon"), TODAY)).toBe("undated");
    expect(taskUrgency(open("2026-8-6"), TODAY)).toBe("undated");
  });

  // `done` outranks everything: a finished task must never glow red on a board, however late it ran.
  it("reports done for a completed task regardless of its date", () => {
    expect(taskUrgency(done("2020-01-01"), TODAY)).toBe("done");
    expect(taskUrgency(done(null), TODAY)).toBe("done");
    expect(taskUrgency(done("2026-12-01"), TODAY)).toBe("done");
  });

  it("honours a per-project window", () => {
    expect(taskUrgency(open("2026-08-13"), TODAY, { dueSoonDays: 7 })).toBe("due-soon");
    expect(taskUrgency(open("2026-08-13"), TODAY)).toBe("on-track");
  });

  it("with a zero window warns only on the due date itself", () => {
    expect(taskUrgency(open(TODAY), TODAY, { dueSoonDays: 0 })).toBe("due-soon");
    expect(taskUrgency(open("2026-08-07"), TODAY, { dueSoonDays: 0 })).toBe("on-track");
  });

  it("clamps a negative window to zero instead of inverting the rule", () => {
    expect(taskUrgency(open("2026-08-07"), TODAY, { dueSoonDays: -5 })).toBe("on-track");
    expect(taskUrgency(open("2026-08-05"), TODAY, { dueSoonDays: -5 })).toBe("overdue");
  });

  it("defaults to a 3-day window", () => {
    expect(DUE_SOON_DAYS_DEFAULT).toBe(3);
  });
});

describe("rollUpUrgency", () => {
  it("returns the worst tier present", () => {
    expect(rollUpUrgency(["on-track", "overdue", "due-soon"])).toBe("overdue");
    expect(rollUpUrgency(["on-track", "due-soon"])).toBe("due-soon");
    expect(rollUpUrgency(["on-track", "done"])).toBe("on-track");
  });

  // A project whose only signal is "some tasks have no due date" is not more urgent than one
  // running on time — otherwise every young project screams for attention.
  it("never lets undated or done outrank a real tier", () => {
    expect(rollUpUrgency(["undated", "on-track"])).toBe("on-track");
    expect(rollUpUrgency(["done", "due-soon"])).toBe("due-soon");
  });

  it("collapses an all-done set to done and an empty set to undated", () => {
    expect(rollUpUrgency(["done", "done"])).toBe("done");
    expect(rollUpUrgency([])).toBe("undated");
  });

  it("covers every tier in URGENCY_SEVERITY, worst first", () => {
    expect(URGENCY_SEVERITY).toEqual(["overdue", "due-soon", "on-track", "undated", "done"]);
    for (const tier of URGENCY_SEVERITY) {
      expect(rollUpUrgency([tier])).toBe(tier);
      expect(URGENCY_LABEL[tier]).toBeTruthy();
    }
  });
});

describe("projectUrgency", () => {
  it("rolls up the worst task tier and counts every tier", () => {
    const r = projectUrgency([open("2026-08-01"), open(TODAY), open("2026-12-01"), done(null)], TODAY);
    expect(r.tier).toBe("overdue");
    expect(r.counts).toEqual({ overdue: 1, "due-soon": 1, "on-track": 1, undated: 0, done: 1 });
  });

  it("is undated for a project with no tasks", () => {
    const r = projectUrgency([], TODAY);
    expect(r.tier).toBe("undated");
    expect(r.counts.overdue).toBe(0);
  });

  // The case a task-only roll-up hides, and the reason workstream H exists: the project has blown
  // its own authored target while every remaining task is comfortably scheduled.
  it("surfaces a project past its own target even when all tasks are on track", () => {
    const tasks = [open("2026-12-01"), open("2026-11-01")];
    expect(projectUrgency(tasks, TODAY).tier).toBe("on-track");
    expect(projectUrgency(tasks, TODAY, { projectDueDate: "2026-08-01" }).tier).toBe("overdue");
  });

  it("ignores the project's own date once the project is done", () => {
    const r = projectUrgency([done(null)], TODAY, { projectDueDate: "2020-01-01", projectIsDone: true });
    expect(r.tier).toBe("done");
  });

  it("does not fold in a project date the caller did not supply", () => {
    const r = projectUrgency([open("2026-12-01")], TODAY);
    expect(r.counts.undated).toBe(0);
    expect(r.tier).toBe("on-track");
  });

  it("passes the per-project window through to every task", () => {
    const r = projectUrgency([open("2026-08-13")], TODAY, { dueSoonDays: 7 });
    expect(r.tier).toBe("due-soon");
  });
});

describe("tier exhaustiveness", () => {
  // A new tier must be added to both the severity order and the label map, or a roll-up silently
  // drops it and a UI renders an empty badge.
  it("keeps URGENCY_SEVERITY and URGENCY_LABEL in sync", () => {
    const labelled = Object.keys(URGENCY_LABEL) as UrgencyTier[];
    expect([...URGENCY_SEVERITY].sort()).toEqual([...labelled].sort());
  });
});
