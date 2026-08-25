import "server-only";
// DEMO_MODE fixtures for `/api/:t/finance/*`.
//
// READ-ONLY, like demoLms.ts and for the same reason: the /finance surface this wave ships is a
// read console. A fixture that accepted a journal post it could not model would let the page look
// like it worked, and this is the one module where "looked like it worked" involves money.
//
// Why it exists at all: `next build` runs with DEMO_MODE=1 and the smoke Playwright project drives
// the built app, so a route with no fixture is a route nobody can open in CI. Without this the
// finance page would render its "no fiscal calendar" empty state forever — and that copy is a CLAIM
// about the company's setup, not a neutral blank.
//
// ── THE FIXTURE IS DELIBERATELY NOT ALL-GREEN ───────────────────────────────────────────────────
// The demo estate has ONE unreconciled subledger and an unsigned period. That is on purpose, and it
// is the whole point of a demo fixture for this surface:
//
//   * a books-perfect demo cannot exercise the blocker table, the "does not tie" badge, or the
//     close gate — which are the three things this console exists to show;
//   * and it would train whoever browses it to expect green, which is exactly the reflex the page
//     is designed to avoid.
//
// The AR side ties and the AP side does not, so both states are visible side by side.
import type {
  Account, FiscalPeriod, TrialBalance, BalanceSheet, ArAgingRow, ApAgingRow,
  LedgerVerdict, ReconcileVerdict, ArPosition, ApPosition, CloseReadiness,
  JournalSummary, PpnSummary, EfakturException,
} from "./finance";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });

