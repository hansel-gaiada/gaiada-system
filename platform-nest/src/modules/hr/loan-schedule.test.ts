// Employee-loan arithmetic (wave E). Pure unit tests — no Postgres, no Cerbos, no clock — so these
// run everywhere and pin the two invariants that actually cost money if they break: the schedule
// sums to the principal EXACTLY, and the ledger never over- or under-allocates.
import { describe, it, expect } from "vitest";
import { addMonths, buildSchedule, summarizeLoan } from "./loan-schedule";

const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;

describe("addMonths", () => {
  it("advances whole months", () => {
    expect(addMonths("2026-01-15", 1)).toBe("2026-02-15");
    expect(addMonths("2026-01-15", 0)).toBe("2026-01-15");
  });

  it("CLAMPS to the target month's length instead of overflowing", () => {
    // `setMonth`-style arithmetic gives 2026-03-03 here, which would put two installments in March
    // and none in February.
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29"); // leap year
    expect(addMonths("2026-05-31", 1)).toBe("2026-06-30");
  });

  it("rolls across year boundaries", () => {
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("2026-12-01", 12)).toBe("2027-12-01");
  });
});

describe("buildSchedule — interest-free (the common staff loan)", () => {
  it("splits evenly and charges no interest", () => {
    const s = buildSchedule({ principal: 12_000_000, annualRatePct: 0, termMonths: 12, firstDueOn: "2026-09-01" });
    expect(s).toHaveLength(12);
    expect(s[0]).toMatchObject({ seq: 1, dueOn: "2026-09-01", principalDue: 1_000_000, interestDue: 0, totalDue: 1_000_000 });
    expect(s[11].dueOn).toBe("2027-08-01");
    expect(sum(s.map((i) => i.interestDue))).toBe(0);
    expect(sum(s.map((i) => i.principalDue))).toBe(12_000_000);
  });

  it("absorbs an indivisible remainder in the LAST installment", () => {
    // 10,000 / 3 = 3333.33…; three equal installments would collect 9,999.99.
    const s = buildSchedule({ principal: 10_000, annualRatePct: 0, termMonths: 3, firstDueOn: "2026-01-01" });
    expect(s.map((i) => i.principalDue)).toEqual([3333.33, 3333.33, 3333.34]);
    expect(sum(s.map((i) => i.principalDue))).toBe(10_000);
  });

  it("handles a single-installment loan", () => {
    const s = buildSchedule({ principal: 500, annualRatePct: 0, termMonths: 1, firstDueOn: "2026-03-10" });
    expect(s).toEqual([{ seq: 1, dueOn: "2026-03-10", principalDue: 500, interestDue: 0, totalDue: 500 }]);
  });
});

