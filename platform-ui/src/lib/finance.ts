import "server-only";
// Finance & Accounting data layer.
//
// Backs the /finance surface against the BFF built in platform-nest
// `src/modules/finance/finance.controller.ts`. Design:
// docs/blueprints/finance-accounting-foundation.md.
//
// ── THE RULE THAT SHAPES THIS WHOLE FILE: AN EMPTY LIST IS A CLAIM ──────────────────────────────
// The estate's usual pattern is `skipUnavailable(promise, [])` — degrade a 403/404 to an empty list
// so a page ships ahead of its backend. **That pattern is WRONG for half of these readers, and
// applying it uniformly here would make the UI lie about money.**
//
// Two categories, and the difference is not cosmetic:
//
//   DATA readers (chart of accounts, aging, journals) may degrade to []. "No invoices are overdue"
//   and "we could not load the aging" look the same on screen, which is bad, but the empty state
//   says "nothing here" and a reader can tell.
//
//   VERDICT readers (ledger verify, AR/AP reconcile, close readiness, statement balance) MUST NOT.
//   Every one of them returns "problems found, empty means PASS". Degrading a failed fetch to `[]`
//   renders **"clean"** — an active, confident, false assurance that the books tie and the period
//   can close. That is worse than an error, because nobody investigates a green tick.
//
// So verdict readers return `null` on unavailability and the page renders "could not check", never
// "clean". `financeVerdict()` exists to make that the easy path and the uniform one.
import { platformFetch, PlatformError } from "./platform";

// ── Types ───────────────────────────────────────────────────────────────────────────────────────
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type NormalBalance = "debit" | "credit";
export type PeriodState = "OPEN" | "SOFT_LOCK" | "HARD_LOCK";

export interface Account {
  code: string;
  name: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  isPostable: boolean;
  isControl: boolean;
  controlSubledger: string | null;
  allowManualPosting: boolean;
  status: "active" | "archived";
  /** Once true, code/type/normal-balance are frozen in the database. The UI must not offer to edit
   *  them — a disabled field with a reason beats a form that submits and fails. */
  hasPostings: boolean;
}

export interface FiscalPeriod {
  id: string;
  periodNo: number;
  name: string;
  startDate: string;
  endDate: string;
  state: PeriodState;
  signedOff: boolean;
  fiscalYear: string;
}

export interface TrialBalanceRow {
  code: string; name: string; accountType: AccountType;
  debit: string; credit: string; balance: string;
}
export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  /** The defining property. If false, that is a FINDING — never render it as a rounding note. */
  balanced: boolean;
}

export interface StatementRow { section: string; code: string; name: string; amount: string }
export interface BalanceSheet {
  rows: StatementRow[];
  assets: number; liabilities: number; equity: number;
  /** A = L + E. False is a finding. */
  balanced: boolean;
}

export interface JournalSummary {
  id: string; ledgerSequence: string; entryDate: string; kind: string;
  description: string; currency: string; totalDebit: string; sourceEventId: string;
  status: "posted" | "reversed" | "reversal";
}
export interface JournalLine {
  lineNo: number; accountCode: string; accountName: string;
  side: NormalBalance; amount: string; memo: string | null;
}
export interface JournalDetail extends JournalSummary {
  totalCredit: string; reversalOfId: string | null; reversalReason: string | null;
  entryHash: string; lines: JournalLine[];
}

export interface AgingRow {
  current: string; d1To30: string; d31To60: string; d61To90: string; d90Plus: string;
  totalOutstanding: string;
}
export interface ArAgingRow extends AgingRow { customerCode: string; customerName: string }
export interface ApAgingRow extends AgingRow { vendorCode: string; vendorName: string }

export interface Problem { problem: string; detail: string }
export interface LedgerVerdict { problems: Array<Problem & { ledgerSequence: string; entryId: string }>; clean: boolean }
export interface ReconcileVerdict<P> { position: P; problems: Problem[]; clean: boolean }
export interface ArPosition { openInvoices: string; paymentsOnAccount: string; netReceivable: string }
export interface ApPosition { openBills: string; paymentsOnAccount: string; netPayable: string }
export interface CloseReadiness { blockers: Array<{ blocker: string; detail: string }>; ready: boolean }

