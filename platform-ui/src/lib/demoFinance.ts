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
// EXCEPT the six typed-confirmation writes (owner decision 2026-08-26 — sign-off, close, cutover
// commit, fiscal-year close, lease recognition — plus period REOPEN, the counterpart to close,
// added alongside the rest of the F3/F9/F11 write surface below). Those forms are useless in
// DEMO_MODE if the POST falls through to an unhandled-route failure — but faking their success
// would be the exact sin this file exists to avoid. So `financeWrite()` near the bottom REPRODUCES
// the live handlers' refusals (bad confirmation string, missing reason, a readiness gate with open
// blockers, an instrument that isn't a lease, a HARD_LOCK that cannot be reopened) against these
// same fixtures, rather than answering every POST with a cheerful `{ok:true}`.
//
// A second, smaller group of PLAIN writes (create a consolidation run, generate its eliminations,
// record an instrument, post an interest accrual, add a customer, add a vendor) is handled the same
// way for the same reason — none of them is confirmation-gated, but each has a real validation shape
// worth mirroring (duplicate codes, range checks, unknown ids) rather than a blind `{ok:true}`.
// Everything else still falls through unanswered to demoFixtures.ts's generic write fallback.
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
  // Contra-revenue, so the credit-note form's account picker has something real to filter to — see
  // `financePath`'s AR credit note dispatch below. Normal balance is DEBIT (opposite of ordinary
  // revenue) because these accounts reduce revenue rather than record it.
  { code: "4200", name: "Potongan Penjualan", accountType: "revenue", normalBalance: "debit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true, status: "active", hasPostings: false },
  { code: "4300", name: "Retur Penjualan", accountType: "revenue", normalBalance: "debit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true, status: "active", hasPostings: false },
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

// unappliedCredits is 5,550,000 — CN-2026-001 below, still unapplied. Non-zero on purpose: a demo
// where every credit note was already applied would make the fourth KPI tile permanently zero and
// the one figure it exists to surface (a credit note's NORMAL unapplied state) unreachable.
const AR_RECONCILE: ReconcileVerdict<ArPosition> = {
  position: {
    openInvoices: "185000000.0000", paymentsOnAccount: "0.0000", unappliedCredits: "5550000.0000",
    netReceivable: "179450000.0000",
  },
  problems: [],
  clean: true,
};

// ⚠ DELIBERATELY BROKEN. Without one failing tie-out, the "does not tie" badge and the problem
// table below it are unreachable in a browser — and they are the reason this console exists.
//
// unappliedCredits is 5,450,000 — VCN-2026-001 below, still unapplied — same reasoning as the AR
// side's non-zero unappliedCredits: a demo where every vendor credit was already applied would make
// the fourth KPI tile permanently zero. netPayable is openBills - paymentsOnAccount - unappliedCredits
// (94,000,000 - 0 - 5,450,000), matching the identity `finance_ap_position()` now computes.
const AP_RECONCILE: ReconcileVerdict<ApPosition> = {
  position: {
    openBills: "94000000.0000", paymentsOnAccount: "0.0000",
    unappliedCredits: "5450000.0000", netPayable: "88550000.0000",
  },
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

// AR credit notes. One unapplied (drives the "apply" cell), one already applied (drives the
// disabled/settled state) — a store where every note was already settled would make the apply
// action, and the reason it exists, unreachable in a browser.
const AR_CREDIT_NOTES = [
  {
    id: "cn-1", creditNoteNo: "CN-2026-001", creditNoteDate: "2026-03-05",
    customerCode: "C-002", customerName: "CV Nusantara Kopi",
    subtotal: "5000000.0000", taxTotal: "550000.0000", total: "5550000.0000",
    amountApplied: "0.0000", unapplied: "5550000.0000",
    reasonCode: "return", reason: "Barang dikembalikan — kualitas tidak sesuai pesanan",
    status: "issued", originalInvoiceId: "inv-2", originalInvoiceNo: "INV-2026-002",
  },
  {
    id: "cn-2", creditNoteNo: "CN-2026-002", creditNoteDate: "2026-02-20",
    customerCode: "C-001", customerName: "PT Bali Beach Resort",
    subtotal: "2000000.0000", taxTotal: "0.0000", total: "2000000.0000",
    amountApplied: "2000000.0000", unapplied: "0.0000",
    reasonCode: "discount", reason: "Diskon loyalitas disepakati setelah faktur terbit",
    status: "applied", originalInvoiceId: "inv-1", originalInvoiceNo: "INV-2026-001",
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

// Backs BOTH `GET /finance/fiscal-years` and `closeFiscalYearDemo` below. `periodCount`/`openPeriods`
// are DERIVED from `PERIODS` above rather than hand-counted, so they cannot drift from the periods
// table the close page renders right beside this one. That derivation also means this year is
// genuinely NOT closeable in the demo estate (Apr–Dec are still OPEN) — deliberately, so the
// close-disabled state (openPeriods > 0) is reachable in a browser rather than only in the live
// company the real endpoint was verified against.
const FISCAL_YEARS = [
  {
    id: "demo-fy-2026", code: `FY${YEAR}`,
    startDate: PERIODS[0].startDate, endDate: PERIODS[PERIODS.length - 1].endDate,
    status: "open",
    periodCount: PERIODS.length,
    openPeriods: PERIODS.filter((p) => p.state === "OPEN").length,
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

// AP vendor credits (F5b). Same "one unapplied, one settled" shape as AR_CREDIT_NOTES, plus a THIRD
// state neither AR fixture needs to model: a credit that unwound withholding and is still waiting on
// its bukti potong amendment. Without vc-1 the "requires amendment" badge, the bupot chase list and
// its clear action would all be unreachable in a browser.
const AP_VENDOR_CREDITS = [
  {
    // Tied to bill-1 (PT Kreatif Media Nusantara) so the apply cell has a real candidate bill of the
    // SAME vendor to offer, and withheld PPh 23 (2% of the 5,000,000 base) so this is the one that
    // requires a bukti potong amendment — not yet filed, on purpose (see AP_BUPOT_EXCEPTIONS below).
    id: "vc-1", creditNo: "VCN-2026-001", creditDate: "2026-03-25",
    vendorId: "vend-1", vendorCode: "V-001", vendorName: "PT Kreatif Media Nusantara",
    subtotal: "5000000.0000", taxTotal: "550000.0000", total: "5550000.0000",
    withholdingCode: "PPH23", withholdingAmount: "100000.0000",
    amountPayable: "5450000.0000", amountApplied: "0.0000", unapplied: "5450000.0000",
    reasonCode: "service_failure",
    reason: "Jasa tidak selesai sesuai kontrak — sebagian pekerjaan tidak dikerjakan",
    status: "issued", notaReturNo: "NR-2026-014",
    requiresBupotAmendment: true, bupotAmendmentRef: null, bupotAmendedAt: null,
    originalBillId: "bill-1", originalBillNo: "BILL-8841",
  },
  {
    // No withholding at all (CV Sinar Percetakan is not PKP — see AP_VENDORS), already applied in
    // full, no original bill named. Drives the settled/disabled state and shows a vendor credit that
    // never touches the bupot surface, which is the common case, not the one above.
    id: "vc-2", creditNo: "VCN-2026-002", creditDate: "2026-02-14",
    vendorId: "vend-2", vendorCode: "V-002", vendorName: "CV Sinar Percetakan",
    subtotal: "1500000.0000", taxTotal: "0.0000", total: "1500000.0000",
    withholdingCode: null, withholdingAmount: "0.0000",
    amountPayable: "1500000.0000", amountApplied: "1500000.0000", unapplied: "0.0000",
    reasonCode: "overbilling", reason: "Kelebihan tagih pada cetakan brosur",
    status: "applied", notaReturNo: null,
    requiresBupotAmendment: false, bupotAmendmentRef: null, bupotAmendedAt: null,
    originalBillId: null, originalBillNo: null,
  },
];

// The chase list `finance_ap_bupot_amendment_exceptions()` returns — every issued/applied vendor
// credit with `requires_bupot_amendment` and no `bupot_amended_at` yet. Only vc-1 qualifies; the
// detail sentence mirrors the SQL function's own concatenation verbatim (see migration
// 202608272000) so a demo refusal or explanation is never one the live text disagrees with.
const AP_BUPOT_EXCEPTIONS = [
  {
    creditNo: "VCN-2026-001", creditDate: "2026-03-25",
    vendorCode: "V-001", vendorName: "PT Kreatif Media Nusantara", npwp: "01.234.567.8-901.000",
    withholdingCode: "PPH23", withholdingReversed: "100000.0000",
    originalBillNo: "BILL-8841",
    detail: "vendor credit VCN-2026-001 reversed 100000.0000 of PPH23 originally withheld on bill "
      + "BILL-8841 -- the bukti potong issued to this vendor now overstates what was withheld and "
      + "needs an amended e-Bupot",
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
  if (tail === "fiscal-years") return ok(FISCAL_YEARS);
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
  if (tail === "ap/vendor-credits") {
    const status = _params.get("status");
    return ok(status ? AP_VENDOR_CREDITS.filter((c) => c.status === status) : AP_VENDOR_CREDITS);
  }
  if (tail === "ap/bupot-exceptions") return ok(AP_BUPOT_EXCEPTIONS);
  if (tail === "ar/customers") return ok(AR_CUSTOMERS);
  if (tail === "ar/open-invoices") return ok(AR_OPEN_INVOICES);
  if (tail === "ar/credit-notes") {
    const status = _params.get("status");
    return ok(status ? AR_CREDIT_NOTES.filter((n) => n.status === status) : AR_CREDIT_NOTES);
  }
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

  // Mirrors the engine's own gate, per the coordinator's note: a year with any period still OPEN is
  // not closeable. `CloseFiscalYearAction` already disables the control client-side before a
  // confirmation can even be typed — this is the server-side backstop for anyone calling the demo
  // route directly, same posture as every other gate in this file.
  if (year.openPeriods > 0) {
    return badRequest(
      `${year.code} has ${year.openPeriods} period(s) still open — a fiscal year cannot be closed `
      + `while any period inside it is open.`,
    );
  }

  // Same default the engine itself uses — 3300 RETAINED earnings, never 3200 (current-year
  // result). `ACCOUNTS` above has no 3300, so the default call refuses honestly rather than
  // inventing an account this demo's chart was never given; passing an existing code (e.g. 3100)
  // reaches the success path — once `openPeriods` above is not the blocker.
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

/**
 * Reopen a soft-locked period — the counterpart to `closePeriodDemo`. Mirrors the live handler's
 * check ORDER exactly: reason is checked before the period even loads, matching `finance.controller
 * .ts::reopenPeriod`.
 */
function reopenPeriodDemo(periodId: string, b: { confirm?: string; reason?: string }): DemoResult {
  const reason = b.reason?.trim();
  if (!reason) return badRequest("reason is required — reopening a closed period is an exception, and an exception with no recorded reason is indistinguishable from a mistake");

  const period = PERIODS.find((x) => x.id === periodId);
  if (!period) return notFound("no such fiscal period in this company");
  const refused = requireConfirmation(b.confirm, period.name, "period");
  if (refused) return refused;

  if (period.state === "OPEN") return badRequest(`${period.name} is already open`);
  if (period.state === "HARD_LOCK") {
    return badRequest(
      `${period.name} is HARD-LOCKED and cannot be reopened. That is what a hard lock means — `
      + `a correction belongs in a later period, as an ordinary entry that shows on the face of the books.`,
    );
  }
  return { status: 200, json: { ok: true, period: period.name, state: "OPEN" } };
}

// ── The second group: plain writes, no confirmation gate ───────────────────────────────────────
// None of these echoes a typed string back — see the header comment. Each still mirrors a real
// validation shape (duplicate codes, range checks, unknown ids) rather than answering with a blind
// `{ok:true}`. And — same caveat as the five terminal writes above — this store is NOT stateful: an
// id minted here (a new run, a new instrument, a new customer) will not appear in the static GET
// lists afterward. That is a real limitation of a fixture store, named rather than hidden by faking
// persistence this file does not have.

function createConsolidationRunDemo(b: { asOf?: string; label?: string }): DemoResult {
  if (!b.asOf) return badRequest("asOf is required");
  return { status: 201, json: { id: `demo-consol-run-${Date.now()}`, asOf: b.asOf } };
}

function eliminateIntercompanyDemo(runId: string): DemoResult {
  const run = CONSOLIDATION_RUNS.find((r) => r.id === runId);
  if (!run) return notFound("no such consolidation run in this company");
  return { status: 200, json: { ok: true, entryCount: run.entryCount } };
}

const INSTRUMENT_KINDS = ["loan_payable", "loan_receivable", "bond_issued", "lease"];

function createInstrumentDemo(b: {
  code?: string; name?: string; kind?: string; startDate?: string; maturityDate?: string;
  principal?: number; nominalRate?: number | null;
}): DemoResult {
  const code = b.code?.trim();
  const name = b.name?.trim();
  if (!code) return badRequest("code is required");
  if (!name) return badRequest("name is required");
  if (!b.kind || !INSTRUMENT_KINDS.includes(b.kind)) {
    return badRequest(`kind must be one of ${INSTRUMENT_KINDS.join(", ")}`);
  }
  if (!b.startDate) return badRequest("startDate is required");
  if (b.maturityDate && b.maturityDate <= b.startDate) return badRequest("maturityDate must be after startDate");
  const principal = Number(b.principal);
  if (!Number.isFinite(principal) || principal <= 0) return badRequest("principal must be greater than zero");
  const nominal = b.nominalRate === undefined || b.nominalRate === null ? null : Number(b.nominalRate);
  if (nominal !== null && (!Number.isFinite(nominal) || nominal < 0 || nominal > 100)) {
    return badRequest("nominalRate is a percent (11.5 for 11.5%), between 0 and 100");
  }
  if (INSTRUMENTS.some((i) => i.code === code)) return badRequest(`an instrument with code ${code} already exists`);
  return { status: 201, json: { id: `demo-instrument-${Date.now()}`, code, kind: b.kind } };
}

function postInstrumentAccrualDemo(instrumentId: string, b: { seq?: number }): DemoResult {
  const seq = Number(b.seq);
  if (!Number.isInteger(seq) || seq < 1) {
    return badRequest("seq is required — the 1-based instalment number from the instrument's schedule");
  }
  const instrument = INSTRUMENTS.find((i) => i.id === instrumentId);
  if (!instrument) return notFound("no such instrument in this company");
  // INSTRUMENT_SCHEDULE is the same 6-row fixture for every instrument (the GET route answers every
  // id with it) — so its length is the honest bound to check against here too.
  const len = INSTRUMENT_SCHEDULE.length;
  if (seq > len) return badRequest(`this instrument's schedule has ${len} instalment(s); seq ${seq} does not exist`);
  return { status: 201, json: { journalId: `demo-j-accrual-${instrumentId}-${seq}`, seq } };
}

function createArCustomerDemo(b: { code?: string; name?: string; paymentTermsDays?: number }): DemoResult {
  const code = b.code?.trim();
  const name = b.name?.trim();
  if (!code) return badRequest("code is required");
  if (!name) return badRequest("name is required");
  const terms = b.paymentTermsDays ?? 30;
  if (!Number.isInteger(terms) || terms < 0) return badRequest("paymentTermsDays must be a whole number of days, zero or more");
  if (AR_CUSTOMERS.some((c) => c.code === code)) return badRequest(`a customer with code ${code} already exists`);
  return { status: 201, json: { id: `demo-customer-${Date.now()}`, code, name } };
}

function createApVendorDemo(b: {
  code?: string; name?: string; defaultWithholdingRate?: number | null;
}): DemoResult {
  const code = b.code?.trim();
  const name = b.name?.trim();
  if (!code) return badRequest("code is required");
  if (!name) return badRequest("name is required");
  const rate = b.defaultWithholdingRate === undefined || b.defaultWithholdingRate === null
    ? null : Number(b.defaultWithholdingRate);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1)) {
    return badRequest("defaultWithholdingRate is a rate between 0 and 1 (0.02 for PPh 23 at 2%), not a percentage");
  }
  if (AP_VENDORS.some((v) => v.code === code)) return badRequest(`a vendor with code ${code} already exists`);
  return { status: 201, json: { id: `demo-vendor-${Date.now()}`, code, name } };
}

// ── AR credit notes and write-offs (F4b) ────────────────────────────────────────────────────────
const CREDIT_NOTE_REASONS = ["return", "overbilling", "discount", "service_failure", "price_correction", "other"];
const WRITE_OFF_REASONS = ["uncollectible", "customer_insolvent", "disputed_abandoned", "below_recovery_cost", "statute_barred", "other"];

interface CreditNoteLineBody {
  description?: string; amount?: number | string; creditAccountCode?: string; taxRate?: number | string | null;
}

/** Mirrors `finance.controller.ts::createArCreditNote` — same check order, same VAT formula (12% of
 *  11/12 of the base), so a demo refusal reads the way the live one does. */
function createArCreditNoteDemo(b: {
  creditNoteDate?: string; creditNoteNo?: string; customerId?: string;
  reasonCode?: string; reason?: string; lines?: CreditNoteLineBody[];
}): DemoResult {
  if (!b.creditNoteDate) return badRequest("creditNoteDate is required");
  const creditNoteNo = b.creditNoteNo?.trim();
  if (!creditNoteNo) return badRequest("creditNoteNo is required");
  if (!b.customerId) return badRequest("customerId is required");
  if (!b.reasonCode || !CREDIT_NOTE_REASONS.includes(b.reasonCode)) {
    return badRequest(`reasonCode must be one of ${CREDIT_NOTE_REASONS.join(", ")}`);
  }
  if (!b.reason?.trim()) {
    return badRequest("reason is required — a credit with no recorded cause is indistinguishable from a concealed write-off");
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0) {
    return badRequest("at least one line is required — a credit note with no lines cannot be issued");
  }

  let subtotal = 0;
  let taxTotal = 0;
  for (let i = 0; i < b.lines.length; i++) {
    const l = b.lines[i];
    const amount = Number(l?.amount);
    if (!l?.description?.trim()) return badRequest(`line ${i + 1}: description is required`);
    if (!l?.creditAccountCode) return badRequest(`line ${i + 1}: creditAccountCode is required`);
    if (!Number.isFinite(amount) || amount <= 0) return badRequest(`line ${i + 1}: amount must be greater than zero`);
    const rate = l?.taxRate === undefined || l.taxRate === null ? null : Number(l.taxRate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
      return badRequest(`line ${i + 1}: taxRate must be between 0 and 100`);
    }
    if (!ACCOUNTS.some((a) => a.code === l.creditAccountCode)) return badRequest(`unknown account ${l.creditAccountCode}`);
    subtotal += amount;
    taxTotal += rate === null ? 0 : Math.round(amount * (11 / 12) * (rate / 100));
  }
  if (subtotal + taxTotal <= 0) return badRequest("credit note total must be greater than zero");
  if (AR_CREDIT_NOTES.some((n) => n.creditNoteNo === creditNoteNo)) {
    return badRequest(`a credit note numbered ${creditNoteNo} already exists`);
  }

  return {
    status: 201,
    json: { id: `demo-cn-${Date.now()}`, creditNoteNo, subtotal, taxTotal, total: subtotal + taxTotal },
  };
}

function applyArCreditNoteDemo(noteId: string, b: { invoiceId?: string; amount?: number }): DemoResult {
  if (!b.invoiceId) return badRequest("invoiceId is required");
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return badRequest("amount must be greater than zero");
  const note = AR_CREDIT_NOTES.find((n) => n.id === noteId);
  if (!note) return notFound("no such credit note in this company");
  return { status: 200, json: { applicationId: `demo-cn-apply-${Date.now()}`, amount } };
}

/** Mirrors `finance.controller.ts::writeOffArInvoice` — confirmation-gated on the INVOICE NUMBER,
 *  same as reopening a period is gated on the period name. */
function writeOffArInvoiceDemo(invoiceId: string, b: {
  amount?: number; writeOffDate?: string; reasonCode?: string; reason?: string; confirm?: string;
}): DemoResult {
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return badRequest("amount must be greater than zero");
  if (!b.writeOffDate) return badRequest("writeOffDate is required");
  if (!b.reasonCode || !WRITE_OFF_REASONS.includes(b.reasonCode)) {
    return badRequest(`reasonCode must be one of ${WRITE_OFF_REASONS.join(", ")}`);
  }
  if (!b.reason?.trim()) {
    return badRequest("reason is required — a write-off with no recorded reason is indistinguishable from a mistake");
  }
  const invoice = AR_OPEN_INVOICES.find((i) => i.id === invoiceId);
  if (!invoice) return notFound("no such invoice in this company");
  const refused = requireConfirmation(b.confirm, invoice.invoiceNo, "invoice number");
  if (refused) return refused;

  return { status: 201, json: { writeOffId: `demo-wo-${Date.now()}`, invoiceNo: invoice.invoiceNo, amount } };
}

// ── AP vendor credits and write-offs (F5b) ──────────────────────────────────────────────────────
// Mirrors `finance.controller.ts::createApVendorCredit` / `applyApVendorCredit` /
// `recordBupotAmendment` / `writeOffApBill` — same check order as the live handlers, so a demo
// refusal reads the way the real one does. `CREDIT_NOTE_REASONS` above is reused rather than
// duplicated: the AP endpoint validates against the exact same six-value enum as the AR one.
const AP_WRITE_OFF_REASONS = ["vendor_dissolved", "statute_barred", "disputed_abandoned", "unclaimed", "other"];

function createApVendorCreditDemo(b: {
  creditDate?: string; creditNo?: string; vendorId?: string;
  reasonCode?: string; reason?: string; lines?: CreditNoteLineBody[];
  originalBillId?: string; withholdingAmount?: number | string; withholdingCode?: string;
  withholdingAccountCode?: string;
}): DemoResult {
  if (!b.creditDate) return badRequest("creditDate is required");
  const creditNo = b.creditNo?.trim();
  if (!creditNo) return badRequest("creditNo is required");
  if (!b.vendorId) return badRequest("vendorId is required");
  if (!b.reasonCode || !CREDIT_NOTE_REASONS.includes(b.reasonCode)) {
    return badRequest(`reasonCode must be one of ${CREDIT_NOTE_REASONS.join(", ")}`);
  }
  if (!b.reason?.trim()) {
    return badRequest("reason is required — a credit with no recorded cause is indistinguishable from a concealed write-off");
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0) {
    return badRequest("at least one line is required — a vendor credit with no lines cannot be issued");
  }

  let subtotal = 0;
  let taxTotal = 0;
  for (let i = 0; i < b.lines.length; i++) {
    const l = b.lines[i];
    const amount = Number(l?.amount);
    if (!l?.description?.trim()) return badRequest(`line ${i + 1}: description is required`);
    if (!l?.creditAccountCode) return badRequest(`line ${i + 1}: creditAccountCode is required`);
    if (!Number.isFinite(amount) || amount <= 0) return badRequest(`line ${i + 1}: amount must be greater than zero`);
    const rate = l?.taxRate === undefined || l.taxRate === null ? null : Number(l.taxRate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
      return badRequest(`line ${i + 1}: taxRate must be between 0 and 100`);
    }
    if (!ACCOUNTS.some((a) => a.code === l.creditAccountCode)) return badRequest(`unknown account ${l.creditAccountCode}`);
    subtotal += amount;
    taxTotal += rate === null ? 0 : Math.round(amount * (11 / 12) * (rate / 100));
  }
  const total = subtotal + taxTotal;
  if (total <= 0) return badRequest("vendor credit total must be greater than zero");

  const whtAmount = Number(b.withholdingAmount ?? 0);
  if (!Number.isFinite(whtAmount) || whtAmount < 0) return badRequest("withholdingAmount must be zero or more");
  if (whtAmount > total) return badRequest("withholdingAmount cannot exceed the credit total");
  if (whtAmount > 0 && !b.withholdingCode) {
    return badRequest("withholdingCode is required when withholdingAmount is greater than zero");
  }

  if (AP_VENDOR_CREDITS.some((c) => c.creditNo === creditNo)) {
    return badRequest(`a vendor credit numbered ${creditNo} already exists`);
  }

  // Resolve which withholding liability to reverse into — mirrors the live handler's preference for
  // `originalBillId` (so the reversal lands where the bill put it) over a bare `withholdingAccountCode`.
  if (whtAmount > 0) {
    const bill = b.originalBillId
      ? [...AP_OPEN_BILLS, ...AP_DRAFT_BILLS].find((x) => x.id === b.originalBillId)
      : undefined;
    if (b.originalBillId && !bill) return notFound("no such bill in this company");
    if (!bill) {
      if (b.withholdingAccountCode) {
        if (!ACCOUNTS.some((a) => a.code === b.withholdingAccountCode)) {
          return badRequest(`unknown withholding account ${b.withholdingAccountCode}`);
        }
      } else {
        return badRequest(
          "cannot tell which withholding liability to unwind — name the originalBillId (preferred, so the reversal "
          + "lands where the bill put it) or pass withholdingAccountCode",
        );
      }
    }
  }

  return {
    status: 201,
    json: {
      id: `demo-vc-${Date.now()}`, creditNo, subtotal, taxTotal, total,
      amountPayable: total - whtAmount, requiresBupotAmendment: whtAmount > 0,
    },
  };
}

function applyApVendorCreditDemo(creditId: string, b: { billId?: string; amount?: number }): DemoResult {
  if (!b.billId) return badRequest("billId is required");
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return badRequest("amount must be greater than zero");
  const credit = AP_VENDOR_CREDITS.find((c) => c.id === creditId);
  if (!credit) return notFound("no such vendor credit in this company");
  return { status: 200, json: { applicationId: `demo-vc-apply-${Date.now()}`, amount } };
}

/** Mirrors `finance.controller.ts::recordBupotAmendment` — `amendmentRef` required, and the credit
 *  must both exist AND still need the amendment (a already-cleared or never-flagged credit 404s,
 *  matching the live handler's `WHERE ... AND requires_bupot_amendment` returning no row). */
function recordBupotAmendmentDemo(creditId: string, b: { amendmentRef?: string }): DemoResult {
  const ref = b.amendmentRef?.trim();
  if (!ref) {
    return badRequest(
      "amendmentRef is required — the reference of the amended bukti potong. Marking it resolved with no "
      + "reference cannot be told apart from nobody having filed it.",
    );
  }
  const credit = AP_VENDOR_CREDITS.find((c) => c.id === creditId && c.requiresBupotAmendment);
  if (!credit) return notFound("no such vendor credit in this company, or it needs no bukti potong amendment");
  return { status: 200, json: { ok: true, creditNo: credit.creditNo, amendmentRef: ref } };
}

/** Mirrors `finance.controller.ts::writeOffApBill` — confirmation-gated on the BILL NUMBER, and any
 *  bill status is eligible (the live query carries no status filter), so this checks both the open
 *  and the draft-approval fixtures. */
function writeOffApBillDemo(billId: string, b: {
  amount?: number; writeOffDate?: string; reasonCode?: string; reason?: string; confirm?: string;
}): DemoResult {
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return badRequest("amount must be greater than zero");
  if (!b.writeOffDate) return badRequest("writeOffDate is required");
  if (!b.reasonCode || !AP_WRITE_OFF_REASONS.includes(b.reasonCode)) {
    return badRequest(`reasonCode must be one of ${AP_WRITE_OFF_REASONS.join(", ")}`);
  }
  if (!b.reason?.trim()) {
    return badRequest("reason is required — a write-off with no recorded reason is indistinguishable from a mistake");
  }
  const bill = [...AP_OPEN_BILLS, ...AP_DRAFT_BILLS].find((x) => x.id === billId);
  if (!bill) return notFound("no such bill in this company");
  const refused = requireConfirmation(b.confirm, bill.billNo, "bill number");
  if (refused) return refused;

  return { status: 201, json: { writeOffId: `demo-apwo-${Date.now()}`, billNo: bill.billNo, amount } };
}

/** Dispatches every gated and plain write this store answers; anything else still falls through
 *  unanswered (`null`), for exactly the reason the top-of-file comment gives. */
function financeWrite(tail: string, body: string | undefined): DemoResult | null {
  const b = body ? JSON.parse(body) : {};

  const signOff = /^periods\/([^/]+)\/sign-off$/.exec(tail);
  if (signOff) return signOffDemo(signOff[1], b);

  const close = /^periods\/([^/]+)\/close$/.exec(tail);
  if (close) return closePeriodDemo(close[1], b);

  const reopen = /^periods\/([^/]+)\/reopen$/.exec(tail);
  if (reopen) return reopenPeriodDemo(reopen[1], b);

  const commit = /^cutovers\/([^/]+)\/commit$/.exec(tail);
  if (commit) return commitCutoverDemo(commit[1], b);

  const fyClose = /^fiscal-years\/([^/]+)\/close$/.exec(tail);
  if (fyClose) return closeFiscalYearDemo(fyClose[1], b);

  const lease = /^instruments\/([^/]+)\/recognise-lease$/.exec(tail);
  if (lease) return recogniseLeaseDemo(lease[1], b);

  if (tail === "consolidation/runs") return createConsolidationRunDemo(b);
  const eliminate = /^consolidation\/runs\/([^/]+)\/eliminate$/.exec(tail);
  if (eliminate) return eliminateIntercompanyDemo(eliminate[1]);

  if (tail === "instruments") return createInstrumentDemo(b);
  const accrual = /^instruments\/([^/]+)\/accrual$/.exec(tail);
  if (accrual) return postInstrumentAccrualDemo(accrual[1], b);

  if (tail === "ar/customers") return createArCustomerDemo(b);
  if (tail === "ap/vendors") return createApVendorDemo(b);

  if (tail === "ar/credit-notes") return createArCreditNoteDemo(b);
  const apply = /^ar\/credit-notes\/([^/]+)\/apply$/.exec(tail);
  if (apply) return applyArCreditNoteDemo(apply[1], b);
  const writeOff = /^ar\/invoices\/([^/]+)\/write-off$/.exec(tail);
  if (writeOff) return writeOffArInvoiceDemo(writeOff[1], b);

  if (tail === "ap/vendor-credits") return createApVendorCreditDemo(b);
  const apApply = /^ap\/vendor-credits\/([^/]+)\/apply$/.exec(tail);
  if (apApply) return applyApVendorCreditDemo(apApply[1], b);
  const bupotAmended = /^ap\/vendor-credits\/([^/]+)\/bupot-amended$/.exec(tail);
  if (bupotAmended) return recordBupotAmendmentDemo(bupotAmended[1], b);
  const apWriteOff = /^ap\/bills\/([^/]+)\/write-off$/.exec(tail);
  if (apWriteOff) return writeOffApBillDemo(apWriteOff[1], b);

  return null;
}
