// IAM-GAP-02 (2026-08-13) — invoice revision tracking. Owner's words: "draft need to track the
// maker and the last person who make changes and the changes itself. so we can have proper
// version control and able to identify and have forensic capabilities."
//
// SNAPSHOT, not diff — deliberately. A diff-based design (store only what changed) requires
// replaying every prior revision in order to answer "what did this row look like before edit N",
// so a single missing/corrupt revision breaks reconstruction for every edit AFTER it, forever. A
// full before/after SNAPSHOT per mutation is self-contained: any one revision row answers "what
// did it look like before" and "what did it look like after" with no dependency on any other row
// in the table. The storage cost (a few KB of JSON per mutation, on a table that gets maybe a
// handful of writes per invoice's lifetime) is trivial next to what a broken forensic chain would
// cost. `changed_fields` is a derived, human-skimmable convenience computed FROM the two snapshots
// — it is never the source of truth and is never used to reconstruct state.
//
// Shared by every write path that mutates `invoices` — see each call site for which one:
//   - src/modules/invoice/invoice.controller.ts: create() / setStatus() / approve()
//   - src/core/contracts.controller.ts: decidePayment() (the ONLY other place invoices.status
//     moves — 'sent' -> 'paid' once the confirmed payment ledger covers the total)
// `src/seed/agency.ts` and `src/seed/portal-workspace.ts` insert invoices directly with no
// authenticated principal (dev/test bootstrap data, not a live mutation path) — deliberately NOT
// wired here; see the IAM-GAP-02 report for why fabricating an actor for a seed row would be worse
// than an honest gap.
import type { PoolClient } from "pg";
import { newId } from "../../db";

/** Raw-row snapshot (the TABLE's own columns, not the joined API projection `INVOICE_SELECT`
 *  produces) — forensics needs the actual persisted state, not a view shaped for the UI. */
export interface InvoiceSnapshot {
  id: string;
  tenantId: string;
  clientId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  status: string;
  currency: string;
  lines: unknown;
  total: string;
  originSite: string;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

const SNAPSHOT_KEYS: Array<keyof InvoiceSnapshot> = [
  "id", "tenantId", "clientId", "periodStart", "periodEnd", "status", "currency", "lines", "total",
  "originSite", "createdBy", "approvedBy", "approvedAt", "updatedBy", "createdAt", "updatedAt", "deletedAt",
];

/** Reads the invoice's CURRENT full row state. Returns null if the row doesn't exist (the caller
 *  decides whether that's an error — e.g. a snapshot taken immediately after an UPDATE whose
 *  WHERE clause matched zero rows). Deliberately does NOT filter on `deleted_at IS NULL` — a
 *  revision must be able to snapshot a row in any state, including a hypothetical future delete. */
export async function snapshotInvoice(c: PoolClient, invoiceId: string): Promise<InvoiceSnapshot | null> {
  const r = await c.query<{
    id: string; tenant_id: string; client_id: string | null; period_start: string | null; period_end: string | null;
    status: string; currency: string; lines: unknown; total: string; origin_site: string;
    created_by: string | null; approved_by: string | null; approved_at: string | null; updated_by: string | null;
    created_at: string; updated_at: string; deleted_at: string | null;
  }>(
    `SELECT id, tenant_id, client_id, period_start, period_end, status, currency, lines, total::text AS total,
            origin_site, created_by, approved_by, approved_at, updated_by, created_at, updated_at, deleted_at
       FROM invoices WHERE id = $1`,
    [invoiceId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, tenantId: row.tenant_id, clientId: row.client_id, periodStart: row.period_start,
    periodEnd: row.period_end, status: row.status, currency: row.currency, lines: row.lines, total: row.total,
    originSite: row.origin_site, createdBy: row.created_by, approvedBy: row.approved_by, approvedAt: row.approved_at,
    updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
  };
}

function changedFields(before: InvoiceSnapshot | null, after: InvoiceSnapshot): string[] {
  if (!before) return [...SNAPSHOT_KEYS]; // creation: every field is "new"
  return SNAPSHOT_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

/**
 * Records one revision row: the AFTER state is read fresh from the DB (never trusted from the
 * caller, so a bug in the caller's in-memory bookkeeping can't produce a false forensic record),
 * `before` must be the snapshot the caller took BEFORE running its mutation (null for a create).
 * Runs inside the SAME transaction as the mutation it documents (call this before `withTenants`'s
 * `fn` returns), so a mutation and its revision row can never diverge — either both commit or
 * both roll back together.
 */
export async function recordInvoiceRevision(
  c: PoolClient,
  tenantId: string,
  invoiceId: string,
  // Nullable to mirror `writeActivity`'s own `actorId: string | null` convention (`Principal.userId`
  // is `string | null` — "null = unknown external identity", principal.ts's own comment). Every
  // LIVE call site in this codebase authorizes through Cerbos first, which in practice means a real
  // uuid by the time a mutation reaches here — but the type is honest about what's actually known
  // at the call site rather than asserting a non-null the compiler can't verify.
  actorId: string | null,
  action: string,
  before: InvoiceSnapshot | null,
): Promise<void> {
  const after = await snapshotInvoice(c, invoiceId);
  if (!after) throw new Error(`invoice-revisions: cannot snapshot ${invoiceId} after ${action} — row not found`);
  await c.query(
    `INSERT INTO invoice_revisions
       (id, tenant_id, invoice_id, actor_id, action, before_snapshot, after_snapshot, changed_fields, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      newId(), tenantId, invoiceId, actorId, action,
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
      changedFields(before, after),
    ],
  );
}
