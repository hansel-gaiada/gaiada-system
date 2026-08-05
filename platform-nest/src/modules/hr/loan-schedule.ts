// Employee-loan arithmetic (wave E). PURE — no database, no clock, no config — so the money math is
// unit-testable and identical wherever it runs (controller, decision handler, a future payroll run).
//
// Two rules govern everything here:
//
// 1. ALL ARITHMETIC IS IN INTEGER MINOR UNITS (cents). `numeric(14,2)` columns come back from pg as
//    strings; doing `0.1 + 0.2` on them in float and rounding at the end is how a schedule ends up
//    owing one cent more than the principal. Converting to integers at the boundary and back once at
//    the end makes every intermediate exact.
//
// 2. THE SCHEDULE MUST SUM TO THE PRINCIPAL, EXACTLY. Per-installment rounding always leaves a
//    remainder; the LAST installment absorbs it. Without that, a 12-month schedule on an amount that
//    does not divide by 12 either under- or over-collects, and the employee is the one who notices.
//    `buildSchedule` guarantees `sum(principalDue) === principal` and it is asserted in the tests.

/**
 * The conventional first-installment anchor: the 1st of the month AFTER `fromIso`. A fixed,
 * predictable anchor keeps the preview shown to the decider and the schedule frozen at approval on
 * the same footing. Pure (takes the date) so it is shared by the controller and the decision handler
 * without either owning a clock.
 */
export function firstOfNextMonth(fromIso: string): string {
  const [y, m] = fromIso.split("-").map(Number);
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

export interface ScheduleInput {
  /** Loan principal, as the `numeric(14,2)` value (major units). Accepts pg's string form. */
  principal: string | number;
  /** Nominal ANNUAL rate as a percentage. 0 (the common staff-loan case) takes a separate branch. */
  annualRatePct: string | number;
  termMonths: number;
  /** ISO date (YYYY-MM-DD) of the first installment. */
  firstDueOn: string;
}

export interface Installment {
  seq: number;
  dueOn: string;
  principalDue: number;
  interestDue: number;
  totalDue: number;
}

const toCents = (v: string | number): number => Math.round(Number(v) * 100);
const toMajor = (cents: number): number => Math.round(cents) / 100;

/**
 * Add whole months to an ISO date, CLAMPING the day to the target month's length: 2026-01-31 + 1
 * month is 2026-02-28, not 2026-03-03. Plain `setMonth` overflows into the next month, which would
 * silently produce a schedule with two installments due in March and none in February.
 */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const targetMonthIndex = m - 1 + months;
  const year = y + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, daysInTarget);
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Materialize the amortization schedule. Interest-bearing loans use the standard annuity payment
 * (equal total per period, interest on the DECLINING balance); interest-free loans split the
 * principal evenly. Both end with the remainder absorbed by the final installment.
 */
export function buildSchedule(input: ScheduleInput): Installment[] {
  const principalCents = toCents(input.principal);
  const n = Math.trunc(input.termMonths);
  if (!(principalCents > 0)) throw new Error("principal must be > 0");
  if (!(n >= 1)) throw new Error("termMonths must be >= 1");

  const monthlyRate = Number(input.annualRatePct) / 100 / 12;
  const out: Installment[] = [];

  // Equal TOTAL payment per period, derived once. For the zero-rate branch the annuity formula
  // divides by zero, so the payment is simply the principal spread evenly.
  const paymentCents =
    monthlyRate > 0
      ? Math.round((principalCents * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -n)))
      : Math.round(principalCents / n);

  let balance = principalCents;
  for (let seq = 1; seq <= n; seq += 1) {
    // A degenerate loan can be fully scheduled BEFORE the term is up: 1.00 over 120 months is 100
    // cents spread over 120 installments, so the balance is gone after 100 of them. Emitting the
    // remaining 20 as zero-value rows would violate `CHECK (total_due > 0)` in 0081 and fail the
    // approval INSERT. A schedule that closes the loan early is the correct answer, so the result
    // may be SHORTER than termMonths — callers must read the returned length, not assume the term.
    if (balance <= 0) break;
    const interest = monthlyRate > 0 ? Math.round(balance * monthlyRate) : 0;
    // The final installment closes the loan: it takes whatever principal is left, so the schedule
    // sums to the principal exactly regardless of how the per-period rounding fell.
    const isLast = seq === n;
    const principalPart = isLast ? balance : Math.min(balance, paymentCents - interest);
    balance -= principalPart;
    out.push({
      seq,
      dueOn: addMonths(input.firstDueOn, seq - 1),
      principalDue: toMajor(principalPart),
      interestDue: toMajor(interest),
      totalDue: toMajor(principalPart + interest),
    });
  }
  return out;
}