describe("buildSchedule — interest-bearing", () => {
  it("charges interest on the DECLINING balance and still sums to the principal", () => {
    const s = buildSchedule({ principal: 12_000_000, annualRatePct: 12, termMonths: 12, firstDueOn: "2026-09-01" });
    // 1%/month on the opening balance.
    expect(s[0].interestDue).toBe(120_000);
    // Interest falls every period as principal is repaid; principal repaid rises.
    expect(s[1].interestDue).toBeLessThan(s[0].interestDue);
    expect(s[1].principalDue).toBeGreaterThan(s[0].principalDue);
    expect(s[11].interestDue).toBeLessThan(s[0].interestDue);
    // THE invariant: rounding 12 times must not change what is owed in principal.
    expect(sum(s.map((i) => i.principalDue))).toBe(12_000_000);
    expect(sum(s.map((i) => i.totalDue))).toBeGreaterThan(12_000_000); // interest was actually charged
  });

  it("keeps the schedule exact across many awkward parameter combinations", () => {
    for (const principal of [1, 999.99, 7_777_777.77, 250_000]) {
      for (const rate of [0, 3.5, 12, 18.75]) {
        for (const term of [1, 2, 7, 12, 36, 120]) {
          const s = buildSchedule({ principal, annualRatePct: rate, termMonths: term, firstDueOn: "2026-01-31" });
          // Normally exactly `term` installments, but a tiny principal over a long term closes early
          // rather than emitting zero-value rows (see the degenerate-loan test below).
          expect(s.length, `P=${principal} r=${rate} n=${term}`).toBeLessThanOrEqual(term);
          expect(s.length).toBeGreaterThan(0);
          expect(sum(s.map((i) => i.principalDue)), `P=${principal} r=${rate} n=${term}`).toBe(principal);
          // No installment may be negative or free.
          for (const inst of s) {
            expect(inst.principalDue).toBeGreaterThanOrEqual(0);
            expect(inst.interestDue).toBeGreaterThanOrEqual(0);
            expect(inst.totalDue).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("accepts pg's string form for numeric columns", () => {
    const s = buildSchedule({ principal: "3000.00", annualRatePct: "6.000", termMonths: 3, firstDueOn: "2026-01-01" });
    expect(sum(s.map((i) => i.principalDue))).toBe(3000);
  });

  it("closes a degenerate loan EARLY instead of emitting zero-value installments", () => {
    // 1.00 over 120 months is 100 cents to spread across 120 installments. The balance is gone
    // after 100 of them, and rows 101-120 would be `total_due = 0` — which 0081's
    // `CHECK (total_due > 0)` rejects, failing the whole approval INSERT.
    const s = buildSchedule({ principal: 1, annualRatePct: 0, termMonths: 120, firstDueOn: "2026-01-01" });
    expect(s).toHaveLength(100);
    expect(s.every((i) => i.totalDue > 0)).toBe(true);
    expect(sum(s.map((i) => i.principalDue))).toBe(1);
    // Still a coherent schedule: consecutive months from the first due date.
    expect(s[0].dueOn).toBe("2026-01-01");
    expect(s[99].dueOn).toBe("2034-04-01");
  });

  it("rejects nonsense input rather than emitting a broken schedule", () => {
    expect(() => buildSchedule({ principal: 0, annualRatePct: 0, termMonths: 6, firstDueOn: "2026-01-01" })).toThrow();
    expect(() => buildSchedule({ principal: 100, annualRatePct: 0, termMonths: 0, firstDueOn: "2026-01-01" })).toThrow();
  });
});

describe("summarizeLoan", () => {
  const schedule = buildSchedule({
    principal: 12_000_000, annualRatePct: 0, termMonths: 12, firstDueOn: "2026-01-01",
  });

  it("reports a fresh loan as entirely unpaid", () => {
    const s = summarizeLoan(schedule, [], "2025-12-01");
    expect(s.totalPayable).toBe(12_000_000);
    expect(s.totalPaid).toBe(0);
    expect(s.outstanding).toBe(12_000_000);
    expect(s.paidInstallments).toBe(0);
    expect(s.overdueCount).toBe(0);
    expect(s.settled).toBe(false);
    expect(s.nextDue?.seq).toBe(1);
  });

  it("allocates FIFO, marking whole installments paid and the boundary one partial", () => {
    // 2.5 installments' worth.
    const s = summarizeLoan(schedule, [{ amount: 2_500_000, paidOn: "2026-01-05" }], "2026-01-06");
    expect(s.totalPaid).toBe(2_500_000);
    expect(s.outstanding).toBe(9_500_000);
    expect(s.installments[0].state).toBe("paid");
    expect(s.installments[1].state).toBe("paid");
    expect(s.installments[2].state).toBe("partial");
    expect(s.installments[2].paid).toBe(500_000);
    expect(s.installments[2].outstanding).toBe(500_000);
    expect(s.installments[3].state).toBe("unpaid");
    expect(s.paidInstallments).toBe(2);
    expect(s.nextDue?.seq).toBe(3); // the partial one is what is next owed, not the next untouched one
  });

  it("sums many small repayments without float drift", () => {
    const many = Array.from({ length: 100 }, () => ({ amount: "0.01", paidOn: "2026-01-05" }));
    const s = summarizeLoan(schedule, many, "2026-01-06");
    expect(s.totalPaid).toBe(1); // 100 x 0.01, exactly
    expect(s.outstanding).toBe(11_999_999);
  });

  it("counts only UNPAID past-due installments as overdue", () => {
    // Three installments due by March; one installment paid.
    const s = summarizeLoan(schedule, [{ amount: 1_000_000, paidOn: "2026-01-02" }], "2026-03-15");
    expect(s.installments[0].overdue).toBe(false); // past due but settled
    expect(s.overdueCount).toBe(2); // Feb + Mar
    expect(s.overdueAmount).toBe(2_000_000);
  });

  it("settles when the ledger covers the schedule", () => {
    const s = summarizeLoan(schedule, [{ amount: 12_000_000, paidOn: "2026-01-05" }], "2027-01-01");
    expect(s.settled).toBe(true);
    expect(s.outstanding).toBe(0);
    expect(s.credit).toBe(0);
    expect(s.paidInstallments).toBe(12);
    expect(s.nextDue).toBeNull();
    expect(s.overdueCount).toBe(0);
  });

  it("shows an overpayment as CREDIT, never as a negative balance", () => {
    const s = summarizeLoan(schedule, [{ amount: 12_500_000, paidOn: "2026-01-05" }], "2027-01-01");
    expect(s.outstanding).toBe(0);
    expect(s.credit).toBe(500_000);
    expect(s.settled).toBe(true);
  });

  it("splits principal and interest on an interest-bearing loan", () => {
    const bearing = buildSchedule({ principal: 12_000_000, annualRatePct: 12, termMonths: 12, firstDueOn: "2026-01-01" });
    const s = summarizeLoan(bearing, [], "2026-01-01");
    expect(s.totalPrincipal).toBe(12_000_000);
    expect(s.totalInterest).toBeGreaterThan(0);
    expect(s.totalPayable).toBe(Math.round((s.totalPrincipal + s.totalInterest) * 100) / 100);
  });

  it("is not settled when there is no schedule at all", () => {
    // A pending (not yet approved) loan has no installments; that must not read as 'settled'.
    expect(summarizeLoan([], [], "2026-01-01").settled).toBe(false);
  });
});