const YEAR = 2026;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const lastDay = (m: number) => new Date(Date.UTC(YEAR, m + 1, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

// A full calendar: the first two months closed, March closing, the rest open — so the period table
// shows all three states rather than a wall of one.
const PERIODS: FiscalPeriod[] = MONTHS.map((name, i) => ({
  id: `demo-period-${i + 1}`,
  periodNo: i + 1,
  name: `${name} ${YEAR}`,
  startDate: `${YEAR}-${pad(i + 1)}-01`,
  endDate: `${YEAR}-${pad(i + 1)}-${pad(lastDay(i))}`,
  state: i < 2 ? "HARD_LOCK" : i === 2 ? "SOFT_LOCK" : "OPEN",
  signedOff: i < 2,
  fiscalYear: `FY${YEAR}`,
}));

const ACCOUNTS: Account[] = [
  { code: "1110", name: "Kas", accountType: "asset", normalBalance: "debit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true, status: "active", hasPostings: true },
  { code: "1120", name: "Bank", accountType: "asset", normalBalance: "debit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true, status: "active", hasPostings: true },
  { code: "1130", name: "Piutang Usaha", accountType: "asset", normalBalance: "debit", isPostable: true, isControl: true, controlSubledger: "ar", allowManualPosting: false, status: "active", hasPostings: true },
  // A contra asset, so the balance sheet's negative-under-assets rendering is drivable.
  { code: "1220", name: "Akumulasi Penyusutan", accountType: "asset", normalBalance: "credit", isPostable: true, isControl: true, controlSubledger: "fixed_assets", allowManualPosting: false, status: "active", hasPostings: true },
  { code: "2110", name: "Utang Usaha", accountType: "liability", normalBalance: "credit", isPostable: true, isControl: true, controlSubledger: "ap", allowManualPosting: false, status: "active", hasPostings: true },
  { code: "2140", name: "PPN Keluaran", accountType: "liability", normalBalance: "credit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true, status: "active", hasPostings: true },
  { code: "3100", name: "Modal Saham", accountType: "equity", normalBalance: "credit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true, status: "active", hasPostings: true },
  { code: "4100", name: "Pendapatan Usaha", accountType: "revenue", normalBalance: "credit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true, status: "active", hasPostings: true },
  { code: "6100", name: "Beban Gaji dan Tunjangan", accountType: "expense", normalBalance: "debit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true, status: "active", hasPostings: true },
  { code: "6200", name: "Beban Sewa", accountType: "expense", normalBalance: "debit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true, status: "active", hasPostings: false },
];

// The trial balance BALANCES, because a trial balance that did not would be a bug in the fixture
// rather than an interesting demo state — the interesting failures live in the subledger tie-out.
const TRIAL_BALANCE: TrialBalance = {
  rows: [
    { code: "1120", name: "Bank", accountType: "asset", debit: "620000000.0000", credit: "0.0000", balance: "620000000.0000" },
    { code: "1130", name: "Piutang Usaha", accountType: "asset", debit: "185000000.0000", credit: "0.0000", balance: "185000000.0000" },
    { code: "1220", name: "Akumulasi Penyusutan", accountType: "asset", debit: "0.0000", credit: "12000000.0000", balance: "12000000.0000" },
    { code: "2110", name: "Utang Usaha", accountType: "liability", debit: "0.0000", credit: "94000000.0000", balance: "94000000.0000" },
    { code: "3100", name: "Modal Saham", accountType: "equity", debit: "0.0000", credit: "500000000.0000", balance: "500000000.0000" },
    { code: "4100", name: "Pendapatan Usaha", accountType: "revenue", debit: "0.0000", credit: "331000000.0000", balance: "331000000.0000" },
    { code: "6100", name: "Beban Gaji dan Tunjangan", accountType: "expense", debit: "108000000.0000", credit: "0.0000", balance: "108000000.0000" },
    { code: "6200", name: "Beban Sewa", accountType: "expense", debit: "24000000.0000", credit: "0.0000", balance: "24000000.0000" },
  ],
  totalDebit: 937_000_000,
  totalCredit: 937_000_000,
  balanced: true,
};

// A = L + E, with the year's profit carried into equity — the property the page reports on.
//   assets      620m bank + 185m AR - 12m accumulated depreciation = 793m
//   liabilities 94m
//   equity      500m capital + 199m profit (331m revenue - 132m expense) = 699m
const BALANCE_SHEET: BalanceSheet = {
  rows: [
    { section: "asset", code: "1120", name: "Bank", amount: "620000000.0000" },
    { section: "asset", code: "1130", name: "Piutang Usaha", amount: "185000000.0000" },
    { section: "asset", code: "1220", name: "Akumulasi Penyusutan", amount: "-12000000.0000" },
    { section: "liability", code: "2110", name: "Utang Usaha", amount: "94000000.0000" },
    { section: "equity", code: "3100", name: "Modal Saham", amount: "500000000.0000" },
    { section: "equity", code: "CURRENT_YEAR_PROFIT", name: "Current year profit (not yet closed)", amount: "199000000.0000" },
    { section: "total", code: "TOTAL_ASSETS", name: "Total assets", amount: "793000000.0000" },
    { section: "total", code: "TOTAL_LIABILITIES", name: "Total liabilities", amount: "94000000.0000" },
    { section: "total", code: "TOTAL_EQUITY", name: "Total equity", amount: "699000000.0000" },
  ],
  assets: 793_000_000,
  liabilities: 94_000_000,
  equity: 699_000_000,
  balanced: true,
};

const AR_AGING: ArAgingRow[] = [
  { customerCode: "CUST-001", customerName: "Viceroy Bali", current: "120000000.0000", d1To30: "0.0000", d31To60: "0.0000", d61To90: "0.0000", d90Plus: "0.0000", totalOutstanding: "120000000.0000" },
  { customerCode: "CUST-002", customerName: "Bambu Silver", current: "0.0000", d1To30: "40000000.0000", d31To60: "0.0000", d61To90: "0.0000", d90Plus: "0.0000", totalOutstanding: "40000000.0000" },
  // One genuinely old debt, so the 90+ column is not permanently empty in the demo.
  { customerCode: "CUST-003", customerName: "Mould Solution", current: "0.0000", d1To30: "0.0000", d31To60: "0.0000", d61To90: "0.0000", d90Plus: "25000000.0000", totalOutstanding: "25000000.0000" },
];

const AP_AGING: ApAgingRow[] = [
  { vendorCode: "VEN-001", vendorName: "Konsultan Hukum", current: "63000000.0000", d1To30: "0.0000", d31To60: "0.0000", d61To90: "0.0000", d90Plus: "0.0000", totalOutstanding: "63000000.0000" },
  { vendorCode: "VEN-002", vendorName: "PT Sewa Kantor", current: "0.0000", d1To30: "31000000.0000", d31To60: "0.0000", d61To90: "0.0000", d90Plus: "0.0000", totalOutstanding: "31000000.0000" },
];

const LEDGER_CLEAN: LedgerVerdict = { problems: [], clean: true };

const AR_RECONCILE: ReconcileVerdict<ArPosition> = {
  position: { openInvoices: "185000000.0000", paymentsOnAccount: "0.0000", netReceivable: "185000000.0000" },
  problems: [],
  clean: true,
};

// ⚠ DELIBERATELY BROKEN. Without one failing tie-out, the "does not tie" badge and the problem
// table below it are unreachable in a browser — and they are the reason this console exists.
const AP_RECONCILE: ReconcileVerdict<ApPosition> = {
  position: { openBills: "94000000.0000", paymentsOnAccount: "0.0000", netPayable: "94000000.0000" },
  problems: [
    {
      problem: "AP_BILL_PAID_CACHE_DRIFT",
      detail: "bill VINV-0042: amount_paid 12000000.0000 <> allocations 0.0000",
    },
  ],
  clean: false,
};

const CLOSE_READINESS: CloseReadiness = {
  blockers: [
    {
      blocker: "AP_RECONCILIATION",
      detail: "AP_BILL_PAID_CACHE_DRIFT: bill VINV-0042: amount_paid 12000000.0000 <> allocations 0.0000",
    },
    {
      blocker: "NO_ACCOUNTANT_SIGNOFF",
      detail: "period Mar 2026 has no signed_off_by — a HARD_LOCK will be refused (owner ruling D-F5)",
    },
  ],
  ready: false,
};

const JOURNALS: JournalSummary[] = [
  { id: "demo-j-3", ledgerSequence: "3", entryDate: `${YEAR}-03-20`, kind: "standard", description: "Consulting revenue — Viceroy", currency: "IDR", totalDebit: "120000000.0000", sourceEventId: "ar-invoice:demo-1", status: "posted" },
  { id: "demo-j-2", ledgerSequence: "2", entryDate: `${YEAR}-03-10`, kind: "standard", description: "Office rent March", currency: "IDR", totalDebit: "12000000.0000", sourceEventId: "evt-rent-03", status: "reversed" },
  { id: "demo-j-1", ledgerSequence: "1", entryDate: `${YEAR}-01-02`, kind: "opening", description: "Opening capital", currency: "IDR", totalDebit: "500000000.0000", sourceEventId: "seed-1", status: "posted" },
];

const PPN: PpnSummary = {
  outputVat: "36410000.0000",
  inputVatCreditable: "9240000.0000",
  // A non-zero uncreditable figure, because that number is a real cost the surface must show
  // rather than bury — a demo of 0 would never exercise the copy that explains it.
  inputVatUncreditable: "2200000.0000",
  netPayable: "27170000.0000",
};

const EFAKTUR_EXCEPTIONS: EfakturException[] = [
  { kind: "AP_INPUT_VAT_LOST", documentNo: "VINV-0042", counterparty: "PT Sewa Kantor", docDate: `${YEAR}-03-18`, taxAmount: "2200000.0000", detail: "input VAT NOT creditable without a vendor e-Faktur — this amount is a real cost" },
];

// ── UI-01c / UI-02b — the cap table and settings ────────────────────────────────────────────────
// Deliberately NOT a tidy 100%: the demo cap table totals 85, so STAKE_INCOMPLETE renders and the
// "the rest is unrecorded, which is not the same as unowned" line is reachable in a browser. A
// demo that adds up perfectly hides the whole reason the validation exists.
const OWNERSHIP = {
  edges: [
    {
      id: "own-1",
      holderUserId: "demo-anthony",
      holderCompanyId: null,
      holderName: "Anthony Syrowatka",
      holderKind: "person",
      kind: "holding",
      stakePct: "60.000000",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      notes: "Founder",
    },
    {
      id: "own-2",
      holderUserId: null,
      holderCompanyId: "demo-holding",
      holderName: "D & A Syrowatka",
      holderKind: "company",
      kind: "shareholder",
      stakePct: "25.000000",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      notes: null,
    },
    {
      id: "own-3",
      holderUserId: "demo-former",
      holderCompanyId: null,
      holderName: "Former Shareholder",
      holderKind: "person",
      kind: "shareholder",
      stakePct: "15.000000",
      effectiveFrom: "2025-01-01",
      effectiveTo: "2026-01-01",
      notes: "Bought out",
    },
  ],
  problems: [
    {
      problem: "STAKE_INCOMPLETE",
      detail: "live stakes total 85% — the remaining 15% is not recorded, which is not the same as nobody holding it",
    },
  ],
};

const SETTINGS = {
  functionalCurrency: "IDR",
  presentationCurrency: "IDR",
  fiscalYearStartMonth: 1,
  isPkp: true,
  npwp: "012345678901000",
  coaTemplateKey: "id_psak_general_v1",
};

/** Matches `/api/:tenantId/finance/...` and returns the tail, or null. */
function financePath(p: string): string | null {
  const m = /^\/api\/[^/]+\/finance\/(.+)$/.exec(p);
  return m ? m[1] : null;
}

export function financeDemo(method: string, p: string, _params: URLSearchParams): DemoResult | null {
  const tail = financePath(p);
  if (tail == null) return null;
  // Read-only: a write must fall through to whatever the caller does with an unhandled route,
  // rather than being answered with a cheerful {ok:true} this store cannot actually model.
  if (method.toUpperCase() !== "GET") return null;

  if (tail === "accounts") return ok(ACCOUNTS);
  if (tail === "ownership") return ok(OWNERSHIP);
  if (tail === "settings") return ok(SETTINGS);
  if (tail === "periods") return ok(PERIODS);
  if (tail === "trial-balance") return ok(TRIAL_BALANCE);
  if (tail === "balance-sheet") return ok(BALANCE_SHEET);
  if (tail === "journals") return ok(JOURNALS);
  if (tail === "ledger/verify") return ok(LEDGER_CLEAN);
  if (tail === "ar/aging") return ok(AR_AGING);
  if (tail === "ap/aging") return ok(AP_AGING);
  if (tail === "ar/reconcile") return ok(AR_RECONCILE);
  if (tail === "ap/reconcile") return ok(AP_RECONCILE);
  if (tail === "tax/ppn") return ok(PPN);
  if (tail === "tax/efaktur-exceptions") return ok(EFAKTUR_EXCEPTIONS);
  if (/^periods\/[^/]+\/close-readiness$/.test(tail)) return ok(CLOSE_READINESS);
  if (tail.startsWith("profit-and-loss")) {
    return ok([
      { section: "revenue", code: "4100", name: "Pendapatan Usaha", amount: "331000000.0000" },
      { section: "expense", code: "6100", name: "Beban Gaji dan Tunjangan", amount: "108000000.0000" },
      { section: "expense", code: "6200", name: "Beban Sewa", amount: "24000000.0000" },
      { section: "total", code: "TOTAL_REVENUE", name: "Total revenue", amount: "331000000.0000" },
      { section: "total", code: "TOTAL_EXPENSE", name: "Total expense", amount: "132000000.0000" },
      { section: "total", code: "NET_PROFIT", name: "Net profit", amount: "199000000.0000" },
    ]);
  }
  return null;
}
