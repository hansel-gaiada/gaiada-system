import "server-only";
// TEMP DEMO MODE: stateful in-memory store for Finance > Payables > Freelancers (DW-10f-4b, BFF §61.7, §61.8, as built §61.18), in the
// pattern of `demoNotices.ts`. Routed from `demoFixtures.getDemoResponse` BEFORE `financeDemo`, so no later `/api/:t/finance/*` catch-all can
// answer a freelancer path with a generic `{ok:true}`. Module-level state lasts for the dev-server process; `resetFreelancersDemo()` is for tests.
//
// WHAT IT MODELS (the server's order of checks and its refusal reasons, so a page is only as honest as the fixture behind it):
//   - reads and writes need finance access (`demo-hansel`, as `financeDemo`'s `FINANCE_READERS`): anyone else is 403.
//   - a rate: `rate_invalid`, `date_invalid`, `expense_account_invalid`, `person_not_found`, `freelancer_on_payroll`, `rate_overlap`; an open rate
//     that started before the new start is closed the day before (`closedRate`); `rate_used` guards End and Withdraw of a rate that priced a bill.
//   - the vendor link (`PATCH finance/ap/vendors/:id/person`): `user_id_required`, `vendor_not_found`, `person_not_found`, `person_has_vendor`.
//   - the preview: per person with a rate or a vendor who has unbilled time and no bill for the period; lines per (project, rate), withholding from the
//     vendor's code, `NO_WITHHOLDING` / `EARLIER_UNBILLED` warnings, `NO_VENDOR` / `NO_RATE` blockers.
//   - drafting (`nothing_to_bill`, `bill_blocked` with every blocker, a replay answers the live draft with `deduped: true`) and discarding (drafts only:
//     `bill_not_draft`, `freelancer_bill_not_found`), which hands the hours back to the preview.
//
// WHAT IT DOES NOT: it has no time entries. Each person has a fixed pile of unbilled minutes per project, shown in WHATEVER period is asked for, priced at
// the rate in force on the period's last day (the server prices each entry at the rate of its own date). It does not model the second factor (the
// server's `vendor_master` is high assurance; there is no demo second factor to be refused). The money is integer rupiah, rounded once per line.
import { todayIsoInDisplayZone } from "./format";
import { financeDemo } from "./demoFinance";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const err = (status: number, reason: string, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, reason, ...extra } });

/** `financeDemo`'s `FINANCE_READERS`: the one demo identity with finance access. */
const FINANCE_USERS = new Set(["demo-hansel"]);

// ── People: the demo company's members (demoFixtures MEMBERS), and the one on payroll ──────────────────────────
const PEOPLE: Record<string, { name: string; email: string }> = {
  "demo-hansel": { name: "Clement Hansel", email: "hansel@gaiada.com" },
  "gede-ic": { name: "Gede Kusuma", email: "gede@gaiada.com" },
  "seo-staff": { name: "Nyoman Ari", email: "seo-staff@gaiada.com" },
  "u-pm": { name: "Dewi Santoso", email: "dewi@gaiada.com" },
  "u-dev": { name: "Made Putra", email: "made@gaiada.com" },
  "u-seo": { name: "Luh Ayu", email: "seo-specialist@gaiada.com" },
  "u-social": { name: "Komang Lestari", email: "social@gaiada.com" },
  "u-creative": { name: "Putu Rani", email: "creative@gaiada.com" },
  "u-hr": { name: "Ayu Wardani", email: "hr-staff@gaiada.com" },
  "u-finance-staff": { name: "Bayu Prasetyo", email: "finance-staff@gaiada.com" },
  "u-it": { name: "Dika Pratama", email: "it-admin@gaiada.com" },
};
/** A person with a compensation in force: payroll pays them, so a freelancer rate is refused (409 `freelancer_on_payroll`). */
const ON_PAYROLL = new Set(["u-hr"]);