export interface PpnSummary {
  outputVat: string; inputVatCreditable: string;
  /** Input VAT the company cannot reclaim for want of a vendor e-Faktur. A real cost, and the UI
   *  must show it as one rather than hiding it inside a net figure. */
  inputVatUncreditable: string;
  netPayable: string;
}
export interface EfakturException {
  kind: "AR_MISSING_EFAKTUR" | "AP_INPUT_VAT_LOST";
  documentNo: string; counterparty: string; docDate: string; taxAmount: string; detail: string;
}

// ── The two degradation strategies ──────────────────────────────────────────────────────────────

/** DATA readers: a 403/404 (module off, or backend older than the endpoint) becomes the fallback. */
async function financeData<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

/**
 * VERDICT readers: unavailability becomes `null`, NEVER a passing verdict.
 *
 * Do not "simplify" this into financeData(p, { clean: true }) or financeData(p, { problems: [] }).
 * Both render a green tick for a check that never ran, on the one surface in this estate where a
 * false assurance has money and an audit behind it.
 */
async function financeVerdict<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

const qs = (o: Record<string, string | undefined>) => {
  const s = new URLSearchParams(
    Object.entries(o).filter(([, v]) => v != null && v !== "") as [string, string][],
  ).toString();
  return s ? `?${s}` : "";
};

// ── Chart of accounts and calendar ──────────────────────────────────────────────────────────────
export const listAccounts = (u: string, t: string, q?: string) =>
  financeData(platformFetch<Account[]>(`/api/${t}/finance/accounts${qs({ q })}`, u), [] as Account[]);

/**
 * The page's GATE read, and the one reader that must distinguish 403 from 404.
 *
 * `financeData` folds both into the fallback, which is fine for a table but wrong here: the page
 * keys its empty state off this call, and "you have no finance access" and "this company has no
 * fiscal calendar" need completely different sentences. Collapsing them told a member with no
 * access to go and run a seed script.
 *
 *   null → forbidden (403). The caller lacks finance access.
 *   []   → reachable, but no calendar has been cut (or the endpoint predates this build).
 */
export async function listPeriods(u: string, t: string): Promise<FiscalPeriod[] | null> {
  try {
    return await platformFetch<FiscalPeriod[]>(`/api/${t}/finance/periods`, u);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return null;
    if (e instanceof PlatformError && e.status === 404) return [];
    throw e;
  }
}

// ── Statements ──────────────────────────────────────────────────────────────────────────────────
// The trial balance carries a VERDICT (`balanced`), so it degrades to null rather than to an empty
// balanced-looking shell.
export const getTrialBalance = (u: string, t: string, asOf?: string) =>
  financeVerdict(platformFetch<TrialBalance>(`/api/${t}/finance/trial-balance${qs({ asOf })}`, u));

export const getProfitAndLoss = (u: string, t: string, from: string, to: string) =>
  financeData(
    platformFetch<StatementRow[]>(`/api/${t}/finance/profit-and-loss${qs({ from, to })}`, u),
    [] as StatementRow[],
  );

export const getBalanceSheet = (u: string, t: string, asOf: string, fyStart: string) =>
  financeVerdict(
    platformFetch<BalanceSheet>(`/api/${t}/finance/balance-sheet${qs({ asOf, fyStart })}`, u),
  );

export const getGeneralLedger = (u: string, t: string, code: string, from?: string, to?: string) =>
  financeData(
    platformFetch<Array<{
      ledgerSequence: string; entryDate: string; description: string; memo: string | null;
      side: NormalBalance; amount: string; runningBalance: string; entryKind: string;
    }>>(`/api/${t}/finance/general-ledger/${encodeURIComponent(code)}${qs({ from, to })}`, u),
    [],
  );

// ── The ledger ──────────────────────────────────────────────────────────────────────────────────
export const listJournals = (u: string, t: string, limit = 50) =>
  financeData(
    platformFetch<JournalSummary[]>(`/api/${t}/finance/journals${qs({ limit: String(limit) })}`, u),
    [] as JournalSummary[],
  );

export const getJournal = (u: string, t: string, entryId: string) =>
  financeData(platformFetch<JournalDetail | null>(`/api/${t}/finance/journals/${entryId}`, u), null);

export const verifyLedger = (u: string, t: string) =>
  financeVerdict(platformFetch<LedgerVerdict>(`/api/${t}/finance/ledger/verify`, u));

