// PV7-04a — client reports: the ONE place a report is published to a client (docs/FRONTEND-BFF-CONTRACT.md §55;
// plan docs/plans/2026-10-15-pv7-performance-views-tickets.md, ticket PV7-04, findings 5 and 6).
//
// ── WHO CALLS THIS ─────────────────────────────────────────────────────────────────────────────────────
//   * social `deliver` (modules/social/social-reports.controller.ts) and search `deliver`
//     (modules/search/search-reports.controller.ts): IN THE SAME TRANSACTION as the delivery, so a delivered report and
//     its client report commit together or not at all. Those handlers run under their module's scope; `client_reports`
//     and `files` are core tables (no module predicate), so the module GUC changes nothing here.
//   * the backfill ops tool (ops/client-reports-backfill.ts), for reports delivered before this ticket.
//   * the staff publish route (modules/clients/client-reports.controller.ts) uses `announceClientReportPublished` only.
//
// ── THE FILE IS THE REPORT'S OWN ───────────────────────────────────────────────────────────────────────
// The client report gets its OWN `files` row (role `client_report_file`, target `client_report`, the same bytes and sha256 as
// the module's file) stored under its OWN storage key. It deliberately does not share the module file's storage key: the staff
// DELETE /files/:id route removes the bytes behind a deleted row, so a shared key would let a deleted module file take the
// client's copy with it. The role makes the row a record (trg_files_guard_role_file): never deleted, moved or changed.
//
// ── IDEMPOTENT ─────────────────────────────────────────────────────────────────────────────────────────
// One client report per module report, ever: a transaction-scoped advisory lock on (tenant, source, source id), then "is
// there already a row for this source, in any status". A withdrawn report counts: it was taken back on purpose, and neither a
// re-delivery nor the backfill may bring it back. The partial UNIQUE index (live rows) is the database's backstop.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { storage } from "./storage";
import { sha256Hex } from "./content-hash";
import { emitEvent } from "../events/outbox.service";
import { notifyBestEffort, resolveClientRecipients } from "./client-notify";

/** The `files.role` of a client report's file (migration 202610151720). Not `_pdf`: search reports are Markdown. */
export const CLIENT_REPORT_FILE_ROLE = "client_report_file";
/** The `files.target_entity_type` (and outbox entity type) of a client report. */
export const CLIENT_REPORT_ENTITY = "client_report";
/** `newReports` on the portal overview counts reports published within this many days and not yet opened. */
export const NEW_REPORT_WINDOW_DAYS = 30;

export type ClientReportSource = "social_report" | "search_report" | "account_summary";
export type ClientReportStatus = "draft" | "published" | "withdrawn";

/** The bytes of a client report's file, already in storage under the report's own key. */
export interface StoredReportFile {
  fileId: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  filename: string;
  contentType: string;
}

/** Store the bytes under a fresh key. Called BEFORE the database transaction (storage is not transactional), exactly as the
 *  modules store their own file; if the transaction then finds an existing client report, the caller discards the blob with
 *  `discardStoredReportFile`. */
export async function storeClientReportFile(tenantId: string, bytes: Buffer, filename: string, contentType: string): Promise<StoredReportFile> {
  const fileId = newId();
  const storageKey = `${tenantId}/client-reports/${fileId}`;
  await storage().put(storageKey, bytes);
  return { fileId, storageKey, sha256: sha256Hex(bytes), byteSize: bytes.byteLength, filename, contentType };
}

/** Remove a stored blob that no row references (the idempotent path found an existing report). Best effort. */
export async function discardStoredReportFile(file: StoredReportFile): Promise<void> {
  try {
    await storage().del(file.storageKey);
  } catch (err) {
    console.error(`[client-reports] could not discard unused blob ${file.storageKey}:`, (err as Error)?.message ?? err);
  }
}

export interface DeliveredReportInput {
  tenantId: string;
  source: "social_report" | "search_report";
  sourceId: string;
  clientId: string;
  /** The engagement's project, or null for a client-wide report. Must be the client's own project (composite FK). */
  projectId: string | null;
  deliverableId: string | null;
  title: string;
  periodStart: string;
  periodEnd: string;
  file: StoredReportFile;
  /** Who published it: the person who delivered (or, in the backfill, the delivery's recorded uploader or approver). */
  publishedBy: string;
  /** When: now() for a delivery; the module's `delivered_at` in the backfill. */
  publishedAt?: string | null;
  /** Emit `client_report.published` (the portal's `reports` SSE topic). False for the backfill: history, not news. */
  announce: boolean;
}

export interface PublishedClientReport {
  id: string;
  /** False when a client report for this source already existed (nothing was written). */
  created: boolean;
  clientId: string;
  projectId: string | null;
  title: string;
}

/** Insert the `published` client report of a delivered module report, with its own role file. `c` is the caller's
 *  transaction (the delivery's own). Idempotent per (tenant, source, source id): see the file header. */
