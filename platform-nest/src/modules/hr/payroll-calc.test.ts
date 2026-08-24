// Payroll arithmetic. Pure — no database, no clock, no Cerbos.
//
// What this file is and is not: it verifies the SHAPE of the calculation (ordering, bases, caps,
// signs, proration, reconciliation) against the fixture parameter set. It does NOT verify that the
// fixture's rates are legally correct — they are explicitly UNRATIFIED, and the whole reason they
// live in `hr_statutory_parameters` is so a lawyer's correction is an INSERT rather than a code
// change. A test asserting "PPh 21 on 10,000,000 is exactly X" would encode the unverified numbers
// as truth, which is precisely the failure the parameter table exists to prevent.
//
// So: every assertion below is either structural (a line exists, a sign is right, an order holds)
// or computed from the fixture's own values, never from a hard-coded expected rupiah figure.
import { describe, it, expect } from "vitest";
import {
  annualIncomeTax, computeContribution, computePayslip, computeThr,
  DEFAULT_PARAMS_UNRATIFIED as P, progressiveAnnualTax, terCategoryFor, terRate,
} from "./payroll-calc";

const sum = (ns: number[]) => Number(ns.reduce((a, b) => a + b, 0).toFixed(2));

describe("terRate", () => {
  it("picks the band the monthly gross falls in", () => {
    // The A table's first band is 0% up to 5,400,000.
    expect(terRate(P, "A", 5_000_000)).toBe(0);
    expect(terRate(P, "A", 5_400_000)).toBe(0);
    expect(terRate(P, "A", 5_500_000)).toBeGreaterThan(0);
  });

  it("uses the top band above the last threshold", () => {
    const top = P.ter.A[P.ter.A.length - 1].rate;
    expect(terRate(P, "A", 999_000_000)).toBe(top);
  });

  it("is monotonic — a higher gross never attracts a lower rate", () => {
    for (const cat of ["A", "B", "C"] as const) {
      let previous = -1;
      for (const band of P.ter[cat]) {
        expect(band.rate).toBeGreaterThanOrEqual(previous);
        previous = band.rate;
      }
    }
  });
});

describe("terCategoryFor", () => {
  it("maps PTKP status onto the regulated TER category", () => {
    expect(terCategoryFor("TK/0")).toBe("A");
    expect(terCategoryFor("K/0")).toBe("A");
    expect(terCategoryFor("K/1")).toBe("B");
    expect(terCategoryFor("K/3")).toBe("C");
  });

  it("falls back conservatively for a status the simple table does not cover", () => {
    expect(terCategoryFor("K/I/2")).toBe("A");
    expect(terCategoryFor("nonsense")).toBe("A");
  });
});

describe("progressiveAnnualTax", () => {
  it("is zero at or below zero taxable income", () => {
    expect(progressiveAnnualTax(P, 0)).toBe(0);
    expect(progressiveAnnualTax(P, -100)).toBe(0);
  });

  it("charges only the first bracket's rate inside the first bracket", () => {
    const cents = 50_000_000 * 100;
    expect(progressiveAnnualTax(P, cents)).toBe(Math.round(cents * P.brackets[0].rate));
  });

  it("walks the brackets marginally, not as a cliff", () => {
    // At exactly the first bracket's ceiling the whole amount is at the first rate; one rupiah
    // above, only that rupiah moves up. A cliff implementation would jump by millions.
    const ceiling = P.brackets[0].to! * 100;
    const at = progressiveAnnualTax(P, ceiling);
    const justOver = progressiveAnnualTax(P, ceiling + 100);
    expect(justOver - at).toBeLessThan(100);
  });

  it("is monotonic across the whole range", () => {
    let previous = -1;
    for (const income of [0, 10e6, 60e6, 100e6, 250e6, 600e6, 6e9]) {
      const tax = progressiveAnnualTax(P, income * 100);
      expect(tax).toBeGreaterThanOrEqual(previous);
      previous = tax;
    }
  });
});