export interface RepaymentRow {
  amount: string | number;
  paidOn: string;
}

export type InstallmentState = "paid" | "partial" | "unpaid";

export interface AllocatedInstallment extends Installment {
  paid: number;
  outstanding: number;
  state: InstallmentState;
  overdue: boolean;
}

export interface LoanSummary {
  totalPayable: number;
  totalPrincipal: number;
  totalInterest: number;
  totalPaid: number;
  /** Never negative: an overpayment shows as `credit`, not as a negative balance. */
  outstanding: number;
  credit: number;
  paidInstallments: number;
  installmentCount: number;
  overdueCount: number;
  overdueAmount: number;
  nextDue: AllocatedInstallment | null;
  settled: boolean;
  installments: AllocatedInstallment[];
}

/**
 * Allocate the repayment ledger across the schedule, oldest installment first (FIFO), and derive the
 * balance. Allocation is DERIVED here rather than stored per-installment so the policy can change
 * without a data migration (see 0081's header comment).
 *
 * `asOf` (ISO date) decides what counts as overdue; it is a parameter rather than `new Date()` so
 * this stays pure and the overdue tests are not time-bombs that start failing next month.
 */
export function summarizeLoan(
  installments: Installment[],
  repayments: RepaymentRow[],
  asOf: string,
): LoanSummary {
  const ordered = [...installments].sort((a, b) => a.seq - b.seq);
  let pool = repayments.reduce((sum, r) => sum + toCents(r.amount), 0);
  const totalPaidCents = pool;

  const allocated: AllocatedInstallment[] = ordered.map((inst) => {
    const dueCents = toCents(inst.totalDue);
    const applied = Math.min(pool, dueCents);
    pool -= applied;
    const outstandingCents = dueCents - applied;
    const state: InstallmentState = outstandingCents === 0 ? "paid" : applied > 0 ? "partial" : "unpaid";
    return {
      ...inst,
      paid: toMajor(applied),
      outstanding: toMajor(outstandingCents),
      state,
      // Only money still owed can be overdue — a fully paid installment whose date has passed is
      // settled, not late.
      overdue: outstandingCents > 0 && inst.dueOn < asOf,
    };
  });

  const sumCents = (pick: (i: Installment) => number) =>
    ordered.reduce((s, i) => s + toCents(pick(i)), 0);
  const payableCents = sumCents((i) => i.totalDue);
  const outstandingCents = Math.max(0, payableCents - totalPaidCents);
  const overdue = allocated.filter((i) => i.overdue);

  return {
    totalPayable: toMajor(payableCents),
    totalPrincipal: toMajor(sumCents((i) => i.principalDue)),
    totalInterest: toMajor(sumCents((i) => i.interestDue)),
    totalPaid: toMajor(totalPaidCents),
    outstanding: toMajor(outstandingCents),
    // Whatever the ledger holds beyond the whole schedule. Surfaced explicitly so an overpayment is
    // visible instead of hiding inside a negative balance.
    credit: toMajor(pool),
    paidInstallments: allocated.filter((i) => i.state === "paid").length,
    installmentCount: allocated.length,
    overdueCount: overdue.length,
    overdueAmount: toMajor(overdue.reduce((s, i) => s + toCents(i.outstanding), 0)),
    nextDue: allocated.find((i) => i.state !== "paid") ?? null,
    settled: allocated.length > 0 && outstandingCents === 0,
    installments: allocated,
  };
}
