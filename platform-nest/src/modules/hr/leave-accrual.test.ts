// Leave accrual. Pure — no database, no clock.
//
// The three properties worth the file, and each has burned a real leave system somewhere:
//   1. Twelve monthly postings sum EXACTLY to the annual entitlement (no rounding drift).
//   2. A RE-RUN posts nothing (the endpoint gets fired twice; it must be a no-op, not a doubling).
//   3. Pending requests count against the balance (or two requests for the same fortnight both
//      look affordable right up until both are approved).
import { describe, it, expect } from "vitest";
import {
  carryoverExpiryDate, carryoverForYear, entitlementForYear, entitlementStartDate,
  evaluateRequest, planAccruals, type LeavePolicy,
} from "./leave-accrual";

/** The Indonesian statutory default: 12 days after 12 months of service (UU 13/2003 art. 79). */
const STATUTORY: LeavePolicy = {
  accrualMethod: "upfront",
  annualEntitlementMinutes: 5760,       // 12 days x 480
  waitingPeriodMonths: 12,
  prorateFirstYear: true,
  carryoverMaxMinutes: 0,
  carryoverExpiryMonths: 0,
  allowNegativeBalance: false,
};
const MONTHLY: LeavePolicy = { ...STATUTORY, accrualMethod: "monthly", waitingPeriodMonths: 0 };

describe("entitlementStartDate", () => {
  it("adds whole months, not 365 days", () => {
    // "12 months after 31 January" is 31 January, and in a leap year day-addition disagrees.
    expect(entitlementStartDate("2025-01-31", 12)).toBe("2026-01-31");
    expect(entitlementStartDate("2024-02-29", 12)).toBe("2025-03-01"); // Feb 29 rolls forward — later, never earlier
  });

  it("with no waiting period, entitlement starts on the hire date", () => {
    expect(entitlementStartDate("2026-03-15", 0)).toBe("2026-03-15");
  });
});

describe("entitlementForYear", () => {
  it("grants nothing while the waiting period is unfinished", () => {
    // Hired mid-2026 with a 12-month wait: nothing at all in 2026.
    expect(entitlementForYear(STATUTORY, { hireDate: "2026-07-01", year: 2026, asOf: "2026-12-31" })).toBe(0);
  });

  it("grants the full entitlement for a complete year of service", () => {
    expect(entitlementForYear(STATUTORY, { hireDate: "2020-01-01", year: 2026, asOf: "2026-12-31" })).toBe(5760);
  });

  it("pro-rates the year eligibility begins in", () => {
    // Hired 2025-07-01, eligible from 2026-07-01 — six months of the 2026 window (Jul..Dec).
    const got = entitlementForYear(STATUTORY, { hireDate: "2025-07-01", year: 2026, asOf: "2026-12-31" });
    expect(got).toBe(Math.round((5760 * 6) / 12));
  });

  it("does not pro-rate when the policy says not to", () => {
    const noProrate = { ...STATUTORY, prorateFirstYear: false };
    expect(entitlementForYear(noProrate, { hireDate: "2025-07-01", year: 2026, asOf: "2026-12-31" })).toBe(5760);
  });

  it("pro-rates a LEAVER's final year down", () => {
    const got = entitlementForYear(STATUTORY, {
      hireDate: "2020-01-01", year: 2026, asOf: "2026-12-31", terminationDate: "2026-06-30",
    });
    expect(got).toBeLessThan(5760);
    expect(got).toBe(Math.round((5760 * 6) / 12));
  });

  it("grants nothing for a year the person had already left before", () => {
    expect(entitlementForYear(STATUTORY, {
      hireDate: "2020-01-01", year: 2026, asOf: "2026-12-31", terminationDate: "2025-06-30",
    })).toBe(0);
  });

  it("accrual_method 'none' grants nothing — sick leave, which is a wage rule, not an entitlement", () => {
    expect(entitlementForYear({ ...STATUTORY, accrualMethod: "none" }, {
      hireDate: "2020-01-01", year: 2026, asOf: "2026-12-31",
    })).toBe(0);
  });
});

