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
// EXCEPT the five terminal-action writes (owner decision 2026-08-26: typed-confirmation gate —
// sign-off, close, cutover commit, fiscal-year close, lease recognition). Those forms are useless
// in DEMO_MODE if the POST falls through to an unhandled-route failure — but faking their success
// would be the exact sin this file exists to avoid. So `financeWrite()` near the bottom REPRODUCES
// the live handlers' refusals (bad confirmation string, missing reason, a readiness gate with open
// blockers, an instrument that isn't a lease) against these same fixtures, rather than answering
// every POST with a cheerful `{ok:true}`. Every other write still falls through unanswered.
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
  // The ONLY lease-kind instrument, added for `recognise-lease` below. Without it every attempt at
  // that write would hit "BCA-01 is a loan_payable, not a lease" and the success path — and the
  // asset-class refusal past it — would be unreachable in a browser.
  {
    id: "instr-2", code: "LEASE-01", name: "Sewa gudang — 3 tahun", kind: "lease",
    counterpartyName: "PT Gudang Sentosa", currencyCode: "IDR", principal: "180000000.00",
    nominalRate: "9.000000", effectiveRate: "9.000000",
    startDate: "2026-04-01", maturityDate: "2029-04-01",
    repaymentMethod: "annuity", paymentMonths: 1,
  },
];