// ── State ───────────────────────────────────────────────────────────────────────────────────────────────────────
interface DemoRate {
  id: string; userId: string; hourlyRate: number; currency: string; expenseAccountCode: string;
  validFrom: string; validTo: string | null; note: string | null; used: boolean;
}
interface DemoBill {
  billId: string; billNo: string; userId: string; vendorId: string; periodStart: string; periodEnd: string; minutes: number;
  subtotal: number; withholdingAmount: number; amountPayable: number; currency: string; status: string; createdAt: string;
}

const CURRENCY = "IDR";
/** Per person, the unbilled minutes by project: the hours the preview offers for any period. */
const UNBILLED: Record<string, { projectId: string; project: string; minutes: number }[]> = {
  "u-dev": [{ projectId: "p-web-1", project: "Website rebuild", minutes: 1260 }, { projectId: "p-web-2", project: "Internal tooling", minutes: 330 }],
  "gede-ic": [{ projectId: "p-portal", project: "Client portal", minutes: 2400 }],
  "u-creative": [{ projectId: "p-brand", project: "Brand refresh", minutes: 600 }],
  "u-social": [{ projectId: "p-social", project: "Social calendar", minutes: 480 }],
};
/** Hours dated before the period that nobody billed (`EARLIER_UNBILLED`). Only Made has some. */
const EARLIER: Record<string, { count: number; minutes: number; days: number }> = { "u-dev": { count: 3, minutes: 180, days: 20 } };

/** The vendors this store adds to `financeDemo`'s two: a free one, so "Link a vendor" has a candidate. */
const EXTRA_VENDORS = [
  {
    id: "vend-3", code: "V-003", name: "Studio Lepas Bali", npwp: null, isPkp: false,
    defaultWithholdingCode: "PPH21", defaultWithholdingRate: "0.025000", paymentTermsDays: 14,
  },
];
const SEED_LINKS: Record<string, string> = { "vend-1": "u-dev", "vend-2": "gede-ic" };

let seq = 0;
let rates: DemoRate[] = [];
let bills: DemoBill[] = [];
let links: Record<string, string> = {};

const rid = () => `00000000-0000-4000-8000-${String(700000 + ++seq).padStart(12, "0")}`;
const today = () => todayIsoInDisplayZone();
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function seed(): void {
  seq = 0;
  links = { ...SEED_LINKS };
  rates = [
    { id: rid(), userId: "u-dev", hourlyRate: 125000, currency: CURRENCY, expenseAccountCode: "6100", validFrom: "2025-09-01", validTo: "2026-03-31", note: "First rate", used: true },
    { id: rid(), userId: "u-dev", hourlyRate: 150000, currency: CURRENCY, expenseAccountCode: "6100", validFrom: "2026-04-01", validTo: null, note: null, used: false },
    { id: rid(), userId: "gede-ic", hourlyRate: 120000, currency: CURRENCY, expenseAccountCode: "6100", validFrom: "2026-01-01", validTo: null, note: null, used: false },
    { id: rid(), userId: "u-creative", hourlyRate: 100000, currency: CURRENCY, expenseAccountCode: "6200", validFrom: "2026-01-01", validTo: null, note: null, used: false },
  ];
  bills = [
    // A draft for an earlier month (Made, vendor V-001, PPh 23 at 2%): the page opens with a drafted bill to approve or discard.
    {
      billId: rid(), billNo: "GA/FB/2026/0001", userId: "u-dev", vendorId: "vend-1", periodStart: "2026-07-01", periodEnd: "2026-07-31",
      minutes: 1800, subtotal: 4500000, withholdingAmount: 90000, amountPayable: 4410000, currency: CURRENCY, status: "draft", createdAt: "2026-08-02T03:00:00.000Z",
    },
  ];
}
seed();
export function resetFreelancersDemo(): void { seed(); }

