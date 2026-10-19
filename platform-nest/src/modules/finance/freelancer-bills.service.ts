// DW-10f-4a — freelancer bills, the service half (docs/FRONTEND-BFF-CONTRACT.md §61.7, §61.8, §61.12; PERMISSION-CONTRACT §51).
// The routes are freelancer-bills.controller.ts; the data layer is migration 202610181101_freelancer_bills.sql.
//
// ── EVERY AMOUNT IS SQL `numeric` ────────────────────────────────────────────────────────────────────────────────────
// The manual AP bill route (finance.controller.ts createApBill) multiplies JS floats; §61.8 rules that out here. Each line's
// money is `round(sum(minutes) × rate / 60, minor unit)` computed by Postgres, the withholding is
// `round(finance_tax_compute(company, code, subtotal, bill date), minor unit)`, and every figure travels between the
// queries as the database's own decimal TEXT, never as a JS number. Only the JSON answer converts to a number, for display,
// the way the invoice routes answer `total::float8`.
//
// ── THE SCOPES ARE LOAD-BEARING (§61.12) ─────────────────────────────────────────────────────────────────────────────
// `finance_freelancer_rates`, `finance_freelancer_bills`, `finance_ap_*`, `finance_tax_codes` and `finance_accounts` compose
// `app_module_allowed('finance')`, and `hr_compensation` composes `'hr'`. Without them a read returns ZERO rows with no error:
// a rate would read as missing (NO_RATE for everyone) and the payroll check would read every employee as a freelancer. So
// every transaction in this file is opened by `withFreelancerScope()` with BOTH scopes, and nothing calls withTenants
// directly. The suite pins that a session without them never answers "nothing to bill".
//
// ── THE CLAIM IS THE DATABASE'S (PD615, PD616, PD617) ────────────────────────────────────────────────────────────────
// The draft locks the person's unclaimed entries (`FOR UPDATE`), prices them, writes the bill, then claims exactly those
// entries with `... AND ap_bill_id IS NULL`. A concurrent draft blocks on the row locks and, once the first commits, re-reads
// the rows and finds them claimed (READ COMMITTED re-checks the WHERE on the new row version): it then answers the first
// draft as a replay (`deduped`) or `nothing_to_bill`, never a second bill. A claim that touches fewer rows than were locked
// rolls everything back (409 `conflict`); the trigger refuses any claim that does not hold (PD616).
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../../db";

/** The ONLY way this file reaches the database: the finance wall and the hr wall, both declared (see the header). */
export function withFreelancerScope<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([tenantId], fn, { modules: ["finance", "hr"] });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Pure helpers (unit-tested in freelancer-bills.unit.test.ts)
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PERIOD_DAYS = 366;
export const MAX_ENTRIES = 2000;
export const MAX_NOTE = 500;

/** A real calendar date in `YYYY-MM-DD` (2026-02-30 is refused, not rolled over to March). */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Days from `a` to `b`, both included (`a` = `b` is 1). Both must be valid ISO dates. */
export function daysInclusive(a: string, b: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000) + 1;
}

/**
 * A positive money amount as canonical decimal text, or null when it is not one. Accepts a number or a string; refuses
 * exponent forms, signs, more than 16 integer digits (numeric(20,4)) and more decimals than `maxDecimals` (the currency's
 * minor unit, and never more than the column's 4). The text goes to SQL as `::numeric`, so no float ever carries the value.
 */
export function parsePositiveAmount(v: unknown, maxDecimals: number): string | null {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else if (typeof v === "string") {
    s = v.trim();
  } else {
    return null;
  }
  const m = /^(\d{1,16})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const decimals = (m[2] ?? "").replace(/0+$/, "");
  if (decimals.length > Math.min(maxDecimals, 4)) return null;
  const int = m[1].replace(/^0+(?=\d)/, "");
  if (/^0+$/.test(int) && decimals === "") return null; // zero
  return decimals ? `${int}.${decimals}` : int;
}

