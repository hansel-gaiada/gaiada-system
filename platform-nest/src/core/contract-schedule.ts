// DW-10f-2a — a contract's PAYMENT SCHEDULE (FRONTEND-BFF-CONTRACT §61.3, §61.4, §61.4a, §61.6; rulings DW-D45, DW-D49).
//
// A schedule is rows of `contract_instalments` (migration 202610181100), written while the contract is a DRAFT and fixed
// by the send (its hash, `schedule_sha256`, is computed by the one SQL function `contract_schedule_sha256()`; no
// TypeScript here re-derives it). DW-D49 adds one more door: Finance may add a schedule ONCE to a signed contract that has
// a value and none (§61.4a). The database is the wall (PD610 to PD618); this file is the handler half: the body's
// validation, the refusals §61 names in the order it names them, the reads, and the mapping of every database code to an
// answer (never a 500).
//
// ── MONEY ───────────────────────────────────────────────────────────────────────────────────────────
// Amounts arrive as JSON numbers or decimal strings and are kept as DECIMAL STRINGS: written with `$n::numeric`, summed
// and compared in SQL. The precision check counts decimal digits in the string. No float arithmetic touches an amount;
// reads hand amounts back as float8 for display only, like `value` on every contract read.
//
// ── STATES (§61.3) ──────────────────────────────────────────────────────────────────────────────────
// Derived on read, never stored: `instalmentStateSql()` is the one expression the staff read, the billable read and the
// portal read share. The portal folds `invoicing` into `due` (an unissued invoice never surfaces, PV3-02d).
import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";
import { DatabaseError, type PoolClient } from "pg";
import { newId } from "../db";
import { scrubText } from "./scrub";

/** At most this many instalments on one contract (the table's `position` CHECK). */
export const MAX_INSTALMENTS = 60;
/** The label limit (the table's CHECK, after trimming). */
export const MAX_LABEL = 120;
/** numeric(20,4): at most 16 integer digits. */
const MAX_INTEGER_DIGITS = 16;

/** One validated instalment, in the order the caller sent it (position = index + 1). */
export interface ScheduleRow {
  label: string;
  /** A canonical decimal string: no sign, no exponent, no trailing fractional zeros (e.g. "1500000", "12.5"). */
  amount: string;
  dueKind: "on_signing" | "date";
  /** YYYY-MM-DD when dueKind is "date", else null. */
  dueOn: string | null;
}

/** A typed refusal: `error` (and `reason`) carry the code §61 names; `detail` carries the figures when it has any. */
export function refusal(status: 400 | 404 | 409, code: string, detail?: Record<string, unknown>): HttpException {
  const body = { message: code, reason: code, ...(detail ? { detail } : {}) };
  if (status === 400) return new BadRequestException(body);
  if (status === 404) return new NotFoundException(body);
  return new ConflictException(body);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD (no 2026-02-30). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** A positive decimal amount as a canonical string, or null when it is not one. Accepts a JSON number or a decimal
 *  string; refuses exponents, signs, blanks and zero. Fractional digits are kept as sent (minus trailing zeros) so the
 *  precision check sees exactly what was asked. */
export function canonicalAmount(v: unknown): string | null {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    s = String(v);
  } else if (typeof v === "string") {
    s = v.trim();
  } else {
    return null;
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const intPart = m[1].replace(/^0+(?=\d)/, "");
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (intPart.length > MAX_INTEGER_DIGITS) return null;
  if (/^0*$/.test(intPart) && frac === "") return null; // zero
  return frac ? `${intPart}.${frac}` : intPart;
}

/** How many decimals a canonical amount carries. */
export const decimalsOf = (amount: string): number => (amount.includes(".") ? amount.split(".")[1].length : 0);

/**
 * The body of `PUT …/schedule` and `POST …/schedule/after-signing`: `{instalments: [{label, amount, due}]}`.
 * Throws 400 `schedule_invalid` (shape) or 400 `schedule_order_invalid` (an `on_signing` row that is not first, a second
 * one, or dates that go backwards), in that order. `requireOne`: an empty list is `schedule_invalid` (the addition).
 */
export function parseScheduleBody(body: unknown, opts: { requireOne: boolean }): ScheduleRow[] {
  const raw = (body as { instalments?: unknown } | null | undefined)?.instalments;
  if (!Array.isArray(raw) || raw.length > MAX_INSTALMENTS || (opts.requireOne && raw.length === 0)) {
    throw refusal(400, "schedule_invalid");
  }
  const rows: ScheduleRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw refusal(400, "schedule_invalid");
    const it = item as { label?: unknown; amount?: unknown; due?: unknown };
    if (typeof it.label !== "string") throw refusal(400, "schedule_invalid");
    const label = scrubText(it.label).text.trim();
    if (label === "" || label.length > MAX_LABEL) throw refusal(400, "schedule_invalid");
    const amount = canonicalAmount(it.amount);
    if (amount === null) throw refusal(400, "schedule_invalid");
    let dueKind: ScheduleRow["dueKind"];
    let dueOn: string | null = null;
    if (it.due === "on_signing") {
      dueKind = "on_signing";
    } else if (isIsoDate(it.due)) {
      dueKind = "date";
      dueOn = it.due;
    } else {
      throw refusal(400, "schedule_invalid");
    }
    rows.push({ label, amount, dueKind, dueOn });
  }
  let lastDate: string | null = null;
  rows.forEach((r, i) => {
    if (r.dueKind === "on_signing") {
      if (i !== 0) throw refusal(400, "schedule_order_invalid");
      return;
    }
    if (lastDate !== null && (r.dueOn as string) < lastDate) throw refusal(400, "schedule_order_invalid");
    lastDate = r.dueOn;
  });
  return rows;
}

