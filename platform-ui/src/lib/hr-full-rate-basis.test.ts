// Pins the UI's copy of the annualisation factors.
//
// `monthlyEquivalent` is a THIRD copy of a multiplier that also lives in platform-nest
// (`annualisationFactor`) and in Postgres (`hr_annualisation_factor`). platform-ui is a separate
// project and cannot import from platform-nest, so the duplication is unavoidable — but a
// duplicated constant that drifts means two parts of the system disagreeing about someone's salary,
// and the disagreement would surface as a headline payroll figure that quietly stops matching the
// payslips underneath it.
//
// So the numbers are asserted LITERALLY here. platform-nest's `payroll-rate-basis.test.ts` asserts
// its own copy against the database. Neither test can see the other, which is exactly why both
// state the values outright rather than deriving them: a change on either side must be made
// deliberately in two places, and this file is where the UI side fails if it is not.
//
// vitest aliases `server-only` to an empty module, so importing the server-only `hr-full` here is
// fine — and `monthlyEquivalent` is pure, with no I/O of its own.
import { describe, it, expect } from "vitest";
import { monthlyEquivalent } from "./hr-full";

describe("monthlyEquivalent", () => {
  it("uses the same factors platform-nest and Postgres use", () => {
    // 2080 = 40h x 52w, 260 = 5d x 52w — full-time-equivalent defaults. A contract with different
    // hours scales through `fte`, not by meaning something else by "hourly".
    expect(monthlyEquivalent(1, "hourly")).toBeCloseTo(2080 / 12, 10);
    expect(monthlyEquivalent(1, "daily")).toBeCloseTo(260 / 12, 10);
    expect(monthlyEquivalent(1, "weekly")).toBeCloseTo(52 / 12, 10);
    expect(monthlyEquivalent(1, "monthly")).toBe(1);
    expect(monthlyEquivalent(1, "annual")).toBeCloseTo(1 / 12, 10);
  });

  it("turns an annual salary into a twelfth", () => {
    expect(monthlyEquivalent(120_000_000, "annual")).toBe(10_000_000);
  });

  it("returns null for piece_rate rather than inventing a multiplier", () => {
    // A piece rate's monthly figure depends on OUTPUT, which is not in the compensation row. The
    // compensation page must EXCLUDE and COUNT these, never fold a guess into the headline.
    expect(monthlyEquivalent(50_000, "piece_rate")).toBeNull();
  });

  it("returns null for an unrecognised basis", () => {
    // Falling back to monthly would turn a typo, or a basis added on the backend and not here, into
    // a wrong payroll cost that looks computed.
    expect(monthlyEquivalent(1_000, "fortnightly")).toBeNull();
    expect(monthlyEquivalent(1_000, "")).toBeNull();
  });
});
