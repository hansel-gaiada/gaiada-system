import { describe, it, expect } from "vitest";
import { deadlineResolver, nthWorkingDayAfter } from "./working-deadline";

// DW-7j (BFF §40.6.1): "the end of the Nth working day after the creation day". Pure: no DB. September 2026: Sep 2 is a Wednesday,
// Sep 4 a Friday, Sep 5 and 6 the weekend, Sep 7 a Monday.
const MON_FRI = {};
const withHoliday = { holidays: [{ day: "2026-09-07", kind: "company" as const }] };

describe("nthWorkingDayAfter", () => {
  it("is the next weekday for N = 1 on an ordinary day", () => {
    expect(nthWorkingDayAfter("2026-09-02", 1, MON_FRI)).toBe("2026-09-03"); // Wed -> Thu
  });

  it("skips a weekend: a Friday's 1st working day after is the Monday", () => {
    expect(nthWorkingDayAfter("2026-09-04", 1, MON_FRI)).toBe("2026-09-07");
  });

  it("a creation day on the weekend counts from the next working day: Saturday and Sunday both give Monday", () => {
    expect(nthWorkingDayAfter("2026-09-05", 1, MON_FRI)).toBe("2026-09-07");
    expect(nthWorkingDayAfter("2026-09-06", 1, MON_FRI)).toBe("2026-09-07");
  });

  it("skips a holiday, whatever its kind, as well as the weekend: Friday -> Tuesday when Monday is a holiday", () => {
    expect(nthWorkingDayAfter("2026-09-04", 1, withHoliday)).toBe("2026-09-08");
    for (const kind of ["public", "joint_leave", "company"] as const) {
      expect(nthWorkingDayAfter("2026-09-04", 1, { holidays: [{ day: "2026-09-07", kind }] })).toBe("2026-09-08");
    }
  });

  it("counts N working days: 2 after Wednesday is Friday; 2 after Thursday is Monday; 2 after Friday with a Monday holiday is Wednesday", () => {
    expect(nthWorkingDayAfter("2026-09-02", 2, MON_FRI)).toBe("2026-09-04");
    expect(nthWorkingDayAfter("2026-09-03", 2, MON_FRI)).toBe("2026-09-07");
    expect(nthWorkingDayAfter("2026-09-04", 2, withHoliday)).toBe("2026-09-09");
  });

  it("the creation day itself never counts, even when it is a working day; N <= 0 is the creation day", () => {
    expect(nthWorkingDayAfter("2026-09-02", 1, MON_FRI)).not.toBe("2026-09-02");
    expect(nthWorkingDayAfter("2026-09-02", 0, MON_FRI)).toBe("2026-09-02");
  });

  it("honours a calendar's own weekend (Friday and Saturday off): the 1st working day after Thursday is Sunday", () => {
    expect(nthWorkingDayAfter("2026-09-03", 1, { weekendDays: [5, 6] })).toBe("2026-09-06");
  });

  it("a consecutive run of holidays is skipped, and it crosses a month end", () => {
    const run = { holidays: ["2026-09-29", "2026-09-30", "2026-10-01"].map((day) => ({ day, kind: "public" as const })) };
    expect(nthWorkingDayAfter("2026-09-28", 1, run)).toBe("2026-10-02");
  });

  it("a calendar with no working day at all does not loop for ever", () => {
    expect(typeof nthWorkingDayAfter("2026-09-02", 1, { weekendDays: [1, 2, 3, 4, 5, 6, 7] })).toBe("string");
  });
});

describe("deadlineResolver", () => {
  it("answers as nthWorkingDayAfter does, for each created day", () => {
    const of = deadlineResolver(1, withHoliday);
    expect(of("2026-09-04")).toBe("2026-09-08");
    expect(of("2026-09-04")).toBe("2026-09-08"); // memoised, same answer
    expect(of("2026-09-02")).toBe("2026-09-03");
  });
});
