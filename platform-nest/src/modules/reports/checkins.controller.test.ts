// TR-09 — pure-core tests (no DB): the prefill composer, the compliance grid tally, and period
// resolution. checkins.controller.db.test.ts pins the SQL + endpoint + authz behavior against live
// Postgres/Cerbos; this file pins the RULES, mirroring fact-job.test.ts's split for the same file.
import { describe, it, expect } from "vitest";
import {
  composeCheckinPrefill,
  buildComplianceGrid,
  resolveCheckinPeriod,
  todayIsoInTz,
  type PrefillGatherInputs,
  type ComplianceGridInputs,
} from "./checkins.controller";
import { DEFAULT_WORK_CALENDAR } from "./fact-job";

describe("TR-09 composeCheckinPrefill (the <30s flow's actual content)", () => {
  const empty: PrefillGatherInputs = { timeEntries: [], activities: [] };

  it("an entirely quiet day produces a non-blank, honest prompt rather than a silent blank", () => {
    const out = composeCheckinPrefill(empty);
    expect(out.summaryText.length).toBeGreaterThan(0);
    expect(out.summaryText).toMatch(/no tracked activity/i);
    expect(out.minutesLogged).toBe(0);
  });

  it("summarizes logged time grouped by project, largest first", () => {
    const inputs: PrefillGatherInputs = {
      timeEntries: [
        { projectId: "p1", projectName: "Alpha", minutes: 30, billable: true },
        { projectId: "p2", projectName: "Beta", minutes: 90, billable: false },
        { projectId: "p1", projectName: "Alpha", minutes: 15, billable: true },
      ],
      activities: [],
    };
    const out = composeCheckinPrefill(inputs);
    expect(out.minutesLogged).toBe(135);
    expect(out.minutesBillable).toBe(45);
    expect(out.byProject.map((p) => p.projectId)).toEqual(["p2", "p1"]); // Beta (90) before Alpha (45)
    expect(out.summaryText).toMatch(/Logged 2h 15m across 2 projects/);
  });

  it("dedupes a same-day complete->reopen->complete ping-pong to ONE completed task, not two", () => {
    const inputs: PrefillGatherInputs = {
      timeEntries: [],
      activities: [
        { verb: "completed", objectKind: "pm_task", objectRef: "t1", title: "Ship the thing", source: "pm" },
        { verb: "reopened", objectKind: "pm_task", objectRef: "t1", title: "Ship the thing", source: "pm" },
        { verb: "completed", objectKind: "pm_task", objectRef: "t1", title: "Ship the thing", source: "pm" },
      ],
    };
    const out = composeCheckinPrefill(inputs);
    expect(out.tasksCompleted).toHaveLength(1);
    expect(out.tasksCompleted[0].title).toBe("Ship the thing");
    // "completed" already tells the story; a task that ALSO reopened same-day should not
    // additionally appear in "moved" (that would be double-mentioning the same task).
    expect(out.tasksMoved).toHaveLength(0);
  });

  it("counts comments, doc updates, and 'other' (non pm_task/doc) activity separately", () => {
    const inputs: PrefillGatherInputs = {
      timeEntries: [],
      activities: [
        { verb: "commented", objectKind: "pm_task", objectRef: "t1", title: "X", source: "pm" },
        { verb: "commented", objectKind: "pm_task", objectRef: "t1", title: "X", source: "pm" },
        { verb: "updated", objectKind: "doc", objectRef: "d1", title: "Spec", source: "pm" },
        { verb: "committed", objectKind: "commit", objectRef: "c1", title: null, source: "github" },
      ],
    };
    const out = composeCheckinPrefill(inputs);
    expect(out.commentsAuthored).toBe(2);
    expect(out.docsUpdated).toBe(1);
    expect(out.otherActivityEvents).toBe(1);
    expect(out.summaryText).toMatch(/2 comments/);
    expect(out.summaryText).toMatch(/1 doc update/);
    expect(out.summaryText).toMatch(/1 other activity event/);
  });

  it("status_changed / reopened (without a same-day completion) surfaces as 'moved'", () => {
    const inputs: PrefillGatherInputs = {
      timeEntries: [],
      activities: [{ verb: "status_changed", objectKind: "pm_task", objectRef: "t2", title: "Refactor auth", source: "pm" }],
    };
    const out = composeCheckinPrefill(inputs);
    expect(out.tasksMoved.map((t) => t.title)).toEqual(["Refactor auth"]);
    expect(out.summaryText).toMatch(/Moved: Refactor auth/);
  });
});

