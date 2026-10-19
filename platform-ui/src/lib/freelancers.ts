// DW-10f-4b — Finance > Payables > Freelancers: the wire shapes of BFF §61.7 and §61.8 (as built, §61.18) and the pure helpers the
// screen uses. Client-safe on purpose (no "server-only"): the client components format and branch on these.
//
// ── MONEY IS NEVER COMPUTED HERE ────────────────────────────────────────────────────────────────────────────────
// Every amount below is the server's: computed in SQL `numeric`, rounded once per line, and sent as a JSON number (§61.18:
// "a number for display"). This file formats an amount and nothing else: no sum, no product, no rounding of a figure. A total
// the screen wanted would be a second implementation of the bill, and the copy that drifts is the one the accountant reads.
// The one number the browser DOES send is the hourly rate on a new rate, and it goes as the text the person typed (the server
// parses it into `numeric`), never through a float.

/** An amount as the server sent it. §61.18 sends numbers; a string is tolerated and formatted the same. */
export type Amount = number | string;

export interface FlPerson { id: string; name: string; email: string }
export interface FlVendor { id: string; code: string; name: string; withholdingCode: string | null }

/** A rate (§61.7): the hourly price from `validFrom` to `validTo` (null = open). `used` means a claimed time entry fell in its range. */
export interface FlRate {
  id: string; userId: string; hourlyRate: Amount; currency: string; expenseAccountCode: string;
  validFrom: string; validTo: string | null; note: string | null; used: boolean;
}

/** One row of `GET finance/freelancers`: a person with a rate or a linked vendor. */
export interface Freelancer {
  user: FlPerson;
  vendor: FlVendor | null;
  currentRate: FlRate | null;
  rates: FlRate[];
  onPayroll: boolean;
}

/** A blocker or a warning (§61.8): a machine code and a sentence. `detail` carries the dates behind `NO_RATE`. */
export interface FlIssue { code: string; message: string; detail?: Record<string, unknown> }

export interface PreviewLine {
  project: { id: string; name: string };
  minutes: number; hours: Amount; hourlyRate: Amount; amount: Amount;
  firstDate: string; lastDate: string;
}

/** One freelancer in `GET finance/freelancer-bills/preview`: what drafting the period would make. */
export interface PreviewFreelancer {
  user: FlPerson;
  vendor: FlVendor | null;
  lines: PreviewLine[];
  subtotal: Amount;
  withholding: { code: string; amount: Amount } | null;
  amountPayable: Amount;
  currency: string;
  entryCount: number;
  earlierUnbilled: { count: number; minutes: number; oldest: string } | null;
  blockers: FlIssue[];
  warnings: FlIssue[];
}

export interface FlPreview { periodStart: string; periodEnd: string; freelancers: PreviewFreelancer[] }

/** The 201 of `POST finance/freelancer-bills`. `deduped` marks a replay that answered the live draft. */
export interface DraftedBill {
  billId: string; billNo: string; status: string; subtotal: Amount; withholdingAmount: Amount; amountPayable: Amount;
  currency: string; entryCount: number; warnings: FlIssue[]; deduped?: true;
}

/** One row of `GET finance/freelancer-bills`. `warnings` is derived on read, so a draft keeps `NO_WITHHOLDING` until it is approved or discarded. */
export interface FreelancerBill {
  billId: string; billNo: string;
  user: FlPerson;
  vendor: { id: string; code: string; name: string };
  periodStart: string; periodEnd: string; minutes: number;
  subtotal: Amount; withholdingAmount: Amount; amountPayable: Amount; currency: string;
  status: "draft" | "approved" | "paid" | "void" | string;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  warnings: FlIssue[];
}

// ── Formatting (display only) ────────────────────────────────────────────────────────────────────────────────

/** A currency amount, in en-GB, with the currency's own decimals (IDR and JPY none, the rest two). Never sums or rounds a figure beyond the display. */
export function formatAmount(amount: Amount | null | undefined, currency = "IDR"): string {
  if (amount === null || amount === undefined) return "—";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (typeof amount === "string" && amount.trim() === "") return "—";
  if (!Number.isFinite(n)) return "—";
  const decimals = currency === "IDR" || currency === "JPY" ? 0 : 2;
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(n);
}

/** Hours as the server sent them (four decimals at most), trailing zeros dropped for reading: 20 -> "20", 7.5 -> "7.5". Display only. */
export function formatHours(hours: Amount): string {
  const n = typeof hours === "string" ? Number(hours) : hours;
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 4 }).format(n);
}

// ── Dates ────────────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The server's own check (`isIsoDate`): a well-formed calendar date, not 2026-02-30. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The whole calendar month before `todayIso`: the default period of the picker (a freelancer is billed for last month's hours). */
export function lastMonthRange(todayIso: string): { periodStart: string; periodEnd: string } {
  const [y, m] = todayIso.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return { periodStart: `${py}-${pad2(pm)}-01`, periodEnd: `${py}-${pad2(pm)}-${pad2(lastDay)}` };
}

export const MAX_PERIOD_DAYS = 366;

