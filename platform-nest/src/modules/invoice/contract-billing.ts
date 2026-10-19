// DW-10f-3a — invoices FROM THE SCHEDULE (FRONTEND-BFF-CONTRACT §61.5; rulings DW-D45, DW-D48).
//
// A signed contract's instalments are billed as fixed-fee lines (`kind: 'instalment'`, no hours, no rate). Each
// instalment is claimed by exactly ONE live invoice: `contract_instalments.invoice_id`, set in the draft's own
// transaction by `UPDATE … SET invoice_id = $inv WHERE id = ANY($ids) AND invoice_id IS NULL`. Fewer rows than asked is a
// lost race and rolls everything back as 409 `instalment_unavailable`, never a double bill. The database's guard (PD611)
// re-checks every claim against the invoice's own lines, and voiding or soft-deleting the invoice releases it (a trigger;
// the handlers only count what it will release).
//
// ── ONE SOURCE PER INVOICE (DW-D48) ─────────────────────────────────────────────────────────────────
// `POST invoices` takes `source: 'hours'` (the default: every existing caller) or `source: 'instalments'`. A body that
// names fields of both is refused (`source_fields_mixed`).
//
// ── MONEY ───────────────────────────────────────────────────────────────────────────────────────────
// The lines and the total are built in SQL from the instalment rows (`jsonb_build_object(… 'amount', trim_scale(amount))`,
// `sum(amount)`), so the line amount the guard compares is the row's own numeric, never a JS float.
//
// ── LOCKS ───────────────────────────────────────────────────────────────────────────────────────────
// The chosen instalments are locked FOR UPDATE in id order (two drafts over overlapping sets cannot deadlock), checked on
// the locked rows, then claimed. A draft that waited behind another re-reads the committed claim and is refused (or, for
// an identical body, answers that draft: the replay rule).
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { DatabaseError, type PoolClient } from "pg";
import { newId } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import { recordInvoiceRevision } from "./invoice-revisions";
import { withBilling } from "./issue";
import { effectiveDueSql, instalmentStateSql, isIsoDate, supersededBySignedSql } from "../../core/contract-schedule";

export const UUID_ANY_CASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** At most this many instalments on one draft (§61.5). */
export const MAX_DRAFT_INSTALMENTS = 60;
/** At most this many rows in the billable read (§61.5). */
export const MAX_BILLABLE_ROWS = 500;
/** The tax code shape `POST invoices` has always accepted. */
const TAX_CODE = /^[A-Za-z0-9_.-]{1,32}$/;

function bad(code: string, detail?: Record<string, unknown>): BadRequestException {
  return new BadRequestException({ message: code, reason: code, ...(detail ? { detail } : {}) });
}

export type UnavailableReason = "not_found" | "other_client" | "not_signed" | "superseded" | "not_due" | "already_invoiced";
export interface UnavailableItem { instalmentId: string; reason: UnavailableReason; invoiceId?: string }

/** 409 `instalment_unavailable` with `detail.items`. Nothing was written. */
export function instalmentUnavailable(items: UnavailableItem[]): ConflictException {
  return new ConflictException({ message: "instalment_unavailable", reason: "instalment_unavailable", detail: { items } });
}

/** Which source a `POST invoices` body asks for. 400 `source_invalid` for anything but the two. */
export function sourceOf(b: Record<string, unknown> | null | undefined): "hours" | "instalments" {
  const s = b?.source;
  if (s === undefined || s === null || s === "hours") return "hours";
  if (s === "instalments") return "instalments";
  throw bad("source_invalid");
}

export interface DraftFromScheduleInput {
  clientId: string;
  instalmentIds: string[];
  dueBy: string | null;
  taxCode: string | null;
}