// ── Reads over the finance fixtures ─────────────────────────────────────────────────────────────────────────────
interface VendorRow {
  id: string; code: string; name: string; npwp: string | null; isPkp: boolean | null;
  defaultWithholdingCode: string | null; defaultWithholdingRate: string | null; paymentTermsDays: number; userId?: string | null;
}
const baseVendors = (): VendorRow[] => {
  const r = financeDemo("GET", "/api/demo/finance/ap/vendors", new URLSearchParams(), "demo-hansel");
  return (r?.json as VendorRow[] | undefined) ?? [];
};
/** The vendor list as `GET finance/ap/vendors` answers it: the fixtures' vendors plus this store's, each with the person it names. */
export function vendorRowsWithLinks(): VendorRow[] {
  return [...baseVendors(), ...EXTRA_VENDORS].map((v) => ({ ...v, userId: links[v.id] ?? null }));
}
const vendorFor = (userId: string): VendorRow | null => vendorRowsWithLinks().find((v) => v.userId === userId) ?? null;
const vendorById = (id: string): VendorRow | null => vendorRowsWithLinks().find((v) => v.id === id) ?? null;

function expenseAccount(code: string): boolean {
  const rows = (financeDemo("GET", "/api/demo/finance/accounts", new URLSearchParams(), "demo-hansel")?.json ?? []) as
    { code: string; accountType: string; isPostable: boolean; isControl: boolean; allowManualPosting: boolean; status: string }[];
  return rows.some((a) => a.code === code && a.accountType === "expense" && a.isPostable && !a.isControl && a.allowManualPosting && a.status === "active");
}

const personOf = (id: string) => ({ id, name: PEOPLE[id].name, email: PEOPLE[id].email });
const vendorView = (v: VendorRow | null) => (v ? { id: v.id, code: v.code, name: v.name, withholdingCode: v.defaultWithholdingCode } : null);
const WITHHOLDING_RATE: Record<string, number> = { PPH23: 0.02, PPH21: 0.025, PPH42: 0.1 };

const isIso = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const periodProblem = (s: unknown, e: unknown): string | null => {
  if (!isIso(s) || !isIso(e)) return "periodStart and periodEnd must be dates (YYYY-MM-DD)";
  if (e < s) return "periodEnd is before periodStart";
  if ((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86_400_000 + 1 > 366) return "a period is at most 366 days";
  return null;
};

const rateView = (r: DemoRate) => ({ ...r });
const inForce = (r: DemoRate, day: string) => r.validFrom <= day && (r.validTo === null || day <= r.validTo);
const overlaps = (a: { validFrom: string; validTo: string | null }, b: { validFrom: string; validTo: string | null }) =>
  a.validFrom <= (b.validTo ?? "9999-12-31") && b.validFrom <= (a.validTo ?? "9999-12-31");

// ── Rates ───────────────────────────────────────────────────────────────────────────────────────────────────────
function listFreelancers(): DemoResult {
  const ids = new Set<string>([...rates.map((r) => r.userId), ...Object.values(links)]);
  const t = today();
  const out = [...ids].filter((id) => PEOPLE[id]).map((id) => {
    const mine = rates.filter((r) => r.userId === id).sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1));
    const cur = mine.find((r) => inForce(r, t)) ?? null;
    return { user: personOf(id), vendor: vendorView(vendorFor(id)), currentRate: cur ? rateView(cur) : null, rates: mine.map(rateView), onPayroll: ON_PAYROLL.has(id) };
  });
  out.sort((a, b) => a.user.name.localeCompare(b.user.name));
  return ok(out);
}

const parseBody = (body: string | undefined): Record<string, unknown> => {
  try { return body ? (JSON.parse(body) as Record<string, unknown>) : {}; } catch { return {}; }
};