/** §61.8: a period is two valid dates, the end not before the start, at most 366 days. Null when it holds, else why not. */
export function periodProblem(start: unknown, end: unknown): string | null {
  if (!isIsoDate(start) || !isIsoDate(end)) return "periodStart and periodEnd must be dates (YYYY-MM-DD)";
  if (end < start) return "periodEnd is before periodStart";
  if (daysInclusive(start, end) > MAX_PERIOD_DAYS) return `a period is at most ${MAX_PERIOD_DAYS} days`;
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Refusals: `{message, reason}` (http-error.filter.ts renames `message` to `error` and forwards `reason`, `blockers`, `detail`)
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const bad = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
  new BadRequestException({ message, reason, ...extra });
export const notFound = (reason: string, message: string) => new NotFoundException({ message, reason });
export const conflict = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
  new ConflictException({ message, reason, ...extra });

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | undefined)?.code;
const constraintOf = (e: unknown): string | undefined => (e as { constraint?: string } | undefined)?.constraint;

/** Maps the database walls this surface can meet to their §61 answers; anything else propagates. */
export function mapFreelancerDbError(e: unknown): never {
  const code = codeOf(e);
  if (code === "23P01" && constraintOf(e) === "ex_finance_freelancer_rates_no_overlap") {
    throw conflict("rate_overlap", "this range overlaps another rate of the person: end that rate first, or choose other dates");
  }
  if (code === "23505" && constraintOf(e) === "ux_finance_ap_vendors_user_live") {
    throw conflict("person_has_vendor", "another live vendor already names this person");
  }
  if (code === "PD616" || code === "PD615") {
    throw conflict("conflict", "a time entry of this period changed while the bill was being drafted; nothing was written, try again");
  }
  if (code === "PD617") throw conflict("bill_not_draft", "only a draft freelancer bill can be discarded");
  if (code === "40001" || code === "40P01") {
    throw conflict("conflict", "a concurrent change got there first; nothing was written, try again");
  }
  throw e;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Reads shared by the rates and the bills
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface PersonRow { id: string; name: string; email: string }

/**
 * §61.7 `person_not_found`: a human (`users.kind = 'employee'`, active) with an ACTIVE membership in this company. The
 * gate for a new rate and for a vendor link. A client contact (kind `client`) and a member of another company fail it.
 */
export async function activeHuman(c: PoolClient, tenantId: string, userId: string): Promise<PersonRow | null> {
  if (!UUID_RE.test(userId)) return null;
  const r = await c.query<PersonRow>(
    `SELECT u.id, u.name, u.email
       FROM company_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.user_id = $2
        AND m.deleted_at IS NULL AND m.status = 'active' AND u.deleted_at IS NULL AND u.status = 'active' AND u.kind = 'employee'`,
    [tenantId, userId],
  );
  return r.rows[0] ?? null;
}

/**
 * The person a BILL is drafted for: a human with a membership row in this company, whatever its status now. Wider than
 * `activeHuman` on purpose: a freelancer who has left still has hours to be paid for, and their rate and vendor were
 * checked when they were recorded.
 */
export async function billablePerson(c: PoolClient, tenantId: string, userId: string): Promise<PersonRow | null> {
  if (!UUID_RE.test(userId)) return null;
  const r = await c.query<PersonRow>(
    `SELECT u.id, u.name, u.email
       FROM company_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.deleted_at IS NULL AND u.kind = 'employee'`,
    [tenantId, userId],
  );
  return r.rows[0] ?? null;
}

/** §61.7 `freelancer_on_payroll` / §61.8 `ON_PAYROLL`: the first day of [from, to] (to NULL = open) a compensation is in force. */
export async function payrollOverlap(
  c: PoolClient, tenantId: string, userId: string, from: string, to: string | null,
): Promise<string | null> {
  const r = await c.query<{ d: string | null }>(
    `SELECT to_char(min(GREATEST(hc.effective_from, $3::date)), 'YYYY-MM-DD') AS d
       FROM hr_compensation hc JOIN employees e ON e.id = hc.employee_id AND e.tenant_id = hc.tenant_id
      WHERE hc.tenant_id = $1 AND (e.user_id = $2 OR hc.subject_user_id = $2)
        AND daterange(hc.effective_from, hc.effective_to, '[]') && daterange($3::date, $4::date, '[]')`,
    [tenantId, userId, from, to],
  );
  return r.rows[0]?.d ?? null;
}

/** The company's functional currency and its minor unit, or null when the company has no finance settings. */
export async function functionalCurrency(c: PoolClient, tenantId: string): Promise<{ code: string; minorUnit: number } | null> {
  const r = await c.query<{ code: string; minor_unit: number }>(
    `SELECT s.functional_currency AS code, fc.minor_unit
       FROM finance_company_settings s JOIN finance_currencies fc ON fc.code = s.functional_currency
      WHERE s.tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0] ? { code: r.rows[0].code, minorUnit: Number(r.rows[0].minor_unit) } : null;
}

/** A live, active, postable, non-control account by code (the expense side of a bill line), or null. */
export async function postableAccountId(c: PoolClient, tenantId: string, code: string): Promise<string | null> {
  const r = await c.query<{ id: string }>(
    `SELECT id FROM finance_accounts
      WHERE tenant_id = $1 AND code = $2 AND deleted_at IS NULL AND status = 'active' AND is_postable AND NOT is_control
      ORDER BY code LIMIT 1`,
    [tenantId, code],
  );
  return r.rows[0]?.id ?? null;
}

/** The SQL predicate "a claimed, live time entry of the rate's person falls in the rate's range" (§61.7 `used`). */
export const RATE_USED_SQL = (r: string) => `EXISTS (
  SELECT 1 FROM time_entries te
   WHERE te.tenant_id = ${r}.tenant_id AND te.user_id = ${r}.user_id AND te.ap_bill_id IS NOT NULL AND te.deleted_at IS NULL
     AND te.entry_date >= ${r}.valid_from AND (${r}.valid_to IS NULL OR te.entry_date <= ${r}.valid_to))`;

/**
 * Whether claimed entries priced by this rate would lose it if the rate ended on `newTo` (NULL = still open): any claimed
 * entry of the person dated after `newTo` and inside the rate's current range. A billed hour keeps the rate it was billed at.
 */
export async function claimedAfter(
  c: PoolClient, tenantId: string, userId: string, validFrom: string, oldTo: string | null, newTo: string,
): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM time_entries
      WHERE tenant_id = $1 AND user_id = $2 AND ap_bill_id IS NOT NULL AND deleted_at IS NULL
        AND entry_date > $4::date AND entry_date >= $3::date AND ($5::date IS NULL OR entry_date <= $5::date)
      LIMIT 1`,
    [tenantId, userId, validFrom, newTo, oldTo],
  );
  return (r.rowCount ?? 0) > 0;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The plan: what a draft for one person and period would be (the preview shows it; the draft writes it)
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface Issue { code: string; message: string; detail?: Record<string, unknown> }

export interface PlanLine {
  projectId: string; projectName: string; rateId: string; hourlyRate: string; rateLabel: string;
  currency: string; expenseAccountCode: string; expenseAccountId: string | null;
  minutes: number; quantity: string; hours: string; amount: string; firstDate: string; lastDate: string;
}

export interface Plan {
  user: PersonRow;
  vendor: { id: string; code: string; name: string; withholdingCode: string | null; isPkp: boolean; paymentTermsDays: number } | null;
  entryIds: string[];
  minutes: number;
  lines: PlanLine[];
  subtotal: string;
  withholding: { code: string; amount: string; rate: string; accountId: string | null } | null;
  amountPayable: string;
  currency: string | null;
  minorUnit: number;
  invoicePrefix: string | null;
  earlierUnbilled: { count: number; minutes: number; oldest: string } | null;
  blockers: Issue[];
  warnings: Issue[];
}

/**
 * Builds the plan for one person and period. With `lock`, the unclaimed entries are locked `FOR UPDATE` (the draft); the
 * preview reads them without a lock. Blockers are collected all at once (§61.8 step 3).
 */
export async function buildPlan(
  c: PoolClient,
  tenantId: string,
  user: PersonRow,
  periodStart: string,
  periodEnd: string,
  billDate: string,
  lock: boolean,
): Promise<Plan> {
  const blockers: Issue[] = [];
  const warnings: Issue[] = [];

  const head = await c.query<{
    currency: string | null; minor_unit: number | null; prefix: string | null; period_open: boolean;
  }>(
    `SELECT fs.functional_currency AS currency, cur.minor_unit, bp.invoice_prefix AS prefix,
            finance_period_accepts_posting($1, $2::date) AS period_open
       FROM (SELECT 1) x
       LEFT JOIN finance_company_settings fs ON fs.tenant_id = $1
       LEFT JOIN finance_currencies cur ON cur.code = fs.functional_currency
       LEFT JOIN company_billing_profiles bp ON bp.tenant_id = $1`,
    [tenantId, billDate],
  );
  const h = head.rows[0];
  const functional = h.currency;
  const minorUnit = h.minor_unit == null ? 2 : Number(h.minor_unit);

  const vendorRow = await c.query<{
    id: string; code: string; name: string; default_withholding_code: string | null; is_pkp: boolean | null; payment_terms_days: number;
  }>(
    `SELECT id, code, name, default_withholding_code, is_pkp, payment_terms_days
       FROM finance_ap_vendors
      WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL AND status = 'active'
      ORDER BY created_at LIMIT 1`,
    [tenantId, user.id],
  );
  const v = vendorRow.rows[0];
  const vendor = v
    ? {
        id: v.id, code: v.code, name: v.name,
        withholdingCode: v.default_withholding_code?.trim() ? v.default_withholding_code.trim() : null,
        isPkp: v.is_pkp === true, paymentTermsDays: Number(v.payment_terms_days),
      }
    : null;

  // 1. The person's unclaimed, undeleted entries in the period (every project; `billable` is about clients and is ignored).
  const entries = await c.query<{ id: string; minutes: number }>(
    `SELECT id, minutes FROM time_entries
      WHERE tenant_id = $1 AND user_id = $2 AND ap_bill_id IS NULL AND deleted_at IS NULL
        AND entry_date BETWEEN $3::date AND $4::date
      ORDER BY entry_date, id
      LIMIT ${MAX_ENTRIES + 1}${lock ? " FOR UPDATE" : ""}`,
    [tenantId, user.id, periodStart, periodEnd],
  );
  const entryIds = entries.rows.map((r) => r.id);
  const minutes = entries.rows.reduce((t, r) => t + Number(r.minutes), 0);
  if (entryIds.length > MAX_ENTRIES) {
    blockers.push({ code: "TOO_MANY_ENTRIES", message: `more than ${MAX_ENTRIES} time entries in this period: narrow the period` });
  }

  // 2. Each entry at the rate in force on its date; a line per (project, rate), the money rounded once per line.
  const priced = await c.query<{
    projectId: string; projectName: string; rateId: string; hourlyRate: string; rateLabel: string; currency: string;
    expenseAccountCode: string; expenseAccountId: string | null; minutes: number; quantity: string; hours: string;
    amount: string; firstDate: string; lastDate: string; subtotal: string;
  }>(
    `WITH e AS (
       SELECT te.project_id, te.entry_date, te.minutes, r.id AS rate_id, r.hourly_rate, r.currency_code,
              r.expense_account_code, r.valid_from
         FROM time_entries te
         JOIN finance_freelancer_rates r
           ON r.tenant_id = te.tenant_id AND r.user_id = te.user_id
          AND te.entry_date >= r.valid_from AND (r.valid_to IS NULL OR te.entry_date <= r.valid_to)
        WHERE te.tenant_id = $1 AND te.id = ANY($2::uuid[])
     )
     SELECT e.project_id AS "projectId", p.name AS "projectName", e.rate_id AS "rateId",
            e.hourly_rate::text AS "hourlyRate", trim_scale(e.hourly_rate)::text AS "rateLabel", e.currency_code AS currency,
            e.expense_account_code AS "expenseAccountCode",
            (SELECT fa.id FROM finance_accounts fa
              WHERE fa.tenant_id = $1 AND fa.code = e.expense_account_code AND fa.deleted_at IS NULL AND fa.status = 'active'
                AND fa.is_postable AND NOT fa.is_control
              ORDER BY fa.code LIMIT 1) AS "expenseAccountId",
            sum(e.minutes)::int AS minutes,
            round(sum(e.minutes)::numeric / 60, 4)::text AS quantity,
            trim_scale(round(sum(e.minutes)::numeric / 60, 4))::text AS hours,
            round(sum(e.minutes)::numeric * e.hourly_rate / 60, $3::int)::text AS amount,
            to_char(min(e.entry_date), 'YYYY-MM-DD') AS "firstDate", to_char(max(e.entry_date), 'YYYY-MM-DD') AS "lastDate",
            (sum(round(sum(e.minutes)::numeric * e.hourly_rate / 60, $3::int)) OVER ())::text AS subtotal
       FROM e JOIN projects p ON p.id = e.project_id
      GROUP BY e.project_id, p.name, e.rate_id, e.hourly_rate, e.currency_code, e.expense_account_code, e.valid_from
      ORDER BY p.name, e.project_id, e.valid_from`,
    [tenantId, entryIds, minorUnit],
  );
  const lines: PlanLine[] = priced.rows.map((r) => ({
    projectId: r.projectId, projectName: r.projectName, rateId: r.rateId, hourlyRate: r.hourlyRate, rateLabel: r.rateLabel,
    currency: r.currency, expenseAccountCode: r.expenseAccountCode, expenseAccountId: r.expenseAccountId,
    minutes: Number(r.minutes), quantity: r.quantity, hours: r.hours, amount: r.amount, firstDate: r.firstDate, lastDate: r.lastDate,
  }));
  const subtotal = priced.rows[0]?.subtotal ?? "0";

  if (!vendor) {
    blockers.push({ code: "NO_VENDOR", message: `no live vendor names ${user.name}: link one under Finance › Payables` });
  }

  const unrated = await c.query<{ d: string }>(
    `SELECT DISTINCT to_char(te.entry_date, 'YYYY-MM-DD') AS d
       FROM time_entries te
      WHERE te.tenant_id = $1 AND te.id = ANY($2::uuid[])
        AND NOT EXISTS (SELECT 1 FROM finance_freelancer_rates r
                         WHERE r.tenant_id = te.tenant_id AND r.user_id = te.user_id
                           AND te.entry_date >= r.valid_from AND (r.valid_to IS NULL OR te.entry_date <= r.valid_to))
      ORDER BY 1`,
    [tenantId, entryIds],
  );
  if (unrated.rows.length) {
    const dates = unrated.rows.map((r) => r.d);
    blockers.push({ code: "NO_RATE", message: `no rate covers ${dates.length === 1 ? dates[0] : `${dates.length} days (from ${dates[0]})`}`, detail: { dates } });
  }

  const payroll = await c.query<{ d: string }>(
    `SELECT DISTINCT to_char(te.entry_date, 'YYYY-MM-DD') AS d
       FROM time_entries te
      WHERE te.tenant_id = $1 AND te.id = ANY($2::uuid[])
        AND EXISTS (SELECT 1 FROM hr_compensation hc JOIN employees em ON em.id = hc.employee_id AND em.tenant_id = hc.tenant_id
                     WHERE hc.tenant_id = te.tenant_id AND (em.user_id = te.user_id OR hc.subject_user_id = te.user_id)
                       AND te.entry_date >= hc.effective_from AND (hc.effective_to IS NULL OR te.entry_date <= hc.effective_to))
      ORDER BY 1`,
    [tenantId, entryIds],
  );
  if (payroll.rows.length) {
    blockers.push({
      code: "ON_PAYROLL",
      message: `${user.name} has a compensation in force on ${payroll.rows[0].d}: payroll pays those days`,
      detail: { dates: payroll.rows.map((r) => r.d) },
    });
  }

  if (vendor?.isPkp) {
    blockers.push({ code: "VENDOR_IS_PKP", message: `${vendor.name} charges PPN: enter that bill by hand, with its e-Faktur` });
  }

  const currencies = [...new Set(lines.map((l) => l.currency))];
  if (!functional) {
    blockers.push({ code: "CURRENCY_NOT_FUNCTIONAL", message: "the company has no functional currency (Finance › Settings)" });
  } else if (currencies.some((cur) => cur !== functional)) {
    blockers.push({ code: "CURRENCY_NOT_FUNCTIONAL", message: `a rate is in ${currencies.find((cur) => cur !== functional)}, not the functional currency ${functional}` });
  }

  const badAccounts = [...new Set(lines.filter((l) => !l.expenseAccountId).map((l) => l.expenseAccountCode))];
  if (badAccounts.length) {
    blockers.push({
      code: "NO_EXPENSE_ACCOUNT",
      message: `expense account ${badAccounts.join(", ")} is not a live, postable, non-control account`,
      detail: { codes: badAccounts },
    });
  }

  // 6. Withholding (DW-D47): the vendor's own code, through finance_tax_compute(); no code, no withholding and a warning.
  let withholding: Plan["withholding"] = null;
  if (vendor && vendor.withholdingCode) {
    const t = await c.query<{ kind: string; account_id: string | null; live_account: string | null; amount: string; wrate: string }>(
      `SELECT t.kind, t.account_id,
              (SELECT fa.id FROM finance_accounts fa
                WHERE fa.id = t.account_id AND fa.tenant_id = t.tenant_id AND fa.deleted_at IS NULL AND fa.status = 'active') AS live_account,
              round(finance_tax_compute($1, $2, $3::numeric, $4::date), $5::int)::text AS amount,
              round(t.rate * t.base_multiplier / 100, 6)::text AS wrate
         FROM finance_tax_codes t
        WHERE t.tenant_id = $1 AND t.code = $2 AND $4::date >= t.effective_from AND (t.effective_to IS NULL OR $4::date <= t.effective_to)
        ORDER BY t.effective_from DESC LIMIT 1`,
      [tenantId, vendor.withholdingCode, subtotal, billDate, minorUnit],
    );
    const row = t.rows[0];
    if (!row || !["pph21", "pph23", "pph42"].includes(row.kind) || !row.live_account) {
      blockers.push({
        code: "WITHHOLDING_CODE_NOT_IN_FORCE",
        message: `withholding code ${vendor.withholdingCode} has no PPh 21, 23 or 4(2) tax code in force on ${billDate} with a live account`,
      });
    } else {
      withholding = { code: vendor.withholdingCode, amount: row.amount, rate: row.wrate, accountId: row.live_account };
    }
  } else if (vendor) {
    warnings.push({ code: "NO_WITHHOLDING", message: `${vendor.name} names no withholding code, so this bill withholds nothing (DW-D47)` });
  }

  if (!h.period_open) {
    blockers.push({ code: "NO_OPEN_PERIOD", message: `no open fiscal period holds the bill date ${billDate}, so approval would fail` });
  }
  if (!h.prefix) {
    blockers.push({ code: "NO_BILLING_PROFILE", message: "the company has no billing profile, so the bill has no number prefix (Finance › Billing)" });
  }

  const earlier = await c.query<{ count: number; minutes: number; oldest: string | null }>(
    `SELECT count(*)::int AS count, COALESCE(sum(minutes), 0)::int AS minutes, to_char(min(entry_date), 'YYYY-MM-DD') AS oldest
       FROM time_entries
      WHERE tenant_id = $1 AND user_id = $2 AND ap_bill_id IS NULL AND deleted_at IS NULL AND entry_date < $3::date`,
    [tenantId, user.id, periodStart],
  );
  const e0 = earlier.rows[0];
  const earlierUnbilled = e0 && Number(e0.count) > 0 && e0.oldest
    ? { count: Number(e0.count), minutes: Number(e0.minutes), oldest: e0.oldest }
    : null;
  if (earlierUnbilled) {
    warnings.push({
      code: "EARLIER_UNBILLED",
      message: `${earlierUnbilled.count} unbilled time ${earlierUnbilled.count === 1 ? "entry" : "entries"} dated before this period (from ${earlierUnbilled.oldest})`,
    });
  }

  const payable = await c.query<{ p: string }>(`SELECT ($1::numeric - $2::numeric)::text AS p`, [subtotal, withholding?.amount ?? "0"]);

  return {
    user, vendor, entryIds, minutes, lines, subtotal, withholding,
    amountPayable: payable.rows[0].p,
    currency: functional, minorUnit, invoicePrefix: h.prefix,
    earlierUnbilled, blockers, warnings,
  };
}

/** The preview's shape of one plan (§61.8 `GET finance/freelancer-bills/preview`). */
export function planView(p: Plan) {
  return {
    user: p.user,
    vendor: p.vendor ? { id: p.vendor.id, code: p.vendor.code, name: p.vendor.name, withholdingCode: p.vendor.withholdingCode } : null,
    lines: p.lines.map((l) => ({
      project: { id: l.projectId, name: l.projectName },
      minutes: l.minutes, hours: Number(l.hours), hourlyRate: Number(l.hourlyRate), amount: Number(l.amount),
      firstDate: l.firstDate, lastDate: l.lastDate,
    })),
    subtotal: Number(p.subtotal),
    withholding: p.withholding ? { code: p.withholding.code, amount: Number(p.withholding.amount) } : null,
    amountPayable: Number(p.amountPayable),
    currency: p.currency,
    entryCount: p.entryIds.length,
    earlierUnbilled: p.earlierUnbilled,
    blockers: p.blockers,
    warnings: p.warnings,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The draft (§61.8 "The draft, in one transaction")
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface DraftAnswer {
  billId: string; billNo: string; status: string; subtotal: number; withholdingAmount: number; amountPayable: number;
  currency: string; entryCount: number; warnings: Issue[]; deduped?: true;
}

/** The answer for a stored freelancer bill (a replay reads it back). `warnings` derived as the list derives it. */
async function storedAnswer(c: PoolClient, tenantId: string, billId: string): Promise<DraftAnswer> {
  const r = await c.query<{
    billNo: string; status: string; subtotal: number; withholdingAmount: number; amountPayable: number; currency: string;
    entryCount: number; noWithholding: boolean; vendorName: string;
  }>(
    `SELECT ab.bill_no AS "billNo", ab.status, ab.subtotal::float8 AS subtotal, ab.withholding_amount::float8 AS "withholdingAmount",
            ab.amount_payable::float8 AS "amountPayable", ab.currency_code AS currency,
            (SELECT count(*)::int FROM time_entries te WHERE te.tenant_id = ab.tenant_id AND te.ap_bill_id = ab.id) AS "entryCount",
            (ab.withholding_amount = 0 AND NULLIF(btrim(v.default_withholding_code), '') IS NULL) AS "noWithholding",
            v.name AS "vendorName"
       FROM finance_ap_bills ab JOIN finance_ap_vendors v ON v.id = ab.vendor_id AND v.tenant_id = ab.tenant_id
      WHERE ab.tenant_id = $1 AND ab.id = $2`,
    [tenantId, billId],
  );
  const b = r.rows[0];
  return {
    billId, billNo: b.billNo, status: b.status, subtotal: b.subtotal, withholdingAmount: b.withholdingAmount,
    amountPayable: b.amountPayable, currency: b.currency, entryCount: b.entryCount,
    warnings: b.noWithholding ? [noWithholdingWarning(b.vendorName)] : [],
  };
}

export const noWithholdingWarning = (vendorName: string): Issue => ({
  code: "NO_WITHHOLDING",
  message: `${vendorName} names no withholding code, so this bill withholds nothing (DW-D47)`,
});

/**
 * Drafts one freelancer bill. Runs inside the caller's `withFreelancerScope` transaction. Throws the §61.8 refusals:
 * 409 `nothing_to_bill`, 409 `bill_blocked` (with `blockers`), 409 `conflict` (the claim lost a race).
 */
export async function draftBill(
  c: PoolClient,
  tenantId: string,
  actorId: string | null,
  user: PersonRow,
  periodStart: string,
  periodEnd: string,
  billDate: string,
): Promise<DraftAnswer> {
  const plan = await buildPlan(c, tenantId, user, periodStart, periodEnd, billDate, true);

  if (plan.entryIds.length === 0) {
    // A replay: exactly this person and period, a live draft for it, and nothing left unbilled.
    const live = await c.query<{ bill_id: string }>(
      `SELECT fb.bill_id
         FROM finance_freelancer_bills fb JOIN finance_ap_bills ab ON ab.id = fb.bill_id AND ab.tenant_id = fb.tenant_id
        WHERE fb.tenant_id = $1 AND fb.user_id = $2 AND fb.period_start = $3::date AND fb.period_end = $4::date
          AND ab.status = 'draft'
        ORDER BY fb.created_at DESC LIMIT 1`,
      [tenantId, user.id, periodStart, periodEnd],
    );
    if (live.rows[0]) return { ...(await storedAnswer(c, tenantId, live.rows[0].bill_id)), deduped: true };
    throw conflict("nothing_to_bill", `${user.name} has no unbilled time from ${periodStart} to ${periodEnd}`);
  }
  if (plan.blockers.length) {
    throw conflict("bill_blocked", plan.blockers.map((b) => b.message).join("; "), { blockers: plan.blockers });
  }
  const vendor = plan.vendor!;
  const currency = plan.currency!;

  // 4. The AP bill, a draft, numbered {prefix}/FB/{yyyy}/{nnnn} in the company's internal 'freelancer_bill' series.
  const year = Number(billDate.slice(0, 4));
  const n = await c.query<{ n: number }>(`SELECT next_document_no($1, 'freelancer_bill', $2) AS n`, [tenantId, year]);
  const billNo = [plan.invoicePrefix, "FB", String(year), String(n.rows[0].n).padStart(4, "0")].join("/");
  const wht = plan.withholding;
  // A withholding that rounds to zero carries no account (ck_finance_ap_bills_wht). Testing a decimal text for zero through
  // Number() is exact.
  const whtAmountIsZero = !wht || Number(wht.amount) === 0;
  const bill = await c.query<{ id: string }>(
    `INSERT INTO finance_ap_bills
       (tenant_id, vendor_id, bill_no, bill_date, due_date, currency_code, subtotal, tax_total, total,
        withholding_code, withholding_rate, withholding_amount, withholding_account_id, amount_payable, amount_paid, status, notes)
     VALUES ($1, $2, $3, $4::date, $4::date + $5::int, $6, $7::numeric, 0, $7::numeric,
             $8, $9::numeric, $10::numeric, $11, $12::numeric, 0, 'draft', $13)
     RETURNING id`,
    [
      tenantId, vendor.id, billNo, billDate, vendor.paymentTermsDays, currency, plan.subtotal,
      wht?.code ?? null, wht?.rate ?? null, wht?.amount ?? "0", whtAmountIsZero ? null : wht!.accountId, plan.amountPayable,
      `Freelancer hours ${periodStart} to ${periodEnd}`,
    ],
  );
  const billId = bill.rows[0].id;

  // 5. The lines, one per (project, rate). quantity = the hours to 4 decimals; the money was rounded once, per line.
  let lineNo = 1;
  for (const l of plan.lines) {
    await c.query(
      `INSERT INTO finance_ap_bill_lines
         (tenant_id, bill_id, line_no, description, quantity, unit_price, line_subtotal, expense_account_id, tax_code, tax_rate, tax_amount)
       VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8, NULL, NULL, 0)`,
      [
        tenantId, billId, lineNo++,
        `${l.projectName} · ${l.hours} h × ${l.rateLabel} (${l.firstDate} to ${l.lastDate})`,
        l.quantity, l.hourlyRate, l.amount, l.expenseAccountId,
      ],
    );
  }

  // 7. The freelancer row, then the claim: every locked entry, or nothing.
  await c.query(
    `INSERT INTO finance_freelancer_bills (bill_id, tenant_id, user_id, vendor_id, period_start, period_end, minutes, created_by)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8)`,
    [billId, tenantId, user.id, vendor.id, periodStart, periodEnd, plan.minutes, actorId],
  );
  const claimed = await c.query(
    `UPDATE time_entries SET ap_bill_id = $2, updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($3::uuid[]) AND ap_bill_id IS NULL AND deleted_at IS NULL`,
    [tenantId, billId, plan.entryIds],
  );
  if ((claimed.rowCount ?? 0) !== plan.entryIds.length) {
    throw conflict("conflict", "a time entry of this period was billed or changed while the bill was being drafted; nothing was written, try again");
  }

  return {
    billId, billNo, status: "draft",
    subtotal: Number(plan.subtotal), withholdingAmount: Number(wht?.amount ?? 0), amountPayable: Number(plan.amountPayable),
    currency, entryCount: plan.entryIds.length, warnings: plan.warnings,
  };
}