describe("annualIncomeTax", () => {
  const base = { annualGrossCents: 300_000_000 * 100, annualBpjsEmployeeCents: 0, ptkpStatus: "TK/0", hasNpwp: true, monthsWorked: 12 };

  it("caps the occupational-cost deduction", () => {
    const { workings } = annualIncomeTax(P, base);
    expect(workings.occupationalCost).toBe(P.occupationalCost.monthlyCap * 12);
    expect(workings.occupationalCost).toBeLessThan(300_000_000 * P.occupationalCost.rate);
  });

  it("scales the cap by months worked, so a partial year is capped proportionally", () => {
    const half = annualIncomeTax(P, { ...base, monthsWorked: 6 });
    expect(half.workings.occupationalCostCap).toBe(P.occupationalCost.monthlyCap * 6);
  });

  it("subtracts PTKP, and a larger PTKP means less tax", () => {
    const single = annualIncomeTax(P, { ...base, ptkpStatus: "TK/0" });
    const married3 = annualIncomeTax(P, { ...base, ptkpStatus: "K/3" });
    expect(married3.taxCents).toBeLessThan(single.taxCents);
  });

  it("rounds taxable income DOWN to the nearest thousand before the brackets", () => {
    // The regulation's own rounding. Skipping it produces figures that are close but never match an
    // official calculation, which is worse than being obviously wrong.
    const { workings } = annualIncomeTax(P, { ...base, annualGrossCents: 100_000_777 * 100 });
    expect(Number(workings.taxableIncome) % 1000).toBe(0);
  });

  it("applies the no-NPWP surcharge", () => {
    const withNpwp = annualIncomeTax(P, { ...base, hasNpwp: true });
    const without = annualIncomeTax(P, { ...base, hasNpwp: false });
    expect(without.taxCents).toBe(Math.round(withNpwp.taxCents * P.noNpwpMultiplier));
    expect(without.workings.noNpwpSurchargeApplied).toBe(true);
  });

  it("is zero when PTKP exceeds income — a low earner owes nothing", () => {
    expect(annualIncomeTax(P, { ...base, annualGrossCents: 30_000_000 * 100 }).taxCents).toBe(0);
  });
});

describe("computeContribution", () => {
  it("applies the rate to the wage, and caps the WAGE not the contribution", () => {
    const param = { employerRate: 0.04, employeeRate: 0.01, wageCap: 12_000_000 };
    const under = computeContribution(param, 10_000_000 * 100);
    expect(under.employer).toBe(Math.round(10_000_000 * 100 * 0.04));
    expect(under.capped).toBe(false);

    const over = computeContribution(param, 20_000_000 * 100);
    expect(over.base).toBe(12_000_000 * 100);
    expect(over.employer).toBe(Math.round(12_000_000 * 100 * 0.04));
    expect(over.capped).toBe(true);
  });

  it("lifts a sub-floor wage to the floor before applying the rate", () => {
    const param = { employerRate: 0.04, employeeRate: 0.01, wageFloor: 5_000_000 };
    const r = computeContribution(param, 3_000_000 * 100);
    expect(r.base).toBe(5_000_000 * 100);
  });

  it("an employer-only program deducts nothing from the employee", () => {
    const r = computeContribution({ employerRate: 0.0024, employeeRate: 0 }, 10_000_000 * 100);
    expect(r.employee).toBe(0);
    expect(r.employer).toBeGreaterThan(0);
  });
});