describe("planAccruals — upfront", () => {
  it("posts the whole entitlement once", () => {
    const p = planAccruals(STATUTORY, { hireDate: "2020-01-01", year: 2026, asOf: "2026-06-30" });
    expect(p).toHaveLength(1);
    expect(p[0].minutes).toBe(5760);
    expect(p[0].kind).toBe("accrual");
  });

  it("A RE-RUN POSTS NOTHING", () => {
    const p = planAccruals(STATUTORY, {
      hireDate: "2020-01-01", year: 2026, asOf: "2026-06-30", alreadyAccruedMinutes: 5760,
    });
    expect(p).toEqual([]);
  });

  it("posts only the shortfall when the ledger is partially filled", () => {
    const p = planAccruals(STATUTORY, {
      hireDate: "2020-01-01", year: 2026, asOf: "2026-06-30", alreadyAccruedMinutes: 1760,
    });
    expect(p).toHaveLength(1);
    expect(p[0].minutes).toBe(4000);
  });

  it("does not post before the anchor date has arrived", () => {
    // Eligible 2026-07-01, but the run is only up to March.
    expect(planAccruals(STATUTORY, { hireDate: "2025-07-01", year: 2026, asOf: "2026-03-31" })).toEqual([]);
  });
});

describe("planAccruals — monthly", () => {
  it("posts one row per completed month", () => {
    const p = planAccruals(MONTHLY, { hireDate: "2020-01-01", year: 2026, asOf: "2026-03-31" });
    expect(p).toHaveLength(3);
    expect(p.map((x) => x.periodEnd)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("TWELVE POSTINGS SUM EXACTLY TO THE ENTITLEMENT — no rounding drift", () => {
    // 5760/12 divides cleanly, so use a figure that does NOT: 5000 minutes.
    const awkward = { ...MONTHLY, annualEntitlementMinutes: 5000 };
    const p = planAccruals(awkward, { hireDate: "2020-01-01", year: 2026, asOf: "2026-12-31" });
    expect(p).toHaveLength(12);
    expect(p.reduce((s, x) => s + x.minutes, 0)).toBe(5000);
  });

  it("A RE-RUN MID-YEAR POSTS ONLY THE NEW MONTHS", () => {
    // Three months already on the ledger; the run now reaches June.
    const threeMonths = Math.round((5760 * 3) / 12);
    const p = planAccruals(MONTHLY, {
      hireDate: "2020-01-01", year: 2026, asOf: "2026-06-30", alreadyAccruedMinutes: threeMonths,
    });
    expect(p).toHaveLength(3);
    expect(p.map((x) => x.periodEnd)).toEqual(["2026-04-30", "2026-05-31", "2026-06-30"]);
  });

  it("a fully-caught-up ledger produces nothing", () => {
    const p = planAccruals(MONTHLY, {
      hireDate: "2020-01-01", year: 2026, asOf: "2026-12-31", alreadyAccruedMinutes: 5760,
    });
    expect(p).toEqual([]);
  });

  it("posts a partially-covered month's REMAINDER rather than skipping it", () => {
    // A hand adjustment covered half of January. The rest must not be stranded.
    const p = planAccruals(MONTHLY, {
      hireDate: "2020-01-01", year: 2026, asOf: "2026-01-31", alreadyAccruedMinutes: 200,
    });
    expect(p).toHaveLength(1);
    expect(p[0].minutes).toBe(480 - 200);
  });

  it("skips months inside the waiting period", () => {
    const waiting = { ...MONTHLY, waitingPeriodMonths: 3 };
    const p = planAccruals(waiting, { hireDate: "2026-01-01", year: 2026, asOf: "2026-06-30" });
    // Eligible from 2026-04-01, so January–March are skipped.
    expect(p.map((x) => x.periodEnd)).toEqual(["2026-04-30", "2026-05-31", "2026-06-30"]);
  });

  it("stops at a termination", () => {
    const p = planAccruals(MONTHLY, {
      hireDate: "2020-01-01", year: 2026, asOf: "2026-12-31", terminationDate: "2026-04-15",
    });
    expect(p.map((x) => x.periodEnd)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("handles February correctly in a leap year", () => {
    const p = planAccruals(MONTHLY, { hireDate: "2020-01-01", year: 2024, asOf: "2024-02-29" });
    expect(p[1].periodEnd).toBe("2024-02-29");
  });
});

describe("planAccruals — anniversary", () => {
  it("posts on the hire anniversary, and not before it", () => {
    const anniversary: LeavePolicy = { ...STATUTORY, accrualMethod: "anniversary", waitingPeriodMonths: 0 };
    expect(planAccruals(anniversary, { hireDate: "2020-06-15", year: 2026, asOf: "2026-06-14" })).toEqual([]);
    const p = planAccruals(anniversary, { hireDate: "2020-06-15", year: 2026, asOf: "2026-06-15" });
    expect(p).toHaveLength(1);
    expect(p[0].periodEnd).toBe("2026-06-15");
  });
});

describe("carryover", () => {
  const carrying: LeavePolicy = { ...STATUTORY, carryoverMaxMinutes: 2400, carryoverExpiryMonths: 3 };

  it("is capped by policy — an uncapped carryover is an unbounded liability", () => {
    expect(carryoverForYear(carrying, 5000)).toBe(2400);
    expect(carryoverForYear(carrying, 1000)).toBe(1000);
  });

  it("is zero when the policy does not allow it", () => {
    expect(carryoverForYear(STATUTORY, 5000)).toBe(0);
  });

  it("never goes negative from an overdrawn prior year", () => {
    expect(carryoverForYear(carrying, -500)).toBe(0);
  });

  it("is posted at 1 January, before the year's own entitlement", () => {
    const p = planAccruals(carrying, {
      hireDate: "2020-01-01", year: 2026, asOf: "2026-12-31", priorYearRemainingMinutes: 3000,
    });
    expect(p[0].kind).toBe("carryover");
    expect(p[0].minutes).toBe(2400);
    expect(p[0].periodStart).toBe("2026-01-01");
    expect(p[1].kind).toBe("accrual");
  });

  it("expires at the end of the month before the boundary", () => {
    // A 3-month expiry means "usable through 31 March".
    expect(carryoverExpiryDate(carrying, 2026)).toBe("2026-03-31");
    expect(carryoverExpiryDate(STATUTORY, 2026)).toBeNull();
  });
});

describe("evaluateRequest", () => {
  const balance = { allocatedMinutes: 5760, usedMinutes: 1920 };

  it("allows a request that fits", () => {
    const v = evaluateRequest(STATUTORY, balance, 960);
    expect(v.sufficient).toBe(true);
    expect(v.remainingMinutes).toBe(3840);
    expect(v.shortfallMinutes).toBe(0);
  });

  it("refuses a request that does not, and says by how much", () => {
    const v = evaluateRequest(STATUTORY, balance, 4800);
    expect(v.sufficient).toBe(false);
    expect(v.shortfallMinutes).toBe(960);
  });

  it("COUNTS PENDING REQUESTS — the double-spend guard", () => {
    // Without this, two requests for the same fortnight both look affordable until both are
    // approved, and the employee is 5 days overdrawn with nobody having made a mistake.
    const withPending = { ...balance, pendingMinutes: 3360 };
    expect(evaluateRequest(STATUTORY, withPending, 960).sufficient).toBe(false);
    expect(evaluateRequest(STATUTORY, balance, 960).sufficient).toBe(true);
  });

  it("permits an overdraw when the policy allows advance leave", () => {
    const advance = { ...STATUTORY, allowNegativeBalance: true };
    const v = evaluateRequest(advance, balance, 9999);
    expect(v.sufficient).toBe(true);
    expect(v.shortfallMinutes).toBeGreaterThan(0);   // still REPORTED, just not refused
  });
});
