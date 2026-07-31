import { describe, it, expect } from "vitest";
import {
  buildCalendarDays, summarizeSelfCompliance, formatMinutes, addDaysIso,
  type CheckinHistoryEntry, type CheckinDayStatus,
} from "./checkins";
import type { CheckinDayStatus as ChartCheckinDayStatus } from "@/components/reports/charts/CalendarHeatmap";

function entry(date: string, status: CheckinHistoryEntry["status"]): CheckinHistoryEntry {
  return { id: `c-${date}`, date, status, summary: "", blockers: null, edited: false, source: "ui", submittedAt: null, excusedReason: null };
}

describe("checkins — pure helpers (TR-10/TR-38)", () => {
  it("addDaysIso walks calendar days including across month boundaries", () => {
    expect(addDaysIso("2026-07-30", 1)).toBe("2026-07-31");
    expect(addDaysIso("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDaysIso("2026-08-01", -1)).toBe("2026-07-31");
  });

  it("formatMinutes matches the backend's own formatting exactly", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(225)).toBe("3h 45m");
  });

  describe("buildCalendarDays (TR-38 — the false-negative guard applied to a dense calendar)", () => {
    it("maps a submitted row to submitted, an auto_missed row to missed, an excused row to excused", () => {
      const history = [entry("2026-07-01", "submitted"), entry("2026-07-02", "auto_missed"), entry("2026-07-03", "excused")];
      const days = buildCalendarDays(history, "2026-07-01", "2026-07-03");
      expect(days.map((d) => d.status)).toEqual(["submitted", "missed", "excused"]);
    });

    it("maps a day with NO row to not_expected — never to missed (weekend/holiday/leave/unprocessed)", () => {
      const days = buildCalendarDays([], "2026-07-01", "2026-07-03");
      expect(days.every((d) => d.status === "not_expected")).toBe(true);
    });

    it("never renders an excused or not-expected day as missed, across a mixed range", () => {
      const history = [entry("2026-07-05", "excused")];
      const days = buildCalendarDays(history, "2026-07-01", "2026-07-06");
      const byDate = new Map(days.map((d) => [d.date, d.status]));
      expect(byDate.get("2026-07-05")).toBe("excused");
      // Every other day in range has no row -> not_expected, not missed.
      for (const d of days) if (d.date !== "2026-07-05") expect(d.status).toBe("not_expected");
      expect(days.some((d) => d.status === "missed")).toBe(false);
    });

    it("today (last day of range, no row yet) is never shown as missed", () => {
      const days = buildCalendarDays([], "2026-07-10", "2026-07-10");
      expect(days[0].status).not.toBe("missed");
      expect(days[0].status).toBe("not_expected");
    });

    it("produces one entry per day in an inclusive range, in order", () => {
      const days = buildCalendarDays([], "2026-07-01", "2026-07-05");
      expect(days.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]);
    });

    it("its CheckinDayStatus union stays in lockstep with CalendarHeatmap's own type", () => {
      // A compile-time check: if either union drifts, this assignment stops type-checking.
      const a: CheckinDayStatus = "not_expected";
      const b: ChartCheckinDayStatus = a;
      expect(b).toBe("not_expected");
    });
  });

  describe("summarizeSelfCompliance (TR-10 — the self-permitted streak/compliance strip)", () => {
    it("counts submitted/missed/excused separately and excludes excused from the rate denominator", () => {
      const history = [
        entry("2026-07-01", "submitted"), entry("2026-07-02", "submitted"),
        entry("2026-07-03", "auto_missed"),
        entry("2026-07-04", "excused"),
      ];
      const s = summarizeSelfCompliance(history);
      expect(s.submittedCount).toBe(2);
      expect(s.missedCount).toBe(1);
      expect(s.excusedCount).toBe(1);
      // rate = submitted / (submitted + missed) = 2/3, NOT 2/4 — an excused day must never look
      // like a personal shortfall (this file's header comment explains why this diverges from the
      // official §18 grid's own submitted/expected formula).
      expect(s.rate).toBeCloseTo(2 / 3);
    });

    it("returns a null rate when there is no evidence yet (empty window)", () => {
      expect(summarizeSelfCompliance([]).rate).toBeNull();
    });

    it("current streak counts consecutive submitted days walking back from most recent, unbroken by excused days", () => {
      const history = [
        entry("2026-07-05", "submitted"), // most recent
        entry("2026-07-04", "submitted"),
        entry("2026-07-03", "excused"), // forgiven gap — doesn't break the streak
        entry("2026-07-02", "submitted"),
        entry("2026-07-01", "auto_missed"), // breaks it
      ];
      expect(summarizeSelfCompliance(history).currentStreak).toBe(3);
    });

    it("a missed day immediately before the most recent day breaks the streak at zero", () => {
      const history = [entry("2026-07-02", "auto_missed"), entry("2026-07-01", "submitted")];
      expect(summarizeSelfCompliance(history).currentStreak).toBe(0);
    });
  });
});
