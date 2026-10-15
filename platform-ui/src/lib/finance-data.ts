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
  ArAgingRow, CloseReadiness, FiscalPeriod, LedgerVerdict, Problem, ReconcileVerdict, ArPosition, ApPosition, TrialBalance,
} from "./finance";
import type { InvoicePayment } from "./contracts";

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