function addRate(userId: string, b: Record<string, unknown>): DemoResult {
  if (!isIso(b.validFrom)) return err(400, "date_invalid", "validFrom must be a date (YYYY-MM-DD)", { field: "validFrom" });
  // A positive amount as text (the server's `parsePositiveAmount`): digits and an optional fraction, not zero.
  const rateText = typeof b.hourlyRate === "number" ? String(b.hourlyRate) : typeof b.hourlyRate === "string" ? b.hourlyRate.trim() : "";
  const rm = /^(\d{1,16})(?:\.(\d+))?$/.exec(rateText);
  if (!rm || !/[1-9]/.test(rateText)) return err(400, "rate_invalid", "hourlyRate must be a positive amount", { field: "hourlyRate" });
  const code = typeof b.expenseAccountCode === "string" ? b.expenseAccountCode.trim() : "";
  if (!code) return err(400, "expense_account_invalid", "expenseAccountCode is required", { field: "expenseAccountCode" });
  if (b.note !== undefined && b.note !== null && (typeof b.note !== "string" || b.note.length > 500)) return err(400, "note_invalid", "note is text of at most 500 characters");
  if (!PEOPLE[userId]) return err(404, "person_not_found", "no person with an active membership in this company has that id");
  // The demo company is in rupiah, which has no minor unit.
  if ((rm[2] ?? "").replace(/0+$/, "") !== "") return err(400, "rate_invalid", `hourlyRate must be positive with at most 0 decimals in ${CURRENCY}`, { field: "hourlyRate" });
  const rate = Number(rm[1]);
  if (!expenseAccount(code)) return err(400, "expense_account_invalid", `account ${code} is not a live, active, postable, non-control account`, { field: "expenseAccountCode" });
  if (ON_PAYROLL.has(userId)) return err(409, "freelancer_on_payroll", `${PEOPLE[userId].name} has a compensation in force on ${b.validFrom}: payroll would pay them twice`);
  const validFrom = b.validFrom;
  // The open rate that started before the new one ends the day before; the overlap wall then looks at every other rate.
  const open = rates.find((r) => r.userId === userId && r.validTo === null && r.validFrom < validFrom);
  const dayBefore = addDay(validFrom, -1);
  const others = rates.filter((r) => r.userId === userId && r !== open);
  if (others.some((r) => overlaps(r, { validFrom, validTo: null }))) {
    return err(409, "rate_overlap", "this range overlaps another rate of the person: end that rate first, or choose other dates");
  }
  let closedRate: { id: string; validTo: string } | null = null;
  if (open) {
    open.validTo = dayBefore;
    closedRate = { id: open.id, validTo: dayBefore };
  }
  const row: DemoRate = {
    id: rid(), userId, hourlyRate: rate, currency: CURRENCY, expenseAccountCode: code, validFrom,
    validTo: null, note: typeof b.note === "string" && b.note.trim() ? b.note.trim() : null, used: false,
  };
  rates.push(row);
  return ok({ ...rateView(row), closedRate }, 201);
}

function editRate(userId: string, rateId: string, b: Record<string, unknown>): DemoResult {
  const hasValidTo = Object.prototype.hasOwnProperty.call(b, "validTo");
  if (hasValidTo && b.validTo !== null && !isIso(b.validTo)) return err(400, "date_invalid", "validTo must be a date (YYYY-MM-DD) or null", { field: "validTo" });
  if (!hasValidTo && b.note === undefined) return err(400, "date_invalid", "send validTo (a date, or null to reopen) or note");
  const r = rates.find((x) => x.id === rateId && x.userId === userId);
  if (!r) return err(404, "rate_not_found", "no such rate for this person");
  if (hasValidTo) {
    const to = b.validTo as string | null;
    if (to !== null && to < r.validFrom) return err(400, "date_invalid", `validTo is before the rate's validFrom ${r.validFrom}`, { field: "validTo" });
    // A rate that priced a bill keeps its range: it cannot end earlier than it does.
    if (to !== null && r.used && (r.validTo === null || to < r.validTo)) return err(409, "rate_used", `this rate priced hours already billed after ${to}; it cannot end before them`);
    const probe = { validFrom: r.validFrom, validTo: to };
    if (rates.some((x) => x !== r && x.userId === userId && overlaps(x, probe))) return err(409, "rate_overlap", "this range overlaps another rate of the person: end that rate first, or choose other dates");
    r.validTo = to;
  }
  if (typeof b.note === "string") r.note = b.note.trim() || null;
  return ok(rateView(r));
}