/** The body of `POST invoices {source: 'instalments'}`, validated in §61.5's order (after `invoice` `create`). */
export function parseDraftFromSchedule(b: Record<string, unknown>): DraftFromScheduleInput {
  if (b.periodStart !== undefined || b.periodEnd !== undefined || b.rate !== undefined) throw bad("source_fields_mixed");
  const raw = b.instalmentIds;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DRAFT_INSTALMENTS
      || !raw.every((x) => typeof x === "string" && UUID_ANY_CASE.test(x))) {
    throw bad("instalment_ids_invalid");
  }
  const ids = (raw as string[]).map((x) => x.toLowerCase());
  if (new Set(ids).size !== ids.length) throw bad("instalment_ids_invalid");
  let dueBy: string | null = null;
  if (b.dueBy !== undefined && b.dueBy !== null) {
    if (!isIsoDate(b.dueBy)) throw bad("due_by_invalid");
    dueBy = b.dueBy;
  }
  let taxCode: string | null = null;
  if (b.taxCode !== undefined && b.taxCode !== null && !(typeof b.taxCode === "string" && b.taxCode.trim() === "")) {
    if (typeof b.taxCode !== "string" || !TAX_CODE.test(b.taxCode.trim())) throw bad("tax_code_invalid");
    taxCode = b.taxCode.trim();
  }
  // A missing or malformed client id names no live client: the same 404 as an unknown one (§61.5's `client_not_found`).
  const clientId = typeof b.clientId === "string" && UUID_ANY_CASE.test(b.clientId) ? b.clientId.toLowerCase() : "";
  return { clientId, instalmentIds: ids, dueBy, taxCode };
}

export interface DraftFromScheduleResult {
  id: string;
  source: "instalments";
  lineCount: number;
  total: number;
  currency: string;
  deduped?: true;
  /** For the activity row: the exact decimal total. */
  totalText: string;
}

/**
 * Draft an invoice from the chosen instalments, in ONE transaction under both walls (`withBilling`):
 *   1. lock the instalments with their contracts (FOR UPDATE OF ci, in id order);
 *   2. the replay rule, then check each one (this client; signed, live, unsuperseded; due by `dueBy`; unclaimed) and one
 *      currency;
 *   3. insert the invoice, its lines and total computed in SQL;
 *   4. claim: `UPDATE … SET invoice_id = $inv, claimed_at = now() WHERE id = ANY($ids) AND invoice_id IS NULL`; fewer
 *      rows than asked rolls everything back as 409;
 *   5. `invoice.created` (with `source` and `instalmentIds`) and the `created` revision.
 */
