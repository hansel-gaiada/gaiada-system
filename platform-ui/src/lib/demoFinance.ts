import "server-only";
// DEMO_MODE fixtures for `/api/:t/finance/*`.
//
// ⚠ THESE FIXTURES MUST MATCH THE LIVE RESPONSE SHAPE, NOT A TIDIER VERSION OF IT.
//
// On 2026-08-25 /finance crashed in production while DEMO_MODE was green. The BFF returned
// `endDate: "2026-01-31T00:00:00.000Z"` (pg maps a date column to a JS Date), the page fed that
// back as ?asOf= and the API rejected the datetime with a 400. These fixtures used plain
// "2026-01-31", so the build gate, the e2e suite and every local browse exercised a shape the
// backend never produced.
//
// The BFF now casts date columns to ::text so YYYY-MM-DD is the real answer and these fixtures are
// correct again — but the lesson generalises: a fixture that is neater than reality does not
// simplify the demo, it hides the bug.
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

// Journal DETAIL, so /finance/journals/[entryId] is drivable in a browser and in the build gate.
// demo-j-2 is the REVERSED one on purpose: the "this entry has been reversed" copy and the absence
// of a reverse button are only reachable through it, and those are the parts most likely to be
// written wrongly.
const JOURNAL_DETAIL: Record<string, unknown> = {
  "demo-j-3": {
    ...JOURNALS[0],
    totalCredit: "120000000.0000",
    reversalOfId: null,
    reversalReason: null,
    entryHash: "9f2b7c1d4e6a8035bb1f42c7d0e59a83f6142bd7c8e0a95b3d71fe28460ac5d9",
    lines: [
      { lineNo: 1, accountCode: "1130", accountName: "Piutang Usaha", side: "debit", amount: "120000000.0000", memo: "Viceroy — March" },
      { lineNo: 2, accountCode: "4100", accountName: "Pendapatan Usaha", side: "credit", amount: "120000000.0000", memo: null },
    ],
  },
  "demo-j-2": {
    ...JOURNALS[1],
    totalCredit: "12000000.0000",
    reversalOfId: null,
    reversalReason: null,
    entryHash: "1a4d90b3f7c25e8846db03af9c6e1750d283bb41f0a97ce65214b8f3e07c9a2b",
    lines: [
      { lineNo: 1, accountCode: "6200", accountName: "Beban Sewa", side: "debit", amount: "12000000.0000", memo: "March rent" },
      { lineNo: 2, accountCode: "1120", accountName: "Bank", side: "credit", amount: "12000000.0000", memo: null },
    ],
  },
};