function withdrawRate(userId: string, rateId: string): DemoResult {
  const r = rates.find((x) => x.id === rateId && x.userId === userId);
  if (!r) return err(404, "rate_not_found", "no such rate for this person");
  if (r.used) return err(409, "rate_used", "this rate priced hours on a bill; end it instead of withdrawing it");
  rates = rates.filter((x) => x !== r);
  return ok({ deleted: true });
}

function linkVendor(vendorId: string, b: Record<string, unknown>): DemoResult {
  if (!Object.prototype.hasOwnProperty.call(b, "userId") || (b.userId !== null && typeof b.userId !== "string")) {
    return err(400, "user_id_required", "userId is required: a person's id, or null to unlink", { field: "userId" });
  }
  const v = vendorById(vendorId);
  if (!v) return err(404, "vendor_not_found", "no live vendor with that id in this company");
  const userId = b.userId as string | null;
  if (userId !== null) {
    if (!PEOPLE[userId]) return err(404, "person_not_found", "no person with an active membership in this company has that id");
    const other = vendorRowsWithLinks().find((x) => x.userId === userId && x.id !== vendorId);
    if (other) return err(409, "person_has_vendor", "another live vendor already names this person");
    links[vendorId] = userId;
  } else {
    delete links[vendorId];
  }
  return ok({ vendorId, userId });
}

// ── The plan: what drafting a period would make ─────────────────────────────────────────────────────────────────
interface Issue { code: string; message: string; detail?: Record<string, unknown> }

function billedIn(userId: string, s: string, e: string): DemoBill | undefined {
  return bills.find((b) => b.userId === userId && b.status !== "void" && b.periodStart <= e && s <= b.periodEnd);
}

function planFor(userId: string, s: string, e: string) {
  const name = PEOPLE[userId].name;
  const vendor = vendorFor(userId);
  const mine = rates.filter((r) => r.userId === userId);
  const rate = mine.find((r) => inForce(r, e)) ?? null;
  const blockers: Issue[] = [];
  const warnings: Issue[] = [];
  if (!vendor) blockers.push({ code: "NO_VENDOR", message: `no live vendor names ${name}: link one under Finance › Payables` });
  if (!rate) blockers.push({ code: "NO_RATE", message: `no rate covers ${e}`, detail: { dates: [e] } });
  const lines = (UNBILLED[userId] ?? []).map((u) => {
    const hourly = rate?.hourlyRate ?? 0;
    return {
      project: { id: u.projectId, name: u.project }, minutes: u.minutes, hours: Number((u.minutes / 60).toFixed(4)), hourlyRate: hourly,
      amount: Math.round((u.minutes * hourly) / 60), firstDate: s, lastDate: e,
    };
  });
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  let withholding: { code: string; amount: number } | null = null;
  const code = vendor?.defaultWithholdingCode ?? null;
  if (vendor && code) withholding = { code, amount: Math.round(subtotal * (WITHHOLDING_RATE[code] ?? 0)) };
  else if (vendor) warnings.push({ code: "NO_WITHHOLDING", message: `${vendor.name} names no withholding code, so this bill withholds nothing (DW-D47)` });
  const earlier = EARLIER[userId];
  const earlierUnbilled = earlier ? { count: earlier.count, minutes: earlier.minutes, oldest: addDay(s, -earlier.days) } : null;
  if (earlierUnbilled) {
    warnings.push({
      code: "EARLIER_UNBILLED",
      message: `${earlierUnbilled.count} unbilled time ${earlierUnbilled.count === 1 ? "entry" : "entries"} dated before this period (from ${earlierUnbilled.oldest})`,
    });
  }
  return {
    user: personOf(userId), vendor: vendorView(vendor), lines, subtotal, withholding,
    amountPayable: subtotal - (withholding?.amount ?? 0), currency: CURRENCY, entryCount: lines.length * 4,
    earlierUnbilled, blockers, warnings,
  };
}