export async function publishDeliveredReport(c: PoolClient, input: DeliveredReportInput): Promise<PublishedClientReport> {
  const { tenantId, source, sourceId } = input;
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`client_report:${tenantId}:${source}:${sourceId}`]);
  const existing = await c.query<{ id: string; client_id: string; project_id: string | null; title: string }>(
    `SELECT id, client_id, project_id, title FROM client_reports
      WHERE tenant_id = $1 AND source = $2 AND source_id = $3
      ORDER BY created_at ASC LIMIT 1`,
    [tenantId, source, sourceId],
  );
  if (existing.rows[0]) {
    const e = existing.rows[0];
    return { id: e.id, created: false, clientId: e.client_id, projectId: e.project_id, title: e.title };
  }

  const id = newId();
  const f = input.file;
  // The file first: the report's `file_id` is a foreign key to it. The file's target is the report id chosen above.
  await c.query(
    `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size,
                        storage_key, sha256, scrubbed, origin_site, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12)`,
    [f.fileId, tenantId, input.publishedBy, CLIENT_REPORT_ENTITY, id, f.filename, f.contentType, f.byteSize, f.storageKey, f.sha256,
     config.originSite, CLIENT_REPORT_FILE_ROLE],
  );
  await c.query(
    `INSERT INTO client_reports (id, tenant_id, client_id, project_id, source, source_id, deliverable_id, title,
                                 period_start, period_end, file_id, status, published_at, published_by, created_by, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, 'published', COALESCE($12::timestamptz, now()), $13, $13, $14)`,
    [id, tenantId, input.clientId, input.projectId, source, sourceId, input.deliverableId, input.title,
     input.periodStart, input.periodEnd, f.fileId, input.publishedAt ?? null, input.publishedBy, config.originSite],
  );
  if (input.announce) {
    await emitEvent(c, tenantId, CLIENT_REPORT_ENTITY, id, "client_report.published", {
      clientId: input.clientId, projectId: input.projectId, source,
    });
  }
  return { id, created: true, clientId: input.clientId, projectId: input.projectId, title: input.title };
}

/** Tell the client's contacts in reach that a report was published: one notification row each (BFF §55.5). Recipients are
 *  `resolveClientRecipients(.., kind "report")`: active contacts of the client who are client-wide or on the report's
 *  project, viewers included; for a client-wide report (no project) the client-wide contacts only, the portal's own reach
 *  rule. Best effort and AFTER the commit: a notice that fails must never undo a publication. No mail (the mailer is not
 *  wired for clients yet). */
export async function announceClientReportPublished(
  tenantId: string,
  actorId: string | null,
  report: { id: string; clientId: string; projectId: string | null; title: string },
): Promise<void> {
  try {
    const recipients = await withTenants([tenantId], (c) =>
      resolveClientRecipients(c, { clientId: report.clientId, projectId: report.projectId, kind: "report" }),
    );
    await notifyBestEffort(tenantId, actorId, recipients, "client_report.published", {
      title: `New report: ${report.title}`,
      href: "/portal/reports",
      entityType: CLIENT_REPORT_ENTITY,
      entityId: report.id,
      severity: "info",
    });
  } catch (err) {
    console.error(`[client-reports] notice for report ${report.id} failed:`, (err as Error)?.message ?? err);
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The title a delivered report is published under: what it is and which period, in plain words. Deterministic (no AI). */
export function deliveredReportTitle(source: "social_report" | "search_report", kind: string, period: string | null, start: string, end: string): string {
  const what =
    source === "social_report"
      ? kind === "campaign" ? "Social media campaign report" : "Social media report"
      : kind === "audit" ? "Search audit report" : "Search report";
  const m = period ? /^(\d{4})-(\d{2})$/.exec(period.trim()) : null;
  const month = m ? Number(m[2]) : 0;
  const when = m && month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${m[1]}` : `${start} to ${end}`;
  return `${what}, ${when}`;
}

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/;

/** SQL: the files row `fileAlias` is the report `reportAlias`'s OWN file: the row its `file_id` names, AND a live role file
 *  (`client_report_file`) whose target is that very report. Every read of a report's file (staff list, portal list, the
 *  publish check) goes through this, so a `file_id` pointed at any other file (another client's attachment, a module's own
 *  PDF) names nothing. The portal download route checks the same role and target itself (portal-commerce.controller.ts). */
export function clientReportFileOf(fileAlias: string, reportAlias: string): string {
  if (!ALIAS_RE.test(fileAlias) || !ALIAS_RE.test(reportAlias)) throw new Error("client-reports: invalid table alias");
  const f = fileAlias;
  const r = reportAlias;
  return `(${f}.id = ${r}.file_id AND ${f}.target_entity_type = '${CLIENT_REPORT_ENTITY}' AND ${f}.target_entity_id = ${r}.id`
    + ` AND ${f}.role = '${CLIENT_REPORT_FILE_ROLE}' AND ${f}.deleted_at IS NULL)`;
}