describe("TR-09 buildComplianceGrid (the false-negative guard, at grid scale)", () => {
  const base: ComplianceGridInputs = {
    from: "2026-07-13", // Monday
    to: "2026-07-17", // Friday
    calendar: DEFAULT_WORK_CALENDAR,
    memberships: [
      { userId: "alice", unitNodeId: "d-seo", validFrom: "2026-01-01", validTo: null },
      { userId: "bob", unitNodeId: "d-web", validFrom: "2026-01-01", validTo: null },
    ],
    approvedLeave: [],
    attendanceOff: [],
    checkins: [],
    unitFilter: null,
  };

  it("a person on approved leave for the WHOLE window has expectedDays 0, never counted as missed", () => {
    const rows = buildComplianceGrid({
      ...base,
      approvedLeave: [{ userId: "alice", startsOn: "2026-07-13", endsOn: "2026-07-17" }],
      checkins: [
        { userId: "bob", date: "2026-07-13", status: "submitted" },
        { userId: "bob", date: "2026-07-14", status: "submitted" },
        { userId: "bob", date: "2026-07-15", status: "submitted" },
        { userId: "bob", date: "2026-07-16", status: "submitted" },
        { userId: "bob", date: "2026-07-17", status: "submitted" },
      ],
    });
    const alice = rows.find((r) => r.userId === "alice");
    expect(alice).toBeUndefined(); // 0 expected days -> not even a row, never a false negative
    const bob = rows.find((r) => r.userId === "bob")!;
    expect(bob.expectedDays).toBe(5);
    expect(bob.submittedDays).toBe(5);
    expect(bob.complianceRate).toBe(1);
  });

  it("a day with no report_checkins row at all counts as missed (not silently dropped)", () => {
    const rows = buildComplianceGrid({ ...base, memberships: [base.memberships[0]] });
    const alice = rows.find((r) => r.userId === "alice")!;
    expect(alice.expectedDays).toBe(5);
    expect(alice.missedDays).toBe(5);
    expect(alice.complianceRate).toBe(0);
  });

  it("an excused day counts separately from missed, and never divides the compliance rate down", () => {
    const rows = buildComplianceGrid({
      ...base,
      memberships: [base.memberships[0]],
      checkins: [{ userId: "alice", date: "2026-07-14", status: "excused" }],
    });
    const alice = rows.find((r) => r.userId === "alice")!;
    expect(alice.expectedDays).toBe(5);
    expect(alice.excusedDays).toBe(1);
    expect(alice.missedDays).toBe(4);
    expect(alice.submittedDays).toBe(0);
  });

  it("a unitFilter narrows the grid to only that unit's members", () => {
    const rows = buildComplianceGrid({ ...base, unitFilter: "d-seo" });
    expect(rows.map((r) => r.userId)).toEqual(["alice"]);
  });

  it("a weekend/holiday inside the window contributes zero expected days for everyone", () => {
    const rows = buildComplianceGrid({
      ...base,
      from: "2026-07-17",
      to: "2026-07-19", // Fri(holiday), Sat, Sun
      calendar: { ...DEFAULT_WORK_CALENDAR, holidays: ["2026-07-17"] },
      memberships: [base.memberships[0]],
    });
    expect(rows.find((r) => r.userId === "alice")).toBeUndefined();
  });
});

describe("TR-09 resolveCheckinPeriod", () => {
  it("day: from===to===start", () => {
    expect(resolveCheckinPeriod("day", "2026-07-15", undefined)).toEqual({ from: "2026-07-15", to: "2026-07-15" });
  });

  it("week: Monday-Sunday containing start, regardless of which weekday start is", () => {
    expect(resolveCheckinPeriod("week", "2026-07-16", undefined)).toEqual({ from: "2026-07-13", to: "2026-07-19" });
    expect(resolveCheckinPeriod("week", "2026-07-13", undefined)).toEqual({ from: "2026-07-13", to: "2026-07-19" });
    expect(resolveCheckinPeriod("week", "2026-07-19", undefined)).toEqual({ from: "2026-07-13", to: "2026-07-19" });
  });

  it("month: first through last calendar day", () => {
    expect(resolveCheckinPeriod("month", "2026-02-10", undefined)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("custom: requires end, end>=start", () => {
    expect(resolveCheckinPeriod("custom", "2026-07-01", "2026-07-10")).toEqual({ from: "2026-07-01", to: "2026-07-10" });
    expect(() => resolveCheckinPeriod("custom", "2026-07-10", undefined)).toThrow();
    expect(() => resolveCheckinPeriod("custom", "2026-07-10", "2026-07-01")).toThrow();
  });

  it("an unknown periodKind is rejected", () => {
    expect(() => resolveCheckinPeriod("quarter", "2026-07-01", undefined)).toThrow();
  });
});

describe("TR-09 todayIsoInTz", () => {
  it("formats as YYYY-MM-DD in the given zone", () => {
    // 2026-07-15T23:30:00Z is still 2026-07-15 in UTC but already 2026-07-16 in Jakarta (+7).
    const utcInstant = new Date("2026-07-15T23:30:00.000Z");
    expect(todayIsoInTz("UTC", utcInstant)).toBe("2026-07-15");
    expect(todayIsoInTz("Asia/Jakarta", utcInstant)).toBe("2026-07-16");
  });
});