function preview(qs: URLSearchParams): DemoResult {
  const s = qs.get("periodStart");
  const e = qs.get("periodEnd");
  const problem = periodProblem(s, e);
  if (problem) return err(400, "period_invalid", problem);
  const start = s as string;
  const end = e as string;
  const people = new Set<string>([...rates.map((r) => r.userId), ...Object.values(links)]);
  const freelancers = [...people]
    .filter((id) => PEOPLE[id] && (UNBILLED[id] ?? []).length > 0 && !billedIn(id, start, end))
    .map((id) => planFor(id, start, end))
    .sort((a, b) => a.user.name.localeCompare(b.user.name));
  return ok({ periodStart: start, periodEnd: end, freelancers });
}

// ── Bills ───────────────────────────────────────────────────────────────────────────────────────────────────────
const billWarnings = (b: DemoBill): Issue[] => {
  const v = vendorById(b.vendorId);
  return v && b.withholdingAmount === 0 && !v.defaultWithholdingCode
    ? [{ code: "NO_WITHHOLDING", message: `${v.name} names no withholding code, so this bill withholds nothing (DW-D47)` }]
    : [];
};

function draft(b: Record<string, unknown>): DemoResult {
  const problem = periodProblem(b.periodStart, b.periodEnd);
  if (problem) return err(400, "period_invalid", problem);
  if (b.billDate !== undefined && b.billDate !== null && !isIso(b.billDate)) return err(400, "bill_date_invalid", "billDate must be a date (YYYY-MM-DD)", { field: "billDate" });
  const userId = typeof b.userId === "string" ? b.userId : "";
  if (!PEOPLE[userId]) return err(404, "person_not_found", "no person of this company has that id");
  const s = b.periodStart as string;
  const e = b.periodEnd as string;
  const existing = billedIn(userId, s, e);
  if (existing && existing.periodStart === s && existing.periodEnd === e && existing.status === "draft") {
    return ok({
      billId: existing.billId, billNo: existing.billNo, status: existing.status, subtotal: existing.subtotal, withholdingAmount: existing.withholdingAmount,
      amountPayable: existing.amountPayable, currency: existing.currency, entryCount: 4, warnings: billWarnings(existing), deduped: true,
    }, 201);
  }
  if (existing || (UNBILLED[userId] ?? []).length === 0) return err(409, "nothing_to_bill", "no unclaimed time entry in the period and no draft for it");
  const plan = planFor(userId, s, e);
  if (plan.blockers.length > 0) return err(409, "bill_blocked", "this bill cannot be drafted yet", { blockers: plan.blockers });
  const n = bills.length + 1;
  const row: DemoBill = {
    billId: rid(), billNo: `GA/FB/${e.slice(0, 4)}/${String(n).padStart(4, "0")}`, userId, vendorId: plan.vendor!.id, periodStart: s, periodEnd: e,
    minutes: plan.lines.reduce((a, l) => a + l.minutes, 0), subtotal: plan.subtotal, withholdingAmount: plan.withholding?.amount ?? 0,
    amountPayable: plan.amountPayable, currency: CURRENCY, status: "draft", createdAt: new Date().toISOString(),
  };
  bills.push(row);
  return ok({
    billId: row.billId, billNo: row.billNo, status: "draft", subtotal: row.subtotal, withholdingAmount: row.withholdingAmount,
    amountPayable: row.amountPayable, currency: CURRENCY, entryCount: plan.entryCount, warnings: plan.warnings.filter((w) => w.code === "NO_WITHHOLDING"),
  }, 201);
}

