// Employee loans — read side (employee-portal wave E).
//
// BFF CONTRACT (built in platform-nest LoansController, mounted under the hr module prefix):
//   GET  /api/:t/modules/hr/loans[?subjectUserId&status]  -> { loans: Loan[], scope: "self"|"tenant" }
//   GET  /api/:t/modules/hr/loans/:id                     -> Loan & { repayments: Repayment[] }
//   POST /api/:t/modules/hr/loans                         -> { id, approvalId, status: "pending" }
//   POST /api/:t/modules/hr/loans/:id/cancel              -> { id, status: "cancelled" }
//   POST /api/:t/modules/hr/loans/:id/repayments          -> { id, loanId, status, summary }
//
// TWO THINGS THE UI MUST RESPECT, both enforced server-side:
//   1. `scope` tells you which Cerbos path won. "self" means the caller is a plain member and the
//      list is already narrowed to their own rows — do NOT render a subject filter in that case.
//   2. Recording a repayment is authorized as hr_case:update, which `member` does not hold. An
//      employee never sees the repayment form; showing it would produce a button that 403s.
//
// MODULE TRIO (platform-ui/CLAUDE.md): this file is the CLIENT-SAFE half — types + pure, zero-I/O
// helpers only, NO `import "server-only"` and no platformFetch. It must stay that way: the
// `"use client"` loan forms import `money`/`METHOD_LABEL` from here, and a server-only import
// reaching a client component breaks `next build` while tsc and vitest both stay green (the exact
// trap CLAUDE.md calls out). The readers live in `loans-data.ts`.

export type LoanStatus = "pending" | "approved" | "denied" | "cancelled" | "settled";
export const LOAN_STATUSES: LoanStatus[] = ["pending", "approved", "denied", "cancelled", "settled"];

export type RepaymentMethod = "payroll_deduction" | "transfer" | "cash" | "other";
export const REPAYMENT_METHODS: RepaymentMethod[] = ["payroll_deduction", "transfer", "cash", "other"];

export const METHOD_LABEL: Record<RepaymentMethod, string> = {
  payroll_deduction: "Payroll deduction",
  transfer: "Bank transfer",
  cash: "Cash",
  other: "Other",
};

export type InstallmentState = "paid" | "partial" | "unpaid";

export interface LoanInstallment {
  seq: number;
  dueOn: string;
  principalDue: number;
  interestDue: number;
  totalDue: number;
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
  outstanding: number;
  credit: number;
  paidInstallments: number;
  installmentCount: number;
  overdueCount: number;
  overdueAmount: number;
  nextDue: LoanInstallment | null;
  settled: boolean;
}

export interface LoanRepayment {
  id: string;
  amount: number;
  paidOn: string;
  method: RepaymentMethod;
  note: string | null;
  recordedBy: string;
  recordedByName: string | null;
  createdAt: string;
}

export interface Loan {
  id: string;
  subjectUserId: string;
  subjectName: string | null;
  principalAmount: number;
  currency: string;
  termMonths: number;
  annualInterestRate: number;
  purpose: string | null;
  status: LoanStatus;
  approvalId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  firstDueOn: string | null;
  /** null until approval freezes the schedule — NOT 0, which would read as an interest-free total. */
  totalPayable: number | null;
  createdAt: string;
  schedule: LoanInstallment[];
  summary: LoanSummary;
}

export interface LoanDetail extends Loan {
  repayments: LoanRepayment[];
}

export interface LoanList {
  loans: Loan[];
  scope: "self" | "tenant";
  /** True when the hr module is dark for this company (or the caller holds no HR grant at all). */
  unavailable: boolean;
}

/** Money, in the loan's own currency. IDR is conventionally shown without decimals. */
export function money(amount: number, currency = "IDR"): string {
  const fractionDigits = currency === "IDR" || currency === "JPY" || currency === "VND" ? 0 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency, minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits,
    }).format(amount);
  } catch {
    // An unknown 3-letter code must not blow up a page.
    return `${currency} ${amount.toLocaleString("en-US")}`;
  }
}

export function loanDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/** Progress toward settlement, 0-100. Used for the schedule bar; guards a zero payable. */
export function repaidPercent(summary: LoanSummary): number {
  if (!summary.totalPayable) return 0;
  return Math.min(100, Math.round((summary.totalPaid / summary.totalPayable) * 100));
}
