// DW-4e-3 — the PURE half of the department appraisal (dept-appraisals.ts, docs/FRONTEND-BFF-CONTRACT.md §41.1): the
// month-by-month history's enumeration, the month the cycle's target is read at, the score bands, and the people
// aggregate with its withholding rule. No DB, no Cerbos. The live half (the gate, the writes, the agreement with
// GET /dept-kpis month by month) is dept-appraisals.controller.db.test.ts.
import { describe, it, expect } from "vitest";
import {
  APPRAISAL_STATUSES,
  MIN_SCORED_FOR_DISTRIBUTION,
  aggregatePeople,
  cycleMonthStarts,
  lastMonthStart,
  scoreBand,
  type PeopleRow,
} from "./dept-appraisals";

describe("cycleMonthStarts — every calendar month the cycle touches", () => {
  it("a half-year cycle is six month starts, oldest first", () => {
    expect(cycleMonthStarts("2026-07-01", "2026-12-31")).toEqual([
      "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01",
    ]);
  });

  it("a single-month cycle is one start, and a one-day cycle is its month", () => {
    expect(cycleMonthStarts("2026-09-01", "2026-09-30")).toEqual(["2026-09-01"]);
    expect(cycleMonthStarts("2026-09-17", "2026-09-17")).toEqual(["2026-09-01"]);
  });

  it("a cycle that starts and ends mid-month includes both partial months", () => {
    expect(cycleMonthStarts("2026-07-15", "2026-09-10")).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
  });

  it("crosses a year boundary and a leap February without skipping or repeating a month", () => {
    expect(cycleMonthStarts("2027-11-01", "2028-03-31")).toEqual(["2027-11-01", "2027-12-01", "2028-01-01", "2028-02-01", "2028-03-01"]);
  });

  it("the 400-day cap yields at most 15 months", () => {
    // 400 days from 2026-01-31 ends 2027-03-06: Jan 2026 .. Mar 2027
    const months = cycleMonthStarts("2026-01-31", "2027-03-06");
    expect(months[0]).toBe("2026-01-01");
    expect(months[months.length - 1]).toBe("2027-03-01");
    expect(months.length).toBe(15);
    expect(new Set(months).size).toBe(months.length);
  });
});

describe("lastMonthStart — the month whose in-force target judges the cycle", () => {
  it("is the start of the month holding the cycle's last day", () => {
    expect(lastMonthStart("2026-12-31")).toBe("2026-12-01");
    expect(lastMonthStart("2026-09-30")).toBe("2026-09-01");
    expect(lastMonthStart("2026-09-01")).toBe("2026-09-01");
    expect(lastMonthStart("2028-02-29")).toBe("2028-02-01");
  });

  it("is always the last entry of the history's months", () => {
    for (const [s, e] of [["2026-07-01", "2026-12-31"], ["2026-07-15", "2026-09-10"], ["2027-11-01", "2028-03-31"]]) {
      const months = cycleMonthStarts(s, e);
      expect(lastMonthStart(e)).toBe(months[months.length - 1]);
    }
  });
});

describe("scoreBand — a composite to a band 1..5", () => {
  it("rounds to the nearest band, halves up", () => {
    expect(scoreBand(3.49)).toBe(3);
    expect(scoreBand(3.5)).toBe(4);
    expect(scoreBand(4.4)).toBe(4);
    expect(scoreBand(2)).toBe(2);
  });

  it("is clamped to 1..5", () => {
    expect(scoreBand(0)).toBe(1);
    expect(scoreBand(0.4)).toBe(1);
    expect(scoreBand(5.4)).toBe(5);
    expect(scoreBand(9)).toBe(5);
  });
});

const row = (status: string, composite: string | number | null): PeopleRow => ({ status, composite });

describe("aggregatePeople — counts, and the distribution unless it would expose an individual", () => {
  it("counts every status, zeros included", () => {
    const a = aggregatePeople([row("draft", null), row("submitted", "3.00"), row("finalized", "4.50")]);
    expect(a.total).toBe(3);
    expect(a.byStatus).toEqual({ draft: 1, submitted: 1, acknowledged: 0, disputed: 0, finalized: 1 });
    expect(Object.keys(a.byStatus)).toEqual([...APPRAISAL_STATUSES]);
  });

  it("an empty roster is a zero block with the distribution withheld", () => {
    const a = aggregatePeople([]);
    expect(a).toEqual({
      total: 0,
      byStatus: { draft: 0, submitted: 0, acknowledged: 0, disputed: 0, finalized: 0 },
      distribution: null,
      reason: "too_few",
    });
  });

  it("the distribution is withheld below 3 scored rows, with reason too_few", () => {
    expect(MIN_SCORED_FOR_DISTRIBUTION).toBe(3);
    const two = aggregatePeople([row("submitted", "4.00"), row("finalized", "2.00"), row("draft", null), row("draft", null)]);
    expect(two.total).toBe(4);
    expect(two.distribution).toBeNull();
    expect(two.reason).toBe("too_few");
    // withheld means the bands appear NOWHERE in the payload
    expect(JSON.stringify(two)).not.toContain("band");
  });

  it("a draft is never scored, even when it carries a composite", () => {
    const a = aggregatePeople([row("draft", "5.00"), row("draft", "5.00"), row("draft", "5.00"), row("submitted", "3.00")]);
    expect(a.distribution).toBeNull();
    expect(a.reason).toBe("too_few");
    expect(a.byStatus.draft).toBe(3);
  });

  it("a submitted-or-later row with no composite is not counted as scored", () => {
    const a = aggregatePeople([row("submitted", null), row("acknowledged", "3.00"), row("disputed", "3.00")]);
    expect(a.distribution).toBeNull();
  });

  it("at exactly 3 scored rows the distribution is shown, five bands in order, summing to the scored rows", () => {
    const a = aggregatePeople([row("submitted", "3.20"), row("acknowledged", "3.40"), row("disputed", "4.60"), row("draft", null)]);
    expect(a.reason).toBeUndefined();
    expect(a.distribution).toEqual([
      { band: 1, count: 0 }, { band: 2, count: 0 }, { band: 3, count: 2 }, { band: 4, count: 0 }, { band: 5, count: 1 },
    ]);
    expect(a.distribution!.reduce((n, b) => n + b.count, 0)).toBe(3);
    expect(a.total).toBe(4);
  });

  it("composite arrives as a numeric string from the driver and as a number: both band the same", () => {
    const a = aggregatePeople([row("finalized", "2.50"), row("finalized", 2.5), row("finalized", "1.00")]);
    expect(a.distribution).toEqual([
      { band: 1, count: 1 }, { band: 2, count: 0 }, { band: 3, count: 2 }, { band: 4, count: 0 }, { band: 5, count: 0 },
    ]);
  });

  it("the payload carries no per-person field: only counts", () => {
    const a = aggregatePeople([row("submitted", "3.00"), row("submitted", "4.00"), row("submitted", "5.00")]);
    expect(Object.keys(a).sort()).toEqual(["byStatus", "distribution", "total"]);
    for (const b of a.distribution!) expect(Object.keys(b).sort()).toEqual(["band", "count"]);
  });
});