// A short movement history so the running balance and the debit/credit split are both visible.
const GENERAL_LEDGER = [
  { ledgerSequence: "1", entryDate: `${YEAR}-01-02`, description: "Opening capital", memo: null,
    side: "debit", amount: "500000000.0000", runningBalance: "500000000.0000", entryKind: "opening" },
  { ledgerSequence: "2", entryDate: `${YEAR}-03-10`, description: "Office rent March", memo: "March rent",
    side: "credit", amount: "12000000.0000", runningBalance: "488000000.0000", entryKind: "standard" },
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

/** Demo identities that hold finance READ access.
 *
 *  Added because this store previously modelled NO authz at all — every identity, including a plain
 *  member, was served the company's books. That is not a harmless fixture shortcut: the whole point of
 *  DEMO_MODE is to drive negative-permission rendering in a browser, and a surface where the refusal
 *  path is unreachable is a surface whose refusal path nobody has ever seen.
 *
 *  Mirrors the real holders of `finance.statement.read` per `role-permission-bundles.json` —
 *  `company_admin`, `finance_manager`, `finance_staff`, `owner`, `platform_admin` — intersected with
 *  the identities `demoFixtures.ts` actually wires. Today that is exactly `demo-hansel`
 *  (platform_admin). `dept-manager` (manager), `gede-ic` (member) and `seo-staff` (search_staff) hold
 *  none of them and are correctly refused. */
const FINANCE_READERS = new Set(["demo-hansel"]);

const AR_CUSTOMERS = [
  { id: "cust-1", code: "C-001", name: "PT Bali Beach Resort", paymentTermsDays: 30, isPkp: true },
  { id: "cust-2", code: "C-002", name: "CV Nusantara Kopi", paymentTermsDays: 14, isPkp: true },
];

const AR_OPEN_INVOICES = [
  {
    id: "inv-1", invoiceNo: "INV-2026-001", invoiceDate: "2026-02-10", dueDate: "2026-03-12",
    total: "66600000.0000", amountPaid: "20000000.0000", outstanding: "46600000.0000",
    customerName: "PT Bali Beach Resort",
  },
  {
    id: "inv-2", invoiceNo: "INV-2026-002", invoiceDate: "2026-03-20", dueDate: "2026-04-03",
    total: "27750000.0000", amountPaid: "0.0000", outstanding: "27750000.0000",
    customerName: "CV Nusantara Kopi",
  },
];

// ── The four engine surfaces (F8/F9/F10/F11) ────────────────────────────────────────────────────
// Without these the new tabs render EMPTY in demo mode while the build gate still passes — the
// "looks built, is unusable" failure this store exists to prevent. The figures mirror the shapes the
// live estate actually returns, including the two that are deliberately NOT clean: treasury has a
// tagging discrepancy, and the consolidation run below carries eliminations so its trial balance is
// legitimately servable.

const FIXED_ASSETS = [
  {
    id: "asset-1", code: "IT-001", name: "MacBook Pro 16 — Creative", status: "active",
    acquisitionDate: "2026-02-10", inServiceDate: "2026-02-10", cost: "42000000.00",
    classCode: "IT", className: "Peralatan IT", bookMethod: "straight_line", bookLifeMonths: 36,
    taxGolongan: "gol_1",
    bookAccum: "8166666.67", bookNbv: "33833333.33", taxAccum: "10500000.00", taxNbv: "31500000.00",
  },
  {
    id: "asset-2", code: "VEH-001", name: "Toyota Innova — operasional", status: "active",
    acquisitionDate: "2026-01-20", inServiceDate: "2026-01-20", cost: "380000000.00",
    classCode: "VEH", className: "Kendaraan", bookMethod: "straight_line", bookLifeMonths: 60,
    taxGolongan: "gol_2",
    bookAccum: "44333333.33", bookNbv: "335666666.67", taxAccum: "47500000.00", taxNbv: "332500000.00",
  },
];

const ASSET_SCHEDULE = Array.from({ length: 6 }, (_, i) => ({
  seq: i + 1,
  periodStart: `2026-0${i + 2}-01`,
  bookCharge: "1166666.67",
  bookAccum: String((i + 1) * 1166666.67),
  bookNbv: String(42000000 - (i + 1) * 1166666.67),
  taxCharge: "1750000.00",
  taxAccum: String((i + 1) * 1750000),
  taxNbv: String(42000000 - (i + 1) * 1750000),
}));

const DEPRECIATION_RUNS = [
  {
    id: "dep-1", periodId: "per-3", periodName: "Mar 2026", periodStart: "2026-03-01",
    journalId: "jrn-dep-1", runAt: "2026-03-31T12:00:00.000Z",
    assetCount: 3, bookTotal: "8500000.00", taxTotal: "9750000.00",
  },
];

const INSTRUMENTS = [
  {
    id: "instr-1", code: "BCA-01", name: "Kredit modal kerja BCA", kind: "loan_payable",
    counterpartyName: "Bank BCA", currencyCode: "IDR", principal: "240000000.00",
    nominalRate: "11.500000", effectiveRate: "11.500000",
    startDate: "2026-02-01", maturityDate: "2028-02-01",
    repaymentMethod: "annuity", paymentMonths: 1,
  },
];

const INSTRUMENT_SCHEDULE = Array.from({ length: 6 }, (_, i) => {
  const opening = 240000000 - i * 9500000;
  const interest = Math.round(opening * 0.115 / 12);
  const principal = 11700000 - interest;
  return {
    seq: i + 1,
    dueDate: `2026-0${i + 3}-01`,
    opening: opening.toFixed(2),
    interest: interest.toFixed(2),
    principal: principal.toFixed(2),
    closing: (opening - principal).toFixed(2),
  };
});

const TREASURY_MATURITY = [
  {
    instrumentId: "instr-1", code: "BCA-01", kind: "loan_payable",
    outstanding: "212400000.00", currentPortion: "104800000.00",
    nonCurrentPortion: "107600000.00", maturityDate: "2028-02-01",
  },
];

// NOT clean, on purpose. The live estate reports exactly this: the tie-out sums accounts TAGGED as
// treasury, and the seeded loan sits on an untagged liability account. A fixture that reported clean
// would hide the one state this page has real copy for.
const TREASURY_RECONCILE = {
  clean: false,
  problems: [
    {
      problem: "TREASURY_CONTROL_MISMATCH",
      detail: "Instrument balances total 212,400,000 but accounts tagged `treasury` total 0 — check account tagging before hunting for a missing entry.",
    },
  ],
};

const CONSOLIDATION_RUNS = [
  { id: "consol-1", asOf: "2026-08-31", label: "August group pack", createdAt: "2026-09-01T02:00:00.000Z", entryCount: 3 },
];

const CONSOLIDATED_TB = {
  rows: [
    { accountCode: "1120", accountName: "Bank", accountType: "asset", debit: "612500000.00", credit: "0.00" },
    { accountCode: "1210", accountName: "Aset tetap", accountType: "asset", debit: "458000000.00", credit: "0.00" },
    { accountCode: "2210", accountName: "Utang bank", accountType: "liability", debit: "0.00", credit: "212400000.00" },
    { accountCode: "3100", accountName: "Modal saham", accountType: "equity", debit: "0.00", credit: "500000000.00" },
    { accountCode: "4100", accountName: "Pendapatan jasa", accountType: "revenue", debit: "0.00", credit: "506100000.00" },
    { accountCode: "6100", accountName: "Beban gaji", accountType: "expense", debit: "148000000.00", credit: "0.00" },
  ],
  totalDebit: "1218500000.00",
  totalCredit: "1218500000.00",
  balanced: true,
};

const CONSOLIDATION_COMPLETENESS = {
  complete: false,
  notes: [
    { note: "NCI_NOT_RECOGNISED", detail: "No non-controlling interest has been recognised for any partially-owned member (PSAK 65)." },
  ],
};

const CUTOVERS = [
  {
    id: "cut-1", cutoverDate: "2026-01-01", status: "draft", journalId: null,
    committedAt: null, notes: "Balances carried in from the previous bookkeeper", lineCount: 4,
  },
];

const CUTOVER_READINESS = {
  ready: false,
  blockers: [
    { blocker: "OPENING_UNBALANCED", detail: "Opening debits 500,000,000 against credits 498,000,000 — a difference of 2,000,000. Reported, never plugged." },
  ],
};

const OPENING_BALANCES = {
  rows: [
    { id: "ob-1", accountCode: "1120", accountName: "Bank", debit: "300000000.00", credit: "0.00", memo: "BCA closing balance" },
    { id: "ob-2", accountCode: "1210", accountName: "Aset tetap", debit: "200000000.00", credit: "0.00", memo: null },
    { id: "ob-3", accountCode: "3100", accountName: "Modal saham", debit: "0.00", credit: "498000000.00", memo: null },
    { id: "ob-4", accountCode: "9999", accountName: null, debit: "0.00", credit: "0.00", memo: "code not in the chart — the readiness gate reports this" },
  ],
  totalDebit: "500000000.00",
  totalCredit: "498000000.00",
  balanced: false,
};

export function financeDemo(method: string, p: string, _params: URLSearchParams, userId?: string): DemoResult | null {
  const tail = financePath(p);
  if (tail == null) return null;
  // Read-only: a write must fall through to whatever the caller does with an unhandled route,
  // rather than being answered with a cheerful {ok:true} this store cannot actually model.
  if (method.toUpperCase() !== "GET") return null;

  // 403, not an empty shell. `lib/finance.ts`'s readers deliberately distinguish a refusal from
  // absent data (`listPeriods` returns null on 403 and [] on 404, and its header explains why), so
  // answering a refused caller with empty fixtures would defeat the one distinction that file exists
  // to preserve — and would render a balanced, zeroed set of books for someone entitled to none.
  if (userId !== undefined && !FINANCE_READERS.has(userId)) {
    return { status: 403, json: { error: "forbidden" } };
  }

  if (tail === "accounts") return ok(ACCOUNTS);
  // The general ledger for any account, so /finance/ledger is drivable in the build gate.
  if (tail.startsWith("general-ledger/")) return ok(GENERAL_LEDGER);
  if (tail === "ownership") return ok(OWNERSHIP);
  if (tail === "settings") return ok(SETTINGS);
  if (tail === "periods") return ok(PERIODS);
  if (tail === "trial-balance") return ok(TRIAL_BALANCE);
  if (tail === "balance-sheet") return ok(BALANCE_SHEET);
  if (tail === "journals") return ok(JOURNALS);
  const jd = /^journals\/([^/]+)$/.exec(tail);
  if (jd) return ok(JOURNAL_DETAIL[jd[1]] ?? null);
  if (tail === "ledger/verify") return ok(LEDGER_CLEAN);
  // The two pickers the receivables write forms are built from. Without these the forms render
  // with EMPTY dropdowns in demo mode and the build gate still passes — the page would look built
  // and be unusable, which is the frontend-first drift this codebase keeps getting bitten by.
  if (tail === "assets") return ok(FIXED_ASSETS);
  if (tail === "assets/reconcile") return ok({ problems: [], clean: true });
  if (/^assets\/[^/]+\/schedule$/.test(tail)) return ok(ASSET_SCHEDULE);
  if (tail === "depreciation-runs") return ok(DEPRECIATION_RUNS);
  if (tail === "instruments") return ok(INSTRUMENTS);
  if (/^instruments\/[^/]+\/schedule$/.test(tail)) return ok(INSTRUMENT_SCHEDULE);
  if (tail === "treasury/maturity") return ok(TREASURY_MATURITY);
  if (tail === "treasury/reconcile") return ok(TREASURY_RECONCILE);
  if (tail === "consolidation/runs") return ok(CONSOLIDATION_RUNS);
  if (/^consolidation\/runs\/[^/]+\/trial-balance$/.test(tail)) return ok(CONSOLIDATED_TB);
  if (/^consolidation\/runs\/[^/]+\/completeness$/.test(tail)) return ok(CONSOLIDATION_COMPLETENESS);
  if (tail === "cutovers") return ok(CUTOVERS);
  if (/^cutovers\/[^/]+\/readiness$/.test(tail)) return ok(CUTOVER_READINESS);
  if (/^cutovers\/[^/]+\/opening-balances$/.test(tail)) return ok(OPENING_BALANCES);
  if (tail === "ar/customers") return ok(AR_CUSTOMERS);
  if (tail === "ar/open-invoices") return ok(AR_OPEN_INVOICES);
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
