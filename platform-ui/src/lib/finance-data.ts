import "server-only";
// DW-7e-2: Finance's honest readers, for the Overview's Pulse and the Receivables payment queue. The readers in
// `lib/finance.ts` degrade on purpose for their pages (`financeData` turns a 403 and a 404 into a fallback, `financeVerdict`
// into `null`), and the pages rely on that, so none can feed a count: a refused AR aging would be "0 overdue" and an unread
// ledger check would be a pass. These return a `ReadResult` (403 `forbidden`, 404 and 5xx `unavailable`), so only a real
// 200 can become a number or a verdict. They sit BESIDE `finance.ts` and leave it alone.
//
// `asOf` is never sent: every one of these routes defaults it to today, which is what a "now" tile means (the Finance
// Overview reports as at the current period's END, a date that can lie ahead of today).
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type {
  ArAgingRow, CloseReadiness, FiscalPeriod, LedgerVerdict, Problem, ReconcileVerdict, ArPosition, ApPosition, StatementRow, TrialBalance, Account,
} from "./finance";
import type { InvoicePayment } from "./contracts";
import type { TaxReturn, TaxReturnDrift } from "./taxReturns";

type Verdict = { problems: Problem[]; clean: boolean };

/** The company-wide queue of client payments still waiting for Finance: `GET invoice-payments?status=pending` with NO
 *  `clientId`. Authorized as `invoice` read. The server lists at most 300 rows, pending first (`PENDING_PAYMENTS_LIMIT`, lib/overviewPulse.ts). */
export function listPendingPaymentsResult(u: string, t: string): Promise<ReadResult<InvoicePayment[]>> {
  return readResult(platformFetch<InvoicePayment[]>(`/api/${t}/invoice-payments?status=pending`, u));
}

export function getArAgingResult(u: string, t: string): Promise<ReadResult<ArAgingRow[]>> {
  return readResult(platformFetch<ArAgingRow[]>(`/api/${t}/finance/ar/aging`, u));
}

/** No `absentAsEmpty`: a 404 is a module or route that is not served, and "no periods" would read as "no current period". */
export function listPeriodsResult(u: string, t: string): Promise<ReadResult<FiscalPeriod[]>> {
  return readResult(platformFetch<FiscalPeriod[]>(`/api/${t}/finance/periods`, u));
}

export function getCloseReadinessResult(u: string, t: string, periodId: string): Promise<ReadResult<CloseReadiness>> {
  return readResult(platformFetch<CloseReadiness>(`/api/${t}/finance/periods/${encodeURIComponent(periodId)}/close-readiness`, u));
}

// The verdicts the Finance Overview's Integrity card shows, plus the two tie-outs that only the assets and treasury
// pages show. Each is "problems found; clean means none".
export const verifyLedgerResult = (u: string, t: string): Promise<ReadResult<LedgerVerdict>> =>
  readResult(platformFetch<LedgerVerdict>(`/api/${t}/finance/ledger/verify`, u));
export const reconcileArResult = (u: string, t: string): Promise<ReadResult<ReconcileVerdict<ArPosition>>> =>
  readResult(platformFetch<ReconcileVerdict<ArPosition>>(`/api/${t}/finance/ar/reconcile`, u));
export const reconcileApResult = (u: string, t: string): Promise<ReadResult<ReconcileVerdict<ApPosition>>> =>
  readResult(platformFetch<ReconcileVerdict<ApPosition>>(`/api/${t}/finance/ap/reconcile`, u));
export const reconcileAssetsResult = (u: string, t: string): Promise<ReadResult<Verdict>> =>
  readResult(platformFetch<Verdict>(`/api/${t}/finance/assets/reconcile`, u));
export const reconcileTreasuryResult = (u: string, t: string): Promise<ReadResult<Verdict>> =>
  readResult(platformFetch<Verdict>(`/api/${t}/finance/treasury/reconcile`, u));
export const getTrialBalanceResult = (u: string, t: string): Promise<ReadResult<TrialBalance>> =>
  readResult(platformFetch<TrialBalance>(`/api/${t}/finance/trial-balance`, u));

/** DW-7b-2 (analytics) and DW-7j-5 (revenue plan): the P&L over `[from, to]` (both inclusive ISO dates), as rows. `finance_statement` read. The totals come back as `section: "total"` rows
 *  (`gmMoney.summarizePnl`). A 200 that is not a list is a broken read, never "no rows". */
export const getProfitAndLossResult = (u: string, t: string, from: string, to: string): Promise<ReadResult<StatementRow[]>> =>
  readResult(
    platformFetch<StatementRow[]>(`/api/${t}/finance/profit-and-loss?${new URLSearchParams({ from, to }).toString()}`, u).then((rows) => {
      if (!Array.isArray(rows)) throw new Error("The finance read returned an unexpected answer.");
      return rows;
    }),
  );

// DW-7g-1: Finance > Tax > Returns. Both are `finance_tax` `read`. A refused or failed read is never a list: "no returns
// have been prepared" and "no filed return has drifted" are claims about tax, and only a real 200 may make them.
// `year` and `kind` are left off, so the list is every return the company has (newest period first, as the server orders it).
// A 200 in the wrong shape is a broken read, never "none" and never a crash: the demo layer answers `[]` to any GET it has no
// fixture for, and a drifted backend could do the same. Thrown inside `readResult`, it renders as unavailable.
export const listTaxReturnsResult = (u: string, t: string): Promise<ReadResult<TaxReturn[]>> =>
  readResult(platformFetch<TaxReturn[]>(`/api/${t}/finance/tax/returns`, u).then((rows) => {
    if (!Array.isArray(rows)) throw new Error("The finance read returned an unexpected answer.");
    return rows;
  }));
export const getTaxReturnDriftResult = (u: string, t: string): Promise<ReadResult<TaxReturnDrift>> =>
  readResult(platformFetch<TaxReturnDrift>(`/api/${t}/finance/tax/returns/drift`, u).then((d) => {
    if (!d || typeof d.clean !== "boolean" || !Array.isArray(d.problems)) throw new Error("The finance read returned an unexpected answer.");
    return d;
  }));

// DW-7g-2: the chart of accounts, read honestly. `listAccounts` in `finance.ts` folds a refusal and a failure into `[]` (its
// other callers are pickers that rely on it), which on the chart page would read as "this company has no chart, run the
// seed". This is `finance_config` `read`, and only a real 200 may say a chart is empty. `q` filters on code and name.
export const listAccountsResult = (u: string, t: string, q?: string): Promise<ReadResult<Account[]>> =>
  readResult(platformFetch<Account[]>(`/api/${t}/finance/accounts${q ? `?q=${encodeURIComponent(q)}` : ""}`, u).then((rows) => {
    if (!Array.isArray(rows)) throw new Error("The finance read returned an unexpected answer.");
    return rows;
  }));