function listBills(qs: URLSearchParams): DemoResult {
  const status = qs.get("status");
  if (status !== null && !["draft", "approved", "paid", "void"].includes(status)) return err(400, "status_invalid", "status must be one of draft, approved, paid, void");
  const rows = bills
    .filter((b) => status === null || b.status === status)
    .sort((a, b) => (a.periodStart < b.periodStart ? 1 : a.periodStart > b.periodStart ? -1 : a.createdAt < b.createdAt ? 1 : -1))
    .map((b) => {
      const v = vendorById(b.vendorId)!;
      return {
        billId: b.billId, billNo: b.billNo, user: personOf(b.userId), vendor: { id: v.id, code: v.code, name: v.name },
        periodStart: b.periodStart, periodEnd: b.periodEnd, minutes: b.minutes, subtotal: b.subtotal, withholdingAmount: b.withholdingAmount,
        amountPayable: b.amountPayable, currency: b.currency, status: b.status, createdAt: b.createdAt, createdBy: { id: "demo-hansel", name: "Clement Hansel" },
        warnings: billWarnings(b),
      };
    });
  return ok(rows);
}

function discard(billId: string): DemoResult {
  const b = bills.find((x) => x.billId === billId);
  if (!b) return err(404, "freelancer_bill_not_found", "no freelancer bill with that id in this company");
  if (b.status !== "draft") return err(409, "bill_not_draft", `bill ${b.billNo} is ${b.status}; only a draft can be discarded`);
  bills = bills.filter((x) => x !== b);
  return ok({ billId, discarded: true, releasedEntries: 4 });
}

// ── The router ──────────────────────────────────────────────────────────────────────────────────────────────────
export function freelancersDemo(method: string, p: string, qs: URLSearchParams, body: string | undefined, userId: string | undefined): DemoResult | null {
  const m = /^\/api\/[^/]+\/finance\/(freelancers|freelancer-bills|ap\/vendors)(?:\/(.*))?$/.exec(p);
  if (!m) return null;
  const [, family, rest] = m;
  const verb = method.toUpperCase();
  const segs = rest ? rest.split("/").map(decodeURIComponent) : [];

  // `GET finance/ap/vendors` is the finance fixture's, with the people they name added; every other vendor route is not this store's.
  if (family === "ap/vendors") {
    if (verb === "GET" && segs.length === 0) {
      if (userId !== undefined && !FINANCE_USERS.has(userId)) return err(403, "forbidden", "forbidden");
      return ok(vendorRowsWithLinks());
    }
    if (verb === "PATCH" && segs.length === 2 && segs[1] === "person") {
      if (userId !== undefined && !FINANCE_USERS.has(userId)) return err(403, "forbidden", "forbidden");
      return linkVendor(segs[0], parseBody(body));
    }
    return null;
  }

  // Authorization first on every route, as the server has it.
  if (userId !== undefined && !FINANCE_USERS.has(userId)) return err(403, "forbidden", "forbidden");
  const b = parseBody(body);

  if (family === "freelancers") {
    if (segs.length === 0) return verb === "GET" ? listFreelancers() : err(404, "not_found", "not found");
    if (segs.length === 2 && segs[1] === "rates" && verb === "POST") return addRate(segs[0], b);
    if (segs.length === 3 && segs[1] === "rates") {
      if (verb === "PATCH") return editRate(segs[0], segs[2], b);
      if (verb === "DELETE") return withdrawRate(segs[0], segs[2]);
    }
    return err(404, "not_found", "not found");
  }

  // freelancer-bills
  if (segs.length === 0) {
    if (verb === "GET") return listBills(qs);
    if (verb === "POST") return draft(b);
  }
  if (segs.length === 1 && segs[0] === "preview" && verb === "GET") return preview(qs);
  if (segs.length === 1 && verb === "DELETE") return discard(segs[0]);
  return err(404, "not_found", "not found");
}