// ── Subledgers ──────────────────────────────────────────────────────────────────────────────────
export const getArAging = (u: string, t: string, asOf?: string) =>
  financeData(platformFetch<ArAgingRow[]>(`/api/${t}/finance/ar/aging${qs({ asOf })}`, u), [] as ArAgingRow[]);

export const getApAging = (u: string, t: string, asOf?: string) =>
  financeData(platformFetch<ApAgingRow[]>(`/api/${t}/finance/ap/aging${qs({ asOf })}`, u), [] as ApAgingRow[]);

export const reconcileAr = (u: string, t: string, asOf?: string) =>
  financeVerdict(
    platformFetch<ReconcileVerdict<ArPosition>>(`/api/${t}/finance/ar/reconcile${qs({ asOf })}`, u),
  );

export const reconcileAp = (u: string, t: string, asOf?: string) =>
  financeVerdict(
    platformFetch<ReconcileVerdict<ApPosition>>(`/api/${t}/finance/ap/reconcile${qs({ asOf })}`, u),
  );

// ── Tax ─────────────────────────────────────────────────────────────────────────────────────────
export const getPpnSummary = (u: string, t: string, from: string, to: string) =>
  financeData(platformFetch<PpnSummary | null>(`/api/${t}/finance/tax/ppn${qs({ from, to })}`, u), null);

export const getEfakturExceptions = (u: string, t: string, from: string, to: string) =>
  financeData(
    platformFetch<EfakturException[]>(`/api/${t}/finance/tax/efaktur-exceptions${qs({ from, to })}`, u),
    [] as EfakturException[],
  );

// ── The close ───────────────────────────────────────────────────────────────────────────────────
export const getCloseReadiness = (u: string, t: string, periodId: string) =>
  financeVerdict(
    platformFetch<CloseReadiness>(`/api/${t}/finance/periods/${periodId}/close-readiness`, u),
  );

// ── Presentation helpers ────────────────────────────────────────────────────────────────────────

/**
 * Money, in the ledger's own currency, with NO decimals for IDR.
 *
 * `minor_unit` is a real column on finance_currencies and IDR is 0 — rendering "Rp 10.000.000,0000"
 * is how a finance surface immediately looks untrustworthy to an accountant. Amounts arrive as
 * STRINGS from pg numeric and are formatted, never parsed into arithmetic here: the moment this
 * file does maths on money it is competing with the database that guards it.
 */
export function money(amount: string | number, currency = "IDR"): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  const decimals = currency === "IDR" || currency === "JPY" ? 0 : 2;
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(n);
}

/** Fiscal-period state, in words a person uses rather than the enum. */
export const PERIOD_STATE_LABEL: Record<PeriodState, string> = {
  OPEN: "open",
  SOFT_LOCK: "closing",
  HARD_LOCK: "closed",
};

/** Turns a machine blocker code into a sentence. Unknown codes fall through to the code itself
 *  rather than to a friendly-but-wrong default — a blocker nobody has labelled must still be
 *  legible, and inventing text for it would hide what the backend actually said. */
export const BLOCKER_LABEL: Record<string, string> = {
  NO_ACCOUNTANT_SIGNOFF: "No accountant sign-off",
  LEDGER_INTEGRITY: "Ledger integrity",
  STATEMENTS: "Statements do not balance",
  AR_RECONCILIATION: "Receivables do not tie to the ledger",
  AP_RECONCILIATION: "Payables do not tie to the ledger",
  BANK_STATEMENT_MISSING: "Bank statement not imported",
  BANK_UNEXPLAINED_DIFFERENCE: "Unexplained bank difference",
};

/** The current fiscal year's start, for the balance sheet's required `fyStart`. Derived from the
 *  period list rather than assumed to be 1 January — `fiscal_year_start_month` exists precisely
 *  because not every company's year starts there. */
export function fiscalYearStart(periods: FiscalPeriod[], asOf: string): string | null {
  const inYear = periods.filter((p) => p.startDate <= asOf);
  if (inYear.length === 0) return null;
  const latestYear = inYear[inYear.length - 1].fiscalYear;
  const first = periods.filter((p) => p.fiscalYear === latestYear).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  return first?.startDate ?? null;
}