// Minimal, and read by `recognise-lease` only — no page reads this list yet (there is no asset-class
// picker built, same gap the cutover page's own comment notes for the fiscal-year close). Codes
// mirror the two classes `FIXED_ASSETS` already uses, so a class id chosen here depreciates the way
// an asset of that class already visibly does elsewhere in the demo.
const ASSET_CLASSES = [
  { id: "cls-it", code: "IT", name: "Peralatan IT" },
  { id: "cls-veh", code: "VEH", name: "Kendaraan" },
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

// Minimal, and read by `closeFiscalYear` below only — no page reads a fiscal-year LIST yet (the
// cutover page's own copy says why: "a fiscal-year list is not something this surface reads — it
// reads cutovers"). `code` is what the live handler makes the caller echo back, and it is the same
// `FY2026` every period in `PERIODS` already carries.
const FISCAL_YEARS = [{ id: "demo-fy-2026", code: `FY${YEAR}` }];

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

/**
 * `body` is a late addition (the five terminal-action writes below need it) and is appended AFTER
 * `userId` rather than before it, so a call site that has not yet been updated to pass it still
 * resolves `userId` in the right slot — its 403 check keeps working, and only the new writes see
 * `body` as `undefined` (which reads as "no confirmation supplied" and refuses, not as a crash).
 */
const AP_VENDORS = [
  {
    id: "vend-1", code: "V-001", name: "PT Kreatif Media Nusantara", npwp: "01.234.567.8-901.000",
    isPkp: true, defaultWithholdingCode: "PPH23", defaultWithholdingRate: "0.020000",
    paymentTermsDays: 30,
  },
  {
    id: "vend-2", code: "V-002", name: "CV Sinar Percetakan", npwp: null,
    isPkp: false, defaultWithholdingCode: null, defaultWithholdingRate: null, paymentTermsDays: 14,
  },
];

// Carries the withholding split explicitly: 38,850,000 billed, 700,000 withheld for DJP, so the
// VENDOR is owed 38,150,000. A fixture that showed only `total` would let a payables surface be
// built that pays the vendor the gross — the exact mistake the split exists to prevent.
// Drafts awaiting approval. Present so the approval queue is DRIVABLE in demo mode — an empty
// queue would let the page look finished while the one control it exists to demonstrate (a bill
// that posts nothing until a different grant admits it) could never be seen.
const AP_DRAFT_BILLS = [
  {
    id: "bill-draft-1", billNo: "BILL-9002", billDate: "2026-08-12", dueDate: "2026-09-11",
    subtotal: "18000000.0000", taxTotal: "1980000.0000", total: "19980000.0000",
    withholdingAmount: "360000.0000", amountPayable: "19620000.0000", amountPaid: "0.0000",
    status: "draft", vendorCode: "V-001", vendorName: "PT Kreatif Media Nusantara",
  },
];

const AP_OPEN_BILLS = [
  {
    id: "bill-1", billNo: "BILL-8841", billDate: "2026-03-18", dueDate: "2026-04-17",
    total: "38850000.0000", amountPayable: "38150000.0000", amountPaid: "0.0000",
    outstanding: "38150000.0000", withholdingAmount: "700000.0000",
    status: "approved", vendorName: "PT Kreatif Media Nusantara",
  },
];

export function financeDemo(method: string, p: string, _params: URLSearchParams, userId?: string, body?: string): DemoResult | null {
  const tail = financePath(p);
  if (tail == null) return null;

  // 403, not an empty shell. `lib/finance.ts`'s readers deliberately distinguish a refusal from
  // absent data (`listPeriods` returns null on 403 and [] on 404, and its header explains why), so
  // answering a refused caller with empty fixtures would defeat the one distinction that file exists
  // to preserve — and would render a balanced, zeroed set of books for someone entitled to none.
  // Applies to the five gated writes too — the live handlers authorize each one separately
  // (`close`/`lock`/`post` against different Cerbos kinds), but this store has always modelled
  // finance access as one reader set, and a write is not the place to invent a second one.
  if (userId !== undefined && !FINANCE_READERS.has(userId)) {
    return { status: 403, json: { error: "forbidden" } };
  }

  if (method.toUpperCase() !== "GET") return financeWrite(tail, body);

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
  // The picker the lease-recognition action is built from. Without this the select renders
  // EMPTY in demo mode and the action is unreachable while the page still looks finished.
  if (tail === "asset-classes") return ok(ASSET_CLASSES);
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
  if (tail === "ap/vendors") return ok(AP_VENDORS);
  if (tail === "ap/open-bills") return ok(AP_OPEN_BILLS);
  if (tail === "ap/bills") return ok(_params.get("status") === "draft" ? AP_DRAFT_BILLS : [...AP_DRAFT_BILLS, ...AP_OPEN_BILLS]);
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

// ── The five terminal-action writes ─────────────────────────────────────────────────────────────
// Owner decision 2026-08-26: sign-off, close, cutover commit, fiscal-year close and lease
// recognition are each gated by a typed confirmation the CALLER supplies and the SERVER re-checks
// — never the form. Every handler below mirrors `finance.controller.ts`'s own order of checks
// exactly (which check runs before which), so a demo refusal reads — and is REACHED — the same way
// the live one is: wrong confirmation text, a missing reason, a readiness gate with open blockers,
// an instrument that isn't a lease, a retained-earnings account this chart doesn't have.
//
// None of this mutates the fixtures above. A second sign-off attempt in a later request sees the
// same static `PERIODS` row it saw the first time — which is why the interesting refusals here
// (already-signed-off, already-closed) come from periods the fixture already put in that state
// (Jan/Feb are HARD_LOCK and signed off; see `PERIODS` above) rather than from a store that
// remembers what a previous call did.

const badRequest = (message: string): DemoResult => ({ status: 400, json: { error: message } });
const notFound = (message: string): DemoResult => ({ status: 404, json: { error: message } });

/**
 * Mirrors `finance.controller.ts::requireConfirmation` verbatim: trimmed, CASE-SENSITIVE, same
 * message. If this drifts from the live wording the demo would teach a refusal the API doesn't
 * actually give — the frontend-first drift this file's header warns about, applied to an error
 * string instead of a data shape.
 */
function requireConfirmation(supplied: string | undefined, expected: string, what: string): DemoResult | null {
  if ((supplied ?? "").trim() !== expected) {
    return badRequest(
      `confirmation does not match — type the ${what} exactly as "${expected}" to proceed. `
      + `This action cannot be undone by an ordinary correction.`,
    );
  }
  return null;
}

/** The readiness gate a period close re-checks. Computed per-period rather than the single
 *  `CLOSE_READINESS` GET fixture (which answers every period id with the March blockers — a
 *  pre-existing simplification of the GET route, left alone since it isn't this write's remit) —
 *  reusing that fixture verbatim here would tell someone closing, say, Aug 2026 that "period Mar
 *  2026 has no signed_off_by", which is a wrong sentence about the wrong period. AP_RECONCILIATION
 *  is genuinely period-independent (the subledger tie-out this demo estate keeps broken on
 *  purpose), so it applies to every period the same way the live gate would apply it. */
function periodCloseBlockers(period: FiscalPeriod): Array<{ blocker: string; detail: string }> {
  const blockers: Array<{ blocker: string; detail: string }> = [];
  if (!AP_RECONCILE.clean) {
    for (const p of AP_RECONCILE.problems) blockers.push({ blocker: "AP_RECONCILIATION", detail: p.detail });
  }
  if (!period.signedOff) {
    blockers.push({
      blocker: "NO_ACCOUNTANT_SIGNOFF",
      detail: `period ${period.name} has no signed_off_by — a HARD_LOCK will be refused (owner ruling D-F5)`,
    });
  }
  return blockers;
}

function signOffDemo(periodId: string, b: { confirm?: string }): DemoResult {
  const period = PERIODS.find((x) => x.id === periodId);
  if (!period) return notFound("no such fiscal period in this company");
  const refused = requireConfirmation(b.confirm, period.name, "period");
  if (refused) return refused;
  if (period.signedOff) return badRequest(`${period.name} is already signed off`);
  return { status: 200, json: { ok: true, period: period.name } };
}

function closePeriodDemo(periodId: string, b: { confirm?: string; reason?: string; hard?: boolean }): DemoResult {
  const hard = b.hard === true;
  // Checked before the period even loads, matching the live handler — a close with no reason is
  // refused regardless of which period was asked for.
  const reason = b.reason?.trim();
  if (!reason) return badRequest("reason is required — a locked period needs an explanation that outlives the person who locked it");

  const period = PERIODS.find((x) => x.id === periodId);
  if (!period) return notFound("no such fiscal period in this company");
  const refused = requireConfirmation(b.confirm, period.name, "period");
  if (refused) return refused;

  if (period.state === "HARD_LOCK") return badRequest(`${period.name} is already hard-locked`);
  if (!hard && period.state === "SOFT_LOCK") return badRequest(`${period.name} is already closed`);

  const blockers = periodCloseBlockers(period);
  if (blockers.length > 0) {
    return badRequest(
      `${period.name} is not ready to close — ${blockers.map((x) => `${x.blocker}: ${x.detail}`).join("; ")}`,
    );
  }
  return { status: 200, json: { ok: true, period: period.name, state: hard ? "HARD_LOCK" : "SOFT_LOCK" } };
}

function commitCutoverDemo(cutoverId: string, b: { confirm?: string }): DemoResult {
  const cutover = CUTOVERS.find((x) => x.id === cutoverId);
  if (!cutover) return notFound("no such cutover in this company");
  // The DATE, not an id — same reason the live handler picks it: it is the line every figure the
  // company reports is measured from, and it is the thing worth having read before committing.
  const refused = requireConfirmation(b.confirm, cutover.cutoverDate, "cutover date");
  if (refused) return refused;

  // `CUTOVER_READINESS` is deliberately never clean (the opening is 2,000,000 unbalanced, reported
  // rather than plugged — see the fixture above), so this is the one write of the five with no
  // reachable success in this demo estate. That is not a gap: it is the live handler's own gate,
  // faithfully refusing an opening that genuinely does not balance.
  if (CUTOVER_READINESS.blockers.length > 0) {
    return badRequest(
      `cutover ${cutover.cutoverDate} is not ready — `
      + `${CUTOVER_READINESS.blockers.map((x) => `${x.blocker}: ${x.detail}`).join("; ")}`,
    );
  }
  return { status: 201, json: { ok: true, journalId: `demo-j-cutover-${cutover.id}`, cutoverDate: cutover.cutoverDate } };
}

function closeFiscalYearDemo(fiscalYearId: string, b: { confirm?: string; retainedAccountCode?: string }): DemoResult {
  const year = FISCAL_YEARS.find((x) => x.id === fiscalYearId);
  if (!year) return notFound("no such fiscal year in this company");
  const refused = requireConfirmation(b.confirm, year.code, "fiscal year");
  if (refused) return refused;

  // Same default the engine itself uses — 3300 RETAINED earnings, never 3200 (current-year
  // result). `ACCOUNTS` above has no 3300, so the default call refuses honestly rather than
  // inventing an account this demo's chart was never given; passing an existing code (e.g. 3100)
  // reaches the success path.
  const retained = b.retainedAccountCode?.trim() || "3300";
  if (!ACCOUNTS.some((a) => a.code === retained)) {
    return badRequest(`unknown retained-earnings account ${retained}`);
  }
  return {
    status: 201,
    json: { ok: true, journalId: `demo-j-fy-close-${year.id}`, fiscalYear: year.code, retainedAccountCode: retained },
  };
}

function recogniseLeaseDemo(instrumentId: string, b: { confirm?: string; assetClassId?: string }): DemoResult {
  // Checked before the instrument even loads, matching the live handler.
  if (!b.assetClassId) return badRequest("assetClassId is required — it sets how the right-of-use asset depreciates");

  const instrument = INSTRUMENTS.find((x) => x.id === instrumentId);
  if (!instrument) return notFound("no such instrument in this company");
  if (instrument.kind !== "lease") {
    return badRequest(`${instrument.code} is a ${instrument.kind}, not a lease — only a lease is recognised under PSAK 73`);
  }
  const refused = requireConfirmation(b.confirm, instrument.code, "instrument code");
  if (refused) return refused;

  if (!ASSET_CLASSES.some((c) => c.id === b.assetClassId)) return badRequest("no such asset class in this company");

  return { status: 201, json: { ok: true, assetId: `demo-asset-${instrument.id}`, instrument: instrument.code } };
}

/** Dispatches the five gated writes; every other write still falls through unanswered (`null`), for
 *  exactly the reason the top-of-file comment gives. */
function financeWrite(tail: string, body: string | undefined): DemoResult | null {
  const b = body ? JSON.parse(body) : {};

  const signOff = /^periods\/([^/]+)\/sign-off$/.exec(tail);
  if (signOff) return signOffDemo(signOff[1], b);

  const close = /^periods\/([^/]+)\/close$/.exec(tail);
  if (close) return closePeriodDemo(close[1], b);

  const commit = /^cutovers\/([^/]+)\/commit$/.exec(tail);
  if (commit) return commitCutoverDemo(commit[1], b);

  const fyClose = /^fiscal-years\/([^/]+)\/close$/.exec(tail);
  if (fyClose) return closeFiscalYearDemo(fyClose[1], b);

  const lease = /^instruments\/([^/]+)\/recognise-lease$/.exec(tail);
  if (lease) return recogniseLeaseDemo(lease[1], b);

  return null;
}