export async function draftInvoiceFromSchedule(
  tenantId: string, actorId: string | null, input: DraftFromScheduleInput,
): Promise<DraftFromScheduleResult> {
  return mapClaimErrors(withBilling(tenantId, async (c) => {
    if (!input.clientId) throw new NotFoundException({ message: "client_not_found", reason: "client_not_found" });
    const client = await c.query(
      `SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL AND NOT is_internal`, [input.clientId],
    );
    if (!client.rows[0]) throw new NotFoundException({ message: "client_not_found", reason: "client_not_found" });
    const dueBy = input.dueBy ?? (await c.query<{ d: string }>(`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`)).rows[0].d;

    // 1. Lock. Rows of another company are invisible (RLS) and read as `not_found`.
    const locked = await c.query<{
      id: string; clientId: string; currency: string; status: string; deleted: boolean; superseded: boolean;
      due: boolean; invoiceId: string | null;
    }>(
      `SELECT ci.id, k.client_id AS "clientId", k.currency, k.status, (k.deleted_at IS NOT NULL) AS deleted,
              ${supersededBySignedSql("k")} AS superseded,
              (ci.due_kind = 'on_signing' OR ci.due_on <= $2::date) AS due,
              ci.invoice_id AS "invoiceId"
         FROM contract_instalments ci
         JOIN contracts k ON k.id = ci.contract_id AND k.tenant_id = ci.tenant_id
        WHERE ci.id = ANY($1::uuid[])
        ORDER BY ci.id
        FOR UPDATE OF ci`,
      [input.instalmentIds, dueBy],
    );
    const byId = new Map(locked.rows.map((r) => [r.id, r]));

    // 2a. The replay rule (§61.5): every instalment claimed by ONE live, unissued invoice of this client whose instalment
    //     lines are exactly these ids answers that invoice, `deduped: true`.
    const claimers = new Set(locked.rows.map((r) => r.invoiceId));
    if (locked.rows.length === input.instalmentIds.length && claimers.size === 1 && !claimers.has(null)) {
      const invId = [...claimers][0] as string;
      const same = await c.query<{ id: string; lineCount: number; total: string; currency: string }>(
        `SELECT i.id, jsonb_array_length(i.lines)::int AS "lineCount", i.total::text AS total, i.currency
           FROM invoices i
          WHERE i.id = $1 AND i.client_id = $2 AND i.deleted_at IS NULL AND i.issued_at IS NULL
            AND i.status IN ('draft', 'approved')
            AND (SELECT array_agg(lower(e->>'instalmentId') ORDER BY lower(e->>'instalmentId'))
                   FROM jsonb_array_elements(i.lines) AS e WHERE e->>'kind' = 'instalment')
                = (SELECT array_agg(x ORDER BY x) FROM unnest($3::text[]) AS x)`,
        [invId, input.clientId, input.instalmentIds],
      );
      const hit = same.rows[0];
      if (hit) {
        return {
          id: hit.id, source: "instalments", lineCount: Number(hit.lineCount), total: Number(hit.total), currency: hit.currency,
          deduped: true, totalText: hit.total,
        };
      }
    }

    // 2b. Each instalment, on its locked row.
    const items: UnavailableItem[] = [];
    for (const id of input.instalmentIds) {
      const r = byId.get(id);
      if (!r) items.push({ instalmentId: id, reason: "not_found" });
      else if (r.clientId !== input.clientId) items.push({ instalmentId: id, reason: "other_client" });
      else if (r.status !== "signed" || r.deleted) items.push({ instalmentId: id, reason: "not_signed" });
      else if (r.superseded) items.push({ instalmentId: id, reason: "superseded" });
      else if (r.invoiceId) items.push({ instalmentId: id, reason: "already_invoiced", invoiceId: r.invoiceId });
      else if (!r.due) items.push({ instalmentId: id, reason: "not_due" });
    }
    if (items.length > 0) throw instalmentUnavailable(items);
    const currencies = new Set(locked.rows.map((r) => r.currency));
    if (currencies.size !== 1) throw bad("currency_mixed");
    const currency = [...currencies][0];

    // 3. The invoice: lines and total from the rows, in SQL. Lines run oldest due first.
    const invoiceId = newId();
    const ins = await c.query<{ lineCount: number; total: string }>(
      `WITH sel AS (
         SELECT ci.id, ci.position, ci.label, ci.amount, ci.contract_id, k.reference, k.title, k.project_id,
                (SELECT count(*) FROM contract_instalments x WHERE x.contract_id = ci.contract_id AND x.tenant_id = ci.tenant_id) AS cnt,
                ${effectiveDueSql("ci", "k")} AS eff_due
           FROM contract_instalments ci
           JOIN contracts k ON k.id = ci.contract_id AND k.tenant_id = ci.tenant_id
          WHERE ci.id = ANY($1::uuid[])
       )
       INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, currency, lines, total, origin_site,
                             created_by, updated_by, tax_code)
       SELECT $2, $3, $4, min(eff_due), max(eff_due), $5,
              jsonb_agg(jsonb_build_object(
                'kind', 'instalment',
                'description', left(concat_ws(' ', NULLIF(btrim(reference), ''), title) || ' · ' || label
                                    || ' (' || position || ' of ' || cnt || ')', 500),
                'contractId', contract_id,
                'instalmentId', id,
                'projectId', project_id,
                'amount', trim_scale(amount)
              ) ORDER BY eff_due NULLS LAST, reference NULLS LAST, contract_id, position),
              sum(amount), $6, $7, $7, $8
         FROM sel
       RETURNING jsonb_array_length(lines)::int AS "lineCount", total::text AS total`,
      [input.instalmentIds, invoiceId, tenantId, input.clientId, currency, config.originSite, actorId, input.taxCode],
    );

    // 4. The claim. A row claimed since step 1 cannot be (the lock), but the count is the guarantee, not the lock.
    const claim = await c.query(
      `UPDATE contract_instalments SET invoice_id = $1, claimed_at = now(), updated_at = now()
        WHERE id = ANY($2::uuid[]) AND invoice_id IS NULL`,
      [invoiceId, input.instalmentIds],
    );
    if ((claim.rowCount ?? 0) !== input.instalmentIds.length) {
      throw instalmentUnavailable(input.instalmentIds.map((id) => ({ instalmentId: id, reason: "already_invoiced" as const })));
    }

    // 5. Event (ids only beyond the existing fields) and revision #1, as the hourly draft does.
    const total = ins.rows[0].total;
    await emitEvent(c, tenantId, "invoice", invoiceId, "invoice.created", {
      clientId: input.clientId, total: Number(total), currency, source: "instalments", instalmentIds: input.instalmentIds,
    });
    await recordInvoiceRevision(c, tenantId, invoiceId, actorId, "created", null);
    return { id: invoiceId, source: "instalments", lineCount: Number(ins.rows[0].lineCount), total: Number(total), currency, totalText: total };
  }));
}