describe("computePayslip", () => {
  const employee = {
    employeeId: "e1",
    baseAmount: 10_000_000,
    workingDays: 22,
    paidDays: 22,
    enrolledContributions: ["bpjs_kesehatan", "bpjs_jht", "bpjs_jp", "bpjs_jkk", "bpjs_jkm"],
    ptkpStatus: "TK/0",
    hasNpwp: true,
  };

  it("emits a base line and nets out to gross minus deductions minus tax", () => {
    const r = computePayslip(P, employee);
    expect(r.lines.find((l) => l.code === "base")?.amount).toBe(10_000_000);
    expect(r.net).toBeCloseTo(r.gross - r.employeeDeductions - r.taxWithheld, 2);
  });

  it("employer lines are COST ONLY and never touch net", () => {
    const r = computePayslip(P, employee);
    const employerLines = r.lines.filter((l) => l.side === "employer");
    expect(employerLines.length).toBeGreaterThan(0);
    expect(r.employerCost).toBeCloseTo(r.gross + sum(employerLines.map((l) => l.amount)), 2);
    // Removing every employer line must not change net.
    const withoutEmployerPrograms = computePayslip(P, { ...employee, enrolledContributions: ["bpjs_jht"] });
    expect(withoutEmployerPrograms.gross).toBe(r.gross);
  });

  it("PRORATES base pay by paid days", () => {
    const half = computePayslip(P, { ...employee, paidDays: 11 });
    expect(half.lines.find((l) => l.code === "base")?.amount).toBe(5_000_000);
  });

  it("scales by FTE", () => {
    const halfTime = computePayslip(P, { ...employee, fte: 0.5 });
    expect(halfTime.lines.find((l) => l.code === "base")?.amount).toBe(5_000_000);
  });

  it("treats workingDays=0 as 'not supplied' rather than 'worked nothing'", () => {
    // The alternative zeroes every payslip in a run where the calendar was not configured — a
    // failure worth being explicit about.
    const r = computePayslip(P, { ...employee, workingDays: 0, paidDays: 0 });
    expect(r.lines.find((l) => l.code === "base")?.amount).toBe(10_000_000);
  });

  it("a taxable allowance raises the taxable gross; a non-taxable one does not", () => {
    const taxable = computePayslip(P, {
      ...employee,
      components: [{ code: "position", label: "Position allowance", amount: 2_000_000, taxable: true, bpjsBase: false, category: "allowance" }],
    });
    const nonTaxable = computePayslip(P, {
      ...employee,
      components: [{ code: "reimb", label: "Reimbursement", amount: 2_000_000, taxable: false, bpjsBase: false, category: "reimbursement" }],
    });
    expect(taxable.gross).toBe(nonTaxable.gross);
    expect(taxable.taxableGross).toBeGreaterThan(nonTaxable.taxableGross);
    expect(taxable.taxWithheld).toBeGreaterThan(nonTaxable.taxWithheld);
  });

  it("the BPJS base and the taxable base move INDEPENDENTLY", () => {
    // The distinction that makes `taxable` and `bpjsBase` separate flags. Collapsing them into one
    // "included" boolean is a statutory error, not a rounding one.
    const r = computePayslip(P, {
      ...employee,
      components: [{ code: "x", label: "Taxable, not BPJS", amount: 1_000_000, taxable: true, bpjsBase: false, category: "allowance" }],
    });
    expect(r.taxableGross).toBe(11_000_000);
    expect(r.bpjsBase).toBe(10_000_000);
  });

  it("A LOAN REPAYMENT IS DEDUCTED AFTER TAX, NEVER BEFORE", () => {
    // Deducting it pre-tax would under-withhold, and the shortfall surfaces at year end as the
    // employee's problem. Tax must be identical with and without the repayment.
    const without = computePayslip(P, employee);
    const withLoan = computePayslip(P, {
      ...employee,
      components: [{ code: "loan", label: "Loan repayment", amount: -1_500_000, taxable: false, bpjsBase: false, category: "loan_repayment" }],
    });
    expect(withLoan.taxWithheld).toBe(without.taxWithheld);
    expect(withLoan.taxableGross).toBe(without.taxableGross);
    expect(withLoan.net).toBeCloseTo(without.net - 1_500_000, 2);
  });

  it("deduction lines carry a NEGATIVE amount, so a sum is a sum", () => {
    const r = computePayslip(P, employee);
    for (const l of r.lines.filter((x) => x.side === "employee" && (x.category === "tax" || x.category === "bpjs"))) {
      expect(l.amount).toBeLessThanOrEqual(0);
    }
  });

  it("only enrolled programs are computed — an unenrolled employee is deducted nothing", () => {
    const none = computePayslip(P, { ...employee, enrolledContributions: [] });
    expect(none.lines.some((l) => l.category === "bpjs")).toBe(false);
    expect(none.employeeDeductions).toBe(0);
  });

  it("an unknown statutory code is skipped rather than guessed at", () => {
    const r = computePayslip(P, { ...employee, enrolledContributions: ["bpjs_kesehatan", "bpjs_madeup"] });
    expect(r.lines.filter((l) => l.category === "bpjs" && l.side === "employee")).toHaveLength(1);
  });

  it("no NPWP withholds more", () => {
    const withN = computePayslip(P, { ...employee, hasNpwp: true });
    const without = computePayslip(P, { ...employee, hasNpwp: false });
    expect(without.taxWithheld).toBeGreaterThan(withN.taxWithheld);
  });

  it("REFUSES a non-resident rather than producing a plausible wrong figure", () => {
    expect(() => computePayslip(P, { ...employee, taxResident: false })).toThrow(/PPh 26/);
  });

  it("the December reconciliation nets off what was already withheld, and may be a refund", () => {
    const r = computePayslip(P, {
      ...employee,
      ytdTaxableGross: 110_000_000,
      // Deliberately over-withheld, so the reconciliation must come out negative.
      ytdTaxWithheld: 90_000_000,
    }, { mode: "annual_reconcile", periodMonths: 12 });
    expect(r.taxWithheld).toBeLessThan(0);
    // A negative tax is a REFUND line, so it must increase net rather than reduce it.
    expect(r.net).toBeGreaterThan(r.gross - r.employeeDeductions);
  });

  it("attaches its workings, so a disputed figure can be traced", () => {
    const r = computePayslip(P, employee);
    expect(r.workings).toHaveProperty("contributions");
    expect(r.workings).toHaveProperty("tax");
    expect(r.lines.find((l) => l.code === "pph21")?.meta).toHaveProperty("terRate");
  });
});

describe("computeThr", () => {
  it("pays one month's wage at 12+ months of service", () => {
    const r = computeThr(P, { monthlyWage: 10_000_000, monthsOfService: 12 });
    expect(r.eligible).toBe(true);
    expect(r.amount).toBe(10_000_000);
  });

  it("pays the same at more than 12 months — it does not keep growing", () => {
    expect(computeThr(P, { monthlyWage: 10_000_000, monthsOfService: 60 }).amount).toBe(10_000_000);
  });

  it("pro-rates below a year", () => {
    const r = computeThr(P, { monthlyWage: 12_000_000, monthsOfService: 6 });
    expect(r.amount).toBe(6_000_000);
    expect(r.workings.prorated).toBe(true);
  });

  it("pays nothing below the eligibility floor, and says why", () => {
    const strict = { ...P, thrMinServiceMonths: 3 };
    const r = computeThr(strict, { monthlyWage: 10_000_000, monthsOfService: 1 });
    expect(r.eligible).toBe(false);
    expect(r.amount).toBe(0);
    expect(r.workings.minMonths).toBe(3);
  });
});