/** True when no amount has more decimals than the currency allows. */
export function precisionOk(rows: ScheduleRow[], minorUnit: number): boolean {
  return rows.every((r) => decimalsOf(r.amount) <= minorUnit);
}

/** The currency's minor unit, or null when `finance_currencies` (global reference data, no RLS) does not know it. */
export async function minorUnitOf(c: PoolClient, currency: string): Promise<number | null> {
  const r = await c.query<{ mu: number }>(`SELECT minor_unit::int AS mu FROM finance_currencies WHERE code = $1`, [currency]);
  return r.rows[0] ? Number(r.rows[0].mu) : null;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// SQL fragments shared by the reads
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** A signed, live version of the contract `k` supersedes it (§61.1 row 6: its instalments stop being billable). */
export const supersededBySignedSql = (k: string) =>
  `EXISTS (SELECT 1 FROM contracts s WHERE s.tenant_id = ${k}.tenant_id AND s.supersedes_id = ${k}.id
              AND s.status = 'signed' AND s.deleted_at IS NULL)`;

/** When an instalment is due: its date, or the signed date for an `on_signing` one (NULL until signed). */
export const effectiveDueSql = (ci: string, k: string) =>
  `(CASE WHEN ${ci}.due_kind = 'on_signing' THEN ${k}.signed_at::date ELSE ${ci}.due_on END)`;

/** The staff state of §61.3. `inv` is the claiming invoice (LEFT JOINed on `ci.invoice_id`); `dueBy` a date expression. */
export function instalmentStateSql(ci: string, k: string, inv: string, dueBy: string): string {
  return `(CASE
      WHEN ${inv}.id IS NOT NULL AND ${inv}.status IN ('draft', 'approved') THEN 'invoicing'
      WHEN ${inv}.id IS NOT NULL AND ${inv}.status = 'paid' THEN 'paid'
      WHEN ${inv}.id IS NOT NULL THEN 'invoiced'
      WHEN ${k}.deleted_at IS NULL AND ${k}.status IN ('draft', 'sent') THEN 'scheduled'
      WHEN ${k}.deleted_at IS NOT NULL OR ${k}.status <> 'signed' OR ${supersededBySignedSql(k)} THEN 'not_billed'
      WHEN ${ci}.due_kind = 'on_signing' OR ${ci}.due_on <= ${dueBy} THEN 'due'
      ELSE 'upcoming'
    END)`;
}

/** Why a `not_billed` instalment is not billed: `superseded`, `deleted`, or the contract's status (void, declined, expired). */
export function notBilledReasonSql(k: string): string {
  return `(CASE WHEN ${supersededBySignedSql(k)} THEN 'superseded'
                WHEN ${k}.deleted_at IS NOT NULL THEN 'deleted'
                ELSE ${k}.status END)`;
}

/** The state half of §61.4a's rule, for the contract reads: signed, a value above zero, no schedule, not superseded. */
export const scheduleAddableSql = (k: string) =>
  `COALESCE(${k}.status = 'signed' AND ${k}.deleted_at IS NULL AND ${k}.value > 0 AND ${k}.schedule_sha256 IS NULL
     AND ${k}.schedule_added_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM contract_instalments x WHERE x.contract_id = ${k}.id AND x.tenant_id = ${k}.tenant_id)
     AND NOT ${supersededBySignedSql(k)}, false)`;

/** Columns a contract list/detail SELECT adds for `scheduleSummary` (stripped again by `withScheduleSummary`). */
export const scheduleSummaryColumnsSql = (k: string) => `
  (SELECT count(*)::int FROM contract_instalments x WHERE x.contract_id = ${k}.id AND x.tenant_id = ${k}.tenant_id) AS "_schedCount",
  (SELECT COALESCE(sum(x.amount), 0)::float8 FROM contract_instalments x WHERE x.contract_id = ${k}.id AND x.tenant_id = ${k}.tenant_id) AS "_schedTotal",
  (SELECT CASE WHEN COALESCE(${k}.value, 0) > 0
               THEN count(*) > 0 AND COALESCE(sum(x.amount), 0) = ${k}.value
               ELSE count(*) = 0 END
     FROM contract_instalments x WHERE x.contract_id = ${k}.id AND x.tenant_id = ${k}.tenant_id) AS "_schedMatches",
  ${scheduleAddableSql(k)} AS "scheduleAddable"`;

/** Folds the hidden summary columns into `scheduleSummary: {count, total, matchesValue} | null`. */
export function withScheduleSummary<T extends object>(row: T) {
  const { _schedCount, _schedTotal, _schedMatches, ...rest } = row as T & { _schedCount?: number; _schedTotal?: number; _schedMatches?: boolean };
  const count = Number(_schedCount ?? 0);
  return {
    ...rest,
    scheduleSummary: count > 0 ? { count, total: Number(_schedTotal ?? 0), matchesValue: _schedMatches === true } : null,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Reads
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export interface StaffSchedule {
  currency: string;
  value: number | null;
  total: number;
  matchesValue: boolean;
  scheduleSha256: string | null;
  addedAfterSigning: { at: string; by: { id: string; name: string | null } } | null;
  instalments: Array<{
    id: string; position: number; label: string; amount: number;
    due: { kind: "on_signing" | "date"; on: string | null };
    state: string;
    notBilledReason: string | null;
    invoice: { id: string; invoiceNo: string | null; status: string } | null;
  }>;
}

/** The staff `schedule` object of §61.4, or null when the contract has no instalments. `c` is any tenant transaction.
 *  `emptyAsObject` (the PUT's answer after a clear): an object with no instalments instead of null. */
export async function readStaffSchedule(
  c: PoolClient, contractId: string, opts: { emptyAsObject?: boolean } = {},
): Promise<StaffSchedule | null> {
  const head = await c.query<{
    currency: string; value: number | null; total: number; n: number; matches: boolean; sha: string | null;
    addedAt: Date | null; addedById: string | null; addedByName: string | null;
  }>(
    `SELECT k.currency, k.value::float8 AS value, COALESCE(sum(ci.amount), 0)::float8 AS total, count(ci.id)::int AS n,
            CASE WHEN COALESCE(k.value, 0) > 0 THEN count(ci.id) > 0 AND COALESCE(sum(ci.amount), 0) = k.value
                 ELSE count(ci.id) = 0 END AS matches,
            k.schedule_sha256 AS sha, k.schedule_added_at AS "addedAt", k.schedule_added_by AS "addedById", u.name AS "addedByName"
       FROM contracts k
       LEFT JOIN contract_instalments ci ON ci.contract_id = k.id AND ci.tenant_id = k.tenant_id
       LEFT JOIN users u ON u.id = k.schedule_added_by
      WHERE k.id = $1
      GROUP BY k.id, u.name`,
    [contractId],
  );
  const h = head.rows[0];
  if (!h || (Number(h.n) === 0 && !opts.emptyAsObject)) return null;
  const rows = await c.query<StaffSchedule["instalments"][number] &{ dueKind: "on_signing" | "date"; dueOn: string | null; invId: string | null; invNo: string | null; invStatus: string | null }>(
    `SELECT ci.id, ci.position::int AS position, ci.label, ci.amount::float8 AS amount, ci.due_kind AS "dueKind",
            to_char(${effectiveDueSql("ci", "k")}, 'YYYY-MM-DD') AS "dueOn",
            ${instalmentStateSql("ci", "k", "inv", "current_date")} AS state,
            CASE WHEN ${instalmentStateSql("ci", "k", "inv", "current_date")} = 'not_billed' THEN ${notBilledReasonSql("k")} END AS "notBilledReason",
            inv.id AS "invId", inv.invoice_no AS "invNo", inv.status AS "invStatus"
       FROM contract_instalments ci
       JOIN contracts k ON k.id = ci.contract_id AND k.tenant_id = ci.tenant_id
       LEFT JOIN invoices inv ON inv.id = ci.invoice_id AND inv.tenant_id = ci.tenant_id
      WHERE ci.contract_id = $1
      ORDER BY ci.position`,
    [contractId],
  );
  return {
    currency: h.currency,
    value: h.value === null ? null : Number(h.value),
    total: Number(h.total),
    matchesValue: h.matches === true,
    scheduleSha256: h.sha,
    addedAfterSigning: h.addedAt && h.addedById
      ? { at: new Date(h.addedAt).toISOString(), by: { id: h.addedById, name: h.addedByName } }
      : null,
    instalments: rows.rows.map((r) => ({
      id: r.id, position: Number(r.position), label: r.label, amount: Number(r.amount),
      due: { kind: r.dueKind, on: r.dueOn },
      state: r.state,
      notBilledReason: r.notBilledReason ?? null,
      invoice: r.invId ? { id: r.invId, invoiceNo: r.invNo, status: r.invStatus as string } : null,
    })),
  };
}

export interface PortalSchedule {
  currency: string;
  total: number;
  scheduleSha256: string | null;
  addedAfterSigning: { on: string } | null;
  instalments: Array<{
    position: number; label: string; amount: number;
    due: { kind: "on_signing" | "date"; on: string | null };
    state: string;
    invoice: { id: string; invoiceNo: string | null } | null;
  }>;
}

/** The portal's `schedule` (§61.6), or null. The caller has ALREADY admitted the contract through the portal scope
 *  (`ownedContract`); this reads only that contract's rows. Never an instalment id, a claim time, who added it, or an
 *  unissued invoice: `invoice` is set only for a client-visible (issued) claiming invoice, and `invoicing` reads `due`. */
export async function readPortalSchedule(c: PoolClient, contractId: string): Promise<PortalSchedule | null> {
  const head = await c.query<{ currency: string; total: number; n: number; sha: string | null; addedOn: string | null }>(
    `SELECT k.currency, COALESCE(sum(ci.amount), 0)::float8 AS total, count(ci.id)::int AS n, k.schedule_sha256 AS sha,
            to_char(k.schedule_added_at, 'YYYY-MM-DD') AS "addedOn"
       FROM contracts k
       LEFT JOIN contract_instalments ci ON ci.contract_id = k.id AND ci.tenant_id = k.tenant_id
      WHERE k.id = $1
      GROUP BY k.id`,
    [contractId],
  );
  const h = head.rows[0];
  if (!h || Number(h.n) === 0) return null;
  const rows = await c.query<{ position: number; label: string; amount: number; dueKind: "on_signing" | "date"; dueOn: string | null; state: string; invId: string | null; invNo: string | null }>(
    `SELECT ci.position::int AS position, ci.label, ci.amount::float8 AS amount, ci.due_kind AS "dueKind",
            to_char(${effectiveDueSql("ci", "k")}, 'YYYY-MM-DD') AS "dueOn",
            ${instalmentStateSql("ci", "k", "inv", "current_date")} AS state,
            CASE WHEN inv.issued_at IS NOT NULL AND inv.deleted_at IS NULL AND inv.status IN ('sent', 'paid') THEN inv.id END AS "invId",
            CASE WHEN inv.issued_at IS NOT NULL AND inv.deleted_at IS NULL AND inv.status IN ('sent', 'paid') THEN inv.invoice_no END AS "invNo"
       FROM contract_instalments ci
       JOIN contracts k ON k.id = ci.contract_id AND k.tenant_id = ci.tenant_id
       LEFT JOIN invoices inv ON inv.id = ci.invoice_id AND inv.tenant_id = ci.tenant_id
      WHERE ci.contract_id = $1
      ORDER BY ci.position`,
    [contractId],
  );
  return {
    currency: h.currency,
    total: Number(h.total),
    scheduleSha256: h.sha,
    addedAfterSigning: h.addedOn ? { on: h.addedOn } : null,
    instalments: rows.rows.map((r) => ({
      position: Number(r.position), label: r.label, amount: Number(r.amount),
      due: { kind: r.dueKind, on: r.dueOn },
      // §61.3's portal column: an unissued invoice is never shown, so `invoicing` reads as `due`.
      state: r.state === "invoicing" ? "due" : r.state,
      invoice: r.invId ? { id: r.invId, invoiceNo: r.invNo } : null,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Writes
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Insert `rows` as positions 1 to N. The guard trigger decides whether the contract admits them (PD610). */
async function insertRows(c: PoolClient, tenantId: string, contractId: string, rows: ScheduleRow[]): Promise<void> {
  for (const [i, r] of rows.entries()) {
    await c.query(
      `INSERT INTO contract_instalments (id, tenant_id, contract_id, position, label, amount, due_kind, due_on)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8::date)`,
      [newId(), tenantId, contractId, i + 1, r.label, r.amount, r.dueKind, r.dueOn],
    );
  }
}

/** The sum of `rows` and whether it equals `value`, computed in SQL numeric. */
async function sumRows(c: PoolClient, rows: ScheduleRow[], value: string | null): Promise<{ total: string; equals: boolean }> {
  const r = await c.query<{ total: string; equals: boolean }>(
    `SELECT COALESCE(sum(a::numeric), 0)::text AS total,
            COALESCE(COALESCE(sum(a::numeric), 0) = $2::numeric, false) AS equals
       FROM unnest($1::text[]) AS a`,
    [rows.map((x) => x.amount), value],
  );
  return r.rows[0];
}

/** The currency and precision refusals shared by both writes (§61.4's order: currency, then precision). */
async function checkCurrencyAndPrecision(c: PoolClient, currency: string, rows: ScheduleRow[]): Promise<void> {
  if (rows.length === 0) return;
  const mu = await minorUnitOf(c, currency);
  if (mu === null) throw refusal(400, "currency_unknown");
  if (!precisionOk(rows, mu)) throw refusal(400, "schedule_precision");
}

/**
 * `PUT contracts/:contractId/schedule` (§61.4): replace a DRAFT's whole schedule in the caller's transaction.
 * Refusals in order (after `contract` `update`): 404 `contract_not_found`, 409 `schedule_frozen`, 400 `schedule_invalid`,
 * `schedule_order_invalid`, `currency_unknown`, `schedule_precision`, `schedule_needs_value`.
 */
export async function replaceDraftSchedule(
  c: PoolClient, tenantId: string, contractId: string, body: unknown,
): Promise<{ count: number; total: string }> {
  // FOR UPDATE: serialises with the send (which locks the same row) and with a concurrent PUT.
  const cur = await c.query<{ status: string; value: string | null; valued: boolean; currency: string }>(
    `SELECT status, value::text AS value, COALESCE(value > 0, false) AS valued, currency
       FROM contracts WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [contractId, tenantId],
  );
  const k = cur.rows[0];
  if (!k) throw refusal(404, "contract_not_found");
  if (k.status !== "draft") throw refusal(409, "schedule_frozen");
  const rows = parseScheduleBody(body, { requireOne: false });
  await checkCurrencyAndPrecision(c, k.currency, rows);
  if (rows.length > 0 && !k.valued) throw refusal(400, "schedule_needs_value");
  await c.query(`DELETE FROM contract_instalments WHERE contract_id = $1 AND tenant_id = $2`, [contractId, tenantId]);
  await insertRows(c, tenantId, contractId, rows);
  const s = await sumRows(c, rows, k.value);
  return { count: rows.length, total: s.total };
}

/**
 * `POST contracts/:contractId/schedule/after-signing` (§61.4a, DW-D49), the database half, in the caller's transaction.
 * The handler has already run both authorizations and the envelope refusal. Refusals in order: 404 `contract_not_found`,
 * 409 `contract_not_signed`, `contract_closed`, `contract_superseded`, `schedule_exists`, 400 `schedule_needs_value`,
 * `schedule_invalid`, `schedule_order_invalid`, `currency_unknown`, `schedule_precision`, `schedule_total_mismatch`.
 * Then the addition's three statements: open, insert, close. The deferred trigger checks completeness at COMMIT.
 */
export async function addScheduleAfterSigning(
  c: PoolClient, tenantId: string, contractId: string, actorId: string, body: unknown,
): Promise<{ count: number; total: string; scheduleSha256: string; clientId: string }> {
  // 1. Lock the contract and check every rule again on the locked row. A concurrent addition waits here and then reads the
  //    committed one (schedule_exists).
  const cur = await c.query<{
    status: string; value: string | null; valued: boolean; currency: string; clientId: string;
    scheduleSha256: string | null; addedAt: Date | null; hasRows: boolean; superseded: boolean;
  }>(
    `SELECT k.status, k.value::text AS value, COALESCE(k.value > 0, false) AS valued, k.currency, k.client_id AS "clientId",
            k.schedule_sha256 AS "scheduleSha256", k.schedule_added_at AS "addedAt",
            EXISTS (SELECT 1 FROM contract_instalments x WHERE x.contract_id = k.id AND x.tenant_id = k.tenant_id) AS "hasRows",
            ${supersededBySignedSql("k")} AS superseded
       FROM contracts k WHERE k.id = $1 AND k.tenant_id = $2 AND k.deleted_at IS NULL FOR UPDATE OF k`,
    [contractId, tenantId],
  );
  const k = cur.rows[0];
  if (!k) throw refusal(404, "contract_not_found");
  if (k.status === "draft" || k.status === "sent") throw refusal(409, "contract_not_signed");
  if (k.status !== "signed") throw refusal(409, "contract_closed");
  if (k.superseded) throw refusal(409, "contract_superseded");
  if (k.scheduleSha256 || k.addedAt || k.hasRows) throw refusal(409, "schedule_exists");
  if (!k.valued) throw refusal(400, "schedule_needs_value");
  const rows = parseScheduleBody(body, { requireOne: true });
  await checkCurrencyAndPrecision(c, k.currency, rows);
  const s = await sumRows(c, rows, k.value);
  if (!s.equals) throw refusal(400, "schedule_total_mismatch", { value: Number(k.value), total: Number(s.total) });

  // 2. Open. 3. Insert (the guard admits rows only while the addition is open). 4. Close with the one hash function.
  await c.query(
    `UPDATE contracts SET schedule_added_at = now(), schedule_added_by = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [contractId, tenantId, actorId],
  );
  await insertRows(c, tenantId, contractId, rows);
  const closed = await c.query<{ sha: string }>(
    `UPDATE contracts SET schedule_sha256 = contract_schedule_sha256(id, currency, value), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING schedule_sha256 AS sha`,
    [contractId, tenantId],
  );
  return { count: rows.length, total: s.total, scheduleSha256: closed.rows[0].sha, clientId: k.clientId };
}

/** The caller must be a known user (the addition records who; `schedule_added_by` references users). */
export function requireActor(userId: string | null | undefined): string {
  if (!userId) throw new ForbiddenException("adding a schedule needs a known user");
  return userId;
}

/** Maps §61's database codes on the schedule routes to the answers §61 names. Anything else is rethrown. */
export async function mapScheduleDbErrors<T>(p: Promise<T>, route: "put" | "send" | "after_signing"): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof DatabaseError) {
      switch (e.code) {
        case "PD610":
          // A fixed schedule: the PUT's answer; on the addition, the guard refusing a row means the addition did not hold.
          throw refusal(409, route === "after_signing" ? "schedule_changed" : "schedule_frozen");
        case "PD612":
          throw refusal(400, "schedule_total_mismatch");
        case "PD613":
        case "PD618":
          // §61.4a: a step the database refused, for example a second addition racing this one (a racing second opening
          // reaches the database as a change of schedule_added_at, PD613). Nothing was written.
          if (route === "after_signing") throw refusal(409, "schedule_changed");
          throw refusal(409, "contract_terms_frozen");
        case "40001":
        case "40P01":
          throw refusal(409, route === "after_signing" ? "schedule_changed" : "conflict");
        default:
          break;
      }
    }
    throw e;
  }
}
