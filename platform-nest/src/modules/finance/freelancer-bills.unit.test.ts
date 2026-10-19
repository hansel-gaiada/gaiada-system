// DW-10f-4a — the pure helpers of freelancer-bills.service.ts (no database, no Cerbos). The money itself is SQL `numeric`
// and is proven by the HTTP suite (freelancer-bills.test.ts) on the Linux gate; this file pins the input rules that decide
// what reaches the database.
import { describe, it, expect } from "vitest";
import { ConflictException } from "@nestjs/common";
import { daysInclusive, isIsoDate, mapFreelancerDbError, parsePositiveAmount, periodProblem } from "./freelancer-bills.service";

describe("isIsoDate", () => {
  it("accepts real calendar dates only", () => {
    expect(isIsoDate("2026-03-31")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-3-1", "31-03-2026", "2026-03-31T00:00", "", null, 20260331]) {
      expect(isIsoDate(bad), String(bad)).toBe(false);
    }
  });
});

describe("periodProblem (§61.8 period_invalid)", () => {
  it("holds for a month and for exactly 366 days", () => {
    expect(periodProblem("2026-03-01", "2026-03-31")).toBeNull();
    expect(periodProblem("2026-03-01", "2026-03-01")).toBeNull();
    expect(daysInclusive("2027-01-01", "2027-12-31")).toBe(365);
    expect(periodProblem("2027-01-01", "2028-01-01")).toBeNull(); // 366 days
  });
  it("refuses malformed dates, an end before the start, and more than 366 days", () => {
    expect(periodProblem("2026-03-01", undefined)).toMatch(/dates/);
    expect(periodProblem("2026-02-30", "2026-03-31")).toMatch(/dates/);
    expect(periodProblem("2026-03-31", "2026-03-01")).toMatch(/before/);
    expect(periodProblem("2027-01-01", "2028-01-02")).toMatch(/366/);
  });
});

describe("parsePositiveAmount (rate_invalid)", () => {
  it("returns canonical decimal text, never a float", () => {
    expect(parsePositiveAmount("150000", 0)).toBe("150000");
    expect(parsePositiveAmount(150000, 0)).toBe("150000");
    expect(parsePositiveAmount("0012.50", 2)).toBe("12.5");
    expect(parsePositiveAmount("12.3400", 2)).toBe("12.34"); // trailing zeros are not extra precision
    expect(parsePositiveAmount("0.5", 2)).toBe("0.5");
  });
  it("refuses zero, negatives, exponents, junk, and more decimals than the currency allows", () => {
    for (const bad of ["0", "0.00", "-5", "1e5", 1e21, "abc", "", " ", null, undefined, Number.NaN, "12.345"]) {
      expect(parsePositiveAmount(bad, 2), String(bad)).toBeNull();
    }
    expect(parsePositiveAmount("150000.5", 0)).toBeNull(); // IDR has no minor unit
    expect(parsePositiveAmount("1.23456", 4)).toBeNull(); // the column holds 4
    expect(parsePositiveAmount("12345678901234567", 0)).toBeNull(); // numeric(20,4) holds 16 integer digits
  });
});

describe("mapFreelancerDbError", () => {
  const pg = (code: string, constraint?: string) => Object.assign(new Error("db"), { code, constraint });
  const reasonOf = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof ConflictException) return (e.getResponse() as { reason: string }).reason;
      throw e;
    }
    return "no throw";
  };
  it("maps the walls to their §61 answers", () => {
    expect(reasonOf(() => mapFreelancerDbError(pg("23P01", "ex_finance_freelancer_rates_no_overlap")))).toBe("rate_overlap");
    expect(reasonOf(() => mapFreelancerDbError(pg("23505", "ux_finance_ap_vendors_user_live")))).toBe("person_has_vendor");
    expect(reasonOf(() => mapFreelancerDbError(pg("PD616")))).toBe("conflict");
    expect(reasonOf(() => mapFreelancerDbError(pg("PD617")))).toBe("bill_not_draft");
  });
  it("lets anything else through untouched", () => {
    const other = pg("23505", "ux_finance_ap_vendors_code_live");
    expect(() => mapFreelancerDbError(other)).toThrow(other);
    expect(() => mapFreelancerDbError(pg("23P01", "ex_hr_compensation_no_overlap"))).toThrow("db");
  });
});