/** Why a period cannot be asked for, in a sentence, or null when it can: the server's checks (§61.8), so a bad pick costs no round trip. */
export function periodProblem(start: unknown, end: unknown): string | null {
  if (!isIsoDate(start) || !isIsoDate(end)) return "Choose both dates of the period.";
  if (end < start) return "The period ends before it starts.";
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_PERIOD_DAYS) return `A period can be at most ${MAX_PERIOD_DAYS} days.`;
  return null;
}

/** A rate's range in words: "from 2026-01-01", "2026-01-01 to 2026-06-30". */
export function rangeLabel(r: { validFrom: string; validTo: string | null }): string {
  return r.validTo ? `${r.validFrom} to ${r.validTo}` : `from ${r.validFrom}, no end`;
}

// ── What may be drafted ──────────────────────────────────────────────────────────────────────────────────────

/** A freelancer is ready when the server named no blocker and there is something to bill. A warning never blocks (§61.8). */
export function isReady(f: PreviewFreelancer): boolean {
  return f.blockers.length === 0 && f.lines.length > 0;
}

export const readyFreelancers = (p: FlPreview | null | undefined): PreviewFreelancer[] => (p ? p.freelancers.filter(isReady) : []);

/** Drafts first (any period: a draft is a thing to approve or discard), then the other bills that overlap the picked period. */
export function splitBills(bills: FreelancerBill[], from: string, to: string): { drafts: FreelancerBill[]; inPeriod: FreelancerBill[] } {
  const drafts = bills.filter((b) => b.status === "draft");
  const inPeriod = bills.filter((b) => b.status !== "draft" && b.periodEnd >= from && b.periodStart <= to);
  return { drafts, inPeriod };
}

/** The first blocker's code that tells a person where to go next, for a link beside it. */
export function blockerFix(code: string): "link_vendor" | "add_rate" | null {
  if (code === "NO_VENDOR") return "link_vendor";
  if (code === "NO_RATE") return "add_rate";
  return null;
}

// ── Refusals as sentences ────────────────────────────────────────────────────────────────────────────────────

/**
 * The server's machine `reason` (§61.7, §61.8, §61.18) as a sentence a person can act on. An unknown reason falls back to the server's own
 * message, passed through untouched: a code this table does not know is a new refusal, and its words are better than none.
 */
const SENTENCES: Record<string, string> = {
  rate_overlap: "That range overlaps another rate for this person. End the other rate first, or choose other dates.",
  rate_used: "This rate priced hours that are already on a bill. It cannot be withdrawn, and it cannot end before those hours.",
  person_has_vendor: "Another vendor already names this person. Unlink it first, or link that vendor instead.",
  person_not_found: "That person is not an active member of this company.",
  freelancer_on_payroll: "This person is on payroll for those dates, so payroll would pay them twice.",
  rate_invalid: "Enter an hourly rate above zero, with no more decimals than the currency has.",
  date_invalid: "Enter a valid date.",
  currency_not_functional: "A rate is in the company's functional currency. Set the functional currency under Finance, Settings first.",
  expense_account_invalid: "Choose an expense account that is active and accepts postings.",
  note_invalid: "The note can be at most 500 characters.",
  vendor_not_found: "That vendor no longer exists.",
  rate_not_found: "That rate no longer exists. Reload the page.",
  user_id_required: "Choose a person to link.",
  period_invalid: "The period is not valid. Choose two dates, the end not before the start, at most 366 days apart.",
  bill_date_invalid: "The bill date is not a valid date.",
  nothing_to_bill: "There is nothing left to bill for this person in this period.",
  bill_not_draft: "Only a draft can be discarded, and this bill has moved on.",
  freelancer_bill_not_found: "That bill no longer exists. Reload the page.",
  conflict: "Their time entries changed while the bill was being drafted. Nothing was written. Try again.",
  status_invalid: "That bill status is not one the list knows.",
};

export function refusalSentence(reason: string | null | undefined, fallback: string): string {
  if (reason && SENTENCES[reason]) return SENTENCES[reason];
  return fallback;
}

/** Who a blocker code names, in the words of the preview. The server's own sentence follows it on screen. */
export const BLOCKER_TITLE: Record<string, string> = {
  NO_VENDOR: "No vendor",
  NO_RATE: "No rate",
  ON_PAYROLL: "On payroll",
  VENDOR_IS_PKP: "Vendor charges PPN",
  CURRENCY_NOT_FUNCTIONAL: "Currency",
  NO_EXPENSE_ACCOUNT: "Expense account",
  WITHHOLDING_CODE_NOT_IN_FORCE: "Withholding code",
  NO_OPEN_PERIOD: "No open fiscal period",
  NO_BILLING_PROFILE: "No billing profile",
  TOO_MANY_ENTRIES: "Too many entries",
};

export const WARNING_TITLE: Record<string, string> = {
  NO_WITHHOLDING: "No withholding code",
  EARLIER_UNBILLED: "Earlier hours unbilled",
};

/** Where Finance sets a freelancer's withholding: a tax code on the vendor record, set up under Finance > Tax (DW-D47). */
export const NO_WITHHOLDING_HINT =
  "Finance sets the withholding on the freelancer's vendor record, using a tax code from Finance > Tax. Until then this bill withholds nothing.";