/** PD611 (a claim the guard refused: the contract voided or superseded under us) and serialisation failures are a lost
 *  race on the instalment: 409 `instalment_unavailable`, nothing written. */
async function mapClaimErrors<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof DatabaseError && (e.code === "PD611" || e.code === "40001" || e.code === "40P01")) {
      throw instalmentUnavailable([]);
    }
    throw e;
  }
}

/** How many instalments `invoiceId` claims: what voiding it will release (the trigger releases them). */
export async function claimedInstalmentCount(c: PoolClient, invoiceId: string): Promise<number> {
  const r = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM contract_instalments WHERE invoice_id = $1`, [invoiceId],
  );
  return Number(r.rows[0].n);
}

/**
 * `GET invoices/billable-instalments` (§61.5): the instalments of signed, live, unsuperseded contracts with no live
 * invoice (`due` or `upcoming` against `dueBy`), and those on an unissued draft (`invoicing`); oldest due first; at most
 * 500. Contracts and instalments are core tables (plain tenant wall), so a plain tenant transaction reads them.
 */
export async function readBillableInstalments(
  c: PoolClient, q: { dueBy: string; clientId: string | null },
): Promise<{ dueBy: string; items: unknown[] }> {
  const r = await c.query(
    `SELECT ci.id AS "instalmentId",
            json_build_object('id', cl.id, 'name', cl.name) AS client,
            json_build_object('id', k.id, 'title', k.title, 'reference', k.reference, 'kind', k.kind, 'projectId', k.project_id) AS contract,
            ci.position::int AS position,
            (SELECT count(*)::int FROM contract_instalments x WHERE x.contract_id = ci.contract_id AND x.tenant_id = ci.tenant_id) AS count,
            ci.label, ci.amount::float8 AS amount, k.currency,
            json_build_object('kind', ci.due_kind, 'on', to_char(${effectiveDueSql("ci", "k")}, 'YYYY-MM-DD')) AS due,
            ${instalmentStateSql("ci", "k", "inv", "$1::date")} AS state,
            CASE WHEN inv.id IS NULL THEN NULL ELSE json_build_object('id', inv.id, 'status', inv.status) END AS invoice
       FROM contract_instalments ci
       JOIN contracts k ON k.id = ci.contract_id AND k.tenant_id = ci.tenant_id
       JOIN clients cl ON cl.id = k.client_id AND cl.deleted_at IS NULL
       LEFT JOIN invoices inv ON inv.id = ci.invoice_id AND inv.tenant_id = ci.tenant_id
      WHERE k.status = 'signed' AND k.deleted_at IS NULL AND NOT ${supersededBySignedSql("k")}
        AND (ci.invoice_id IS NULL
             OR (inv.status IN ('draft', 'approved') AND inv.issued_at IS NULL AND inv.deleted_at IS NULL))
        AND ($2::uuid IS NULL OR k.client_id = $2::uuid)
      ORDER BY ${effectiveDueSql("ci", "k")} NULLS LAST, k.reference NULLS LAST, k.id, ci.position
      LIMIT ${MAX_BILLABLE_ROWS}`,
    [q.dueBy, q.clientId],
  );
  return { dueBy: q.dueBy, items: r.rows };
}

