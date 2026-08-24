// Separation-pay arithmetic. Pure.
//
// Same posture as payroll-calc.test.ts: this verifies the STRUCTURE of PP 35/2021's calculation —
// the bracket lookup, the three separate components, the per-ground multipliers, the refusal on an
// unknown ground — against the UNRATIFIED fixture. It deliberately does not assert that any
// particular ground's multiplier is legally correct; that is what `ratified_by` is for.
import { describe, it, expect } from "vitest";
import { computeSeverance, DEFAULT_SEVERANCE_UNRATIFIED as S, monthsFromTable } from "./severance";

const WAGE = 10_000_000;
const base = { monthlyWage: WAGE, hireDate: "2018-01-01", effectiveOn: "2026-01-01" };

describe("monthsFromTable", () => {
  it("brackets on COMPLETED years — 1.9 years pays the 1-year row", () => {
    // Flooring here rather than rounding is worth a month of wage in either direction.
    expect(monthsFromTable(S.severanceTable, 1.0)).toBe(2);
    expect(monthsFromTable(S.severanceTable, 1.9)).toBe(2);
    expect(monthsFromTable(S.severanceTable, 2.0)).toBe(3);
  });

  it("pays the first row below a full year", () => {
    expect(monthsFromTable(S.severanceTable, 0)).toBe(1);
    expect(monthsFromTable(S.severanceTable, 0.99)).toBe(1);
  });

  it("plateaus at the top of the table", () => {
    expect(monthsFromTable(S.severanceTable, 8)).toBe(9);
    expect(monthsFromTable(S.severanceTable, 30)).toBe(9);
  });

  it("the long-service table pays nothing under 3 years", () => {
    expect(monthsFromTable(S.serviceRewardTable, 2.9)).toBe(0);
    expect(monthsFromTable(S.serviceRewardTable, 3)).toBe(2);
    expect(monthsFromTable(S.serviceRewardTable, 24)).toBe(10);
  });

  it("both tables are monotonic", () => {
    for (const table of [S.severanceTable, S.serviceRewardTable]) {
      let previous = -1;
      for (const row of [...table].sort((a, b) => a.minYears - b.minYears)) {
        expect(row.months).toBeGreaterThanOrEqual(previous);
        previous = row.months;
      }
    }
  });
});

describe("computeSeverance", () => {
  it("REFUSES a ground the parameter set does not describe", () => {
    // Returning zero would produce a separation record that looks computed and is not.
    expect(() => computeSeverance(S, { ...base, ground: "abducted_by_aliens" })).toThrow(/no severance multipliers/);
  });

  it("a resignation earns entitlement compensation ONLY — no UP, no UPMK", () => {
    const r = computeSeverance(S, { ...base, ground: "resignation" });
    expect(r.severanceAmount).toBe(0);
    expect(r.serviceRewardAmount).toBe(0);
    expect(r.totalAmount).toBe(r.entitlementCompensationAmount);
  });

  it("a redundancy earns all three components", () => {
    const r = computeSeverance(S, { ...base, ground: "redundancy" });
    expect(r.severanceAmount).toBeGreaterThan(0);
    expect(r.serviceRewardAmount).toBeGreaterThan(0);
    expect(r.totalAmount).toBe(
      Number((r.severanceAmount + r.serviceRewardAmount + r.entitlementCompensationAmount).toFixed(2)),
    );
  });

  it("the components are kept SEPARATE — the statute applies different multipliers to each", () => {
    const redundancy = computeSeverance(S, { ...base, ground: "redundancy" });
    const retirement = computeSeverance(S, { ...base, ground: "retirement" });
    // Retirement carries a 1.75x severance multiplier but the SAME long-service multiplier, so the
    // two components must move independently. A single collapsed "severance" figure could not
    // express that at all.
    expect(retirement.severanceAmount).toBeGreaterThan(redundancy.severanceAmount);
    expect(retirement.serviceRewardAmount).toBe(redundancy.serviceRewardAmount);
  });

  it("death and prolonged illness carry the 2x severance multiplier", () => {
    const redundancy = computeSeverance(S, { ...base, ground: "redundancy" });
    for (const ground of ["death", "prolonged_illness"]) {
      const r = computeSeverance(S, { ...base, ground });
      expect(r.severanceAmount).toBe(Number((redundancy.severanceAmount * 2).toFixed(2)));
    }
  });

  it("a probation dismissal carries no statutory severance", () => {
    const r = computeSeverance(S, { ...base, hireDate: "2025-11-01", ground: "probation_fail" });
    expect(r.severanceAmount).toBe(0);
    expect(r.serviceRewardAmount).toBe(0);
  });

  it("misconduct defaults to zero and SAYS it is sub-ground dependent", () => {
    // The conservative default plus an explicit note, rather than a confident number on the most
    // contested ground there is.
    const r = computeSeverance(S, { ...base, ground: "misconduct" });
    expect(r.severanceAmount).toBe(0);
    expect(String(r.workings.groundNote)).toMatch(/disputed/i);
  });

  it("encashes unused leave into the entitlement component", () => {
    const withoutLeave = computeSeverance(S, { ...base, ground: "resignation" });
    const withLeave = computeSeverance(S, { ...base, ground: "resignation", unusedLeaveMinutes: 480 * 10 });
    expect(withLeave.entitlementCompensationAmount).toBeGreaterThan(withoutLeave.entitlementCompensationAmount);
    // 10 days against a 21-working-day month is 10/21 of a month's wage.
    expect(withLeave.entitlementCompensationAmount).toBeCloseTo((WAGE * 10) / 21, 0);
  });

  it("adds contractual extras on top", () => {
    const r = computeSeverance(S, { ...base, ground: "resignation", otherEntitlements: 5_000_000 });
    expect(r.entitlementCompensationAmount).toBe(5_000_000);
  });

  it("scales with the wage", () => {
    const low = computeSeverance(S, { ...base, ground: "redundancy", monthlyWage: 5_000_000 });
    const high = computeSeverance(S, { ...base, ground: "redundancy", monthlyWage: 10_000_000 });
    expect(high.severanceAmount).toBe(Number((low.severanceAmount * 2).toFixed(2)));
  });

  it("shows its workings, including which bracket and multiplier were used", () => {
    const r = computeSeverance(S, { ...base, ground: "redundancy" });
    expect(r.workings.uangPesangon).toMatchObject({ tableMonths: expect.any(Number), multiplier: expect.any(Number) });
    expect(r.workings.uangPenghargaan).toHaveProperty("tableMonths");
    expect(r.workings.completedYears).toBe(8);
  });

  it("a day short of an anniversary stays in the lower bracket", () => {
    // The boundary that is worth a month of wage. 2018-01-01 to 2025-12-31 is 7 completed years.
    const dayBefore = computeSeverance(S, { ...base, ground: "redundancy", effectiveOn: "2025-12-31" });
    const onTheDay = computeSeverance(S, { ...base, ground: "redundancy", effectiveOn: "2026-01-01" });
    expect(dayBefore.workings.completedYears).toBe(7);
    expect(onTheDay.workings.completedYears).toBe(8);
    expect(onTheDay.severanceAmount).toBeGreaterThan(dayBefore.severanceAmount);
  });
});
