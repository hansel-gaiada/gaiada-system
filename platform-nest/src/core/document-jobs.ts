// PV5-07 — the jobs that produce an issued invoice's PDF and a signed contract's sealed copy (plan decisions 19 and 21,
// ruling PV-D25). Each document is rendered ONCE, stored as a `files` row with a role and a SHA-256, and never
// re-rendered on download: a document must not change because a template did.
//
// ── WHEN THEY RUN ─────────────────────────────────────────────────────────────────────────────────
// After commit, never inside the issue or sign transaction: issuing and signing never wait on a PDF, and a missing
// renderer, key or library can never fail them.
//   * `invoice.issued` and `contract.signed` (outbox -> Redis -> the in-process consumer) run the job at once. Both are
//     CORE handlers (registerCoreEventHandler): documents are owed whatever modules a company has switched on.
//   * The sweep (startDocumentJobSweep) finds every document still owed, straight from the source tables (an issued
//     invoice with no live `invoice_pdf`, a signed contract with fixed content and no live `contract_signed_copy`), and
//     retries it on the backoff clock in `document_jobs`. It is what turns "renderer down for an hour" or "key mounted
//     tomorrow" into a document without anyone re-driving it, and it covers an event that was dead-lettered.
//
// ── IDEMPOTENT ────────────────────────────────────────────────────────────────────────────────────
// A job first looks for the live role file and stops if there is one. Two runs that race past that check both render,
// but `ux_files_live_role` (one live file per parent and role) lets exactly one INSERT through; the loser deletes the
// bytes it wrote and answers `exists`. A second run therefore never stores a second file.
//
// ── FAILURE IS RECORDED, NOT THROWN ───────────────────────────────────────────────────────────────
// An expected failure (no renderer, no sealing key, the attached document no longer matching what was signed, a render
// that came back as the wrong page) is written to `document_jobs` with a machine reason and words, and the document
// stays "being prepared" (the read fields answer null). An owner of the company is told ONCE per document: the
// `owner_notified_at IS NULL` claim is a single UPDATE, so retries and concurrent runs cannot notify twice. Only a
// failure to RECORD (the database itself) throws, so the bus redelivers the event.
//
// ── NEVER SHIPS UNSEALED ──────────────────────────────────────────────────────────────────────────
// The sealing key is loaded before anything is rendered; without it nothing is stored. The sealed bytes are verified
// against the stored certificate before they are stored. There is no code path that stores a contract copy without a
// seal that verified.
//
// ── CONTENT IS CHECKED BEFORE IT IS SEALED ────────────────────────────────────────────────────────
// The agreement must still be byte-for-byte what both parties signed: SHA-256 of the attached file's stored bytes (or
// of `body_md`) must equal `contracts.content_sha256`, and every signature must carry that same hash. Anything else is
// REFUSED (never sealed, not retried): sealing a different document would certify a lie.
import type { KeyObject } from "node:crypto";
import { DatabaseError } from "pg";
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { registerCoreEventHandler } from "../events/consumer.service";
import type { OutboxEvent } from "../events/types";
import { withBilling } from "../modules/invoice/issue";
import { notify, writeActivity } from "./http";
import { storage } from "./storage";
import { sha256Hex } from "./content-hash";
import {
  DocumentRenderError, documentRendererConfigured, newRenderNonce, renderDocumentPdf,
  type ContractPrintPayload, type InvoicePrintPayload,
} from "./document-render";
import {
  assembleContractPdf, certificateDer, certificateMatchesKey, finalizeRenderedPdf, isUsablePdf, loadSealPrivateKey,
  sealPdf, SealKeyError, verifySealedPdf,
} from "./document-seal";

export type DocumentRole = "invoice_pdf" | "contract_signed_copy";
type FailStatus = "blocked" | "failed" | "refused";

export type DocumentJobOutcome =
  | { status: "stored"; fileId: string }
  | { status: "exists"; fileId: string }
  /** Nothing is owed (the invoice is not issued, the contract is not signed, or the row is gone). */
  | { status: "skipped"; reason: string }
  | { status: FailStatus; reason: string };

const TARGET: Record<DocumentRole, "invoice" | "contract"> = { invoice_pdf: "invoice", contract_signed_copy: "contract" };

/** A failed (transient) job notifies an owner only once it has failed this many times; blocked and refused at once. */
export const NOTIFY_AFTER_FAILED_ATTEMPTS = 3;
const NOTIFICATION_TYPE = "document.preparation_blocked";

/** How a stuck document is announced: what it is and where staff look at it. */
interface Notice {
  what: string;
  href: string;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Shared plumbing
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** The live role file of a parent, if one exists. */
export async function liveRoleFile(tenantId: string, role: DocumentRole, entityId: string): Promise<string | null> {
  const r = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT id FROM files
        WHERE target_entity_type = $1 AND target_entity_id = $2 AND role = $3 AND deleted_at IS NULL
        LIMIT 1`,
      [TARGET[role], entityId, role],
    ),
  );
  return r.rows[0]?.id ?? null;
}

async function markStored(tenantId: string, role: DocumentRole, entityId: string, fileId: string): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO document_jobs (tenant_id, role, entity_id, status, file_id, last_error, last_attempt_at, next_attempt_at)
       VALUES ($1, $2, $3, 'stored', $4, NULL, now(), NULL)
       ON CONFLICT (tenant_id, role, entity_id) DO UPDATE
         SET status = 'stored', file_id = EXCLUDED.file_id, last_error = NULL, next_attempt_at = NULL, updated_at = now()`,
      [tenantId, role, entityId, fileId],
    ),
  );
}

/**
 * Record why a document is not there yet, set its retry clock, and tell the company's owners ONCE.
 *   blocked : configuration is missing; retried hourly (and at boot).
 *   failed  : transient; retried after 2, 4, 8 ... minutes, capped at 6 hours.
 *   refused : never retried automatically.
 */
async function recordFailure(
  tenantId: string, role: DocumentRole, entityId: string, status: FailStatus, reason: string, message: string,
  notice: Notice,
): Promise<DocumentJobOutcome> {
  const text = `${reason}: ${message}`.slice(0, 500);
  const notifyNow = await withTenants([tenantId], async (c) => {
    await c.query(
      `INSERT INTO document_jobs (tenant_id, role, entity_id, status, attempts, last_error, last_attempt_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, 1, $5, now(),
               CASE $4 WHEN 'refused' THEN NULL WHEN 'blocked' THEN now() + interval '1 hour' ELSE now() + interval '2 minutes' END)
       ON CONFLICT (tenant_id, role, entity_id) DO UPDATE
         SET status = EXCLUDED.status,
             attempts = document_jobs.attempts + 1,
             last_error = EXCLUDED.last_error,
             last_attempt_at = now(),
             next_attempt_at = CASE EXCLUDED.status
               WHEN 'refused' THEN NULL
               WHEN 'blocked' THEN now() + interval '1 hour'
               ELSE now() + make_interval(mins => LEAST(360, power(2, LEAST(document_jobs.attempts + 1, 9))::int))
             END,
             file_id = NULL,
             updated_at = now()`,
      [tenantId, role, entityId, status, text],
    );
    // The once-only claim: whoever flips owner_notified_at from NULL sends the notice; nobody else ever does.
    const claim = await c.query(
      `UPDATE document_jobs SET owner_notified_at = now()
        WHERE tenant_id = $1 AND role = $2 AND entity_id = $3 AND owner_notified_at IS NULL
          AND (status <> 'failed' OR attempts >= $4)
        RETURNING 1`,
      [tenantId, role, entityId, NOTIFY_AFTER_FAILED_ATTEMPTS],
    );
    return claim.rowCount === 1;
  });
  // eslint-disable-next-line no-console
  console.warn(`[document-jobs] ${role} ${entityId} (tenant ${tenantId}) ${status}: ${text}`);
  if (notifyNow) await notifyOwners(tenantId, role, entityId, message, notice);
  return { status, reason };
}

async function notifyOwners(tenantId: string, role: DocumentRole, entityId: string, message: string, notice: Notice): Promise<void> {
  const owners = await withGlobal((c) =>
    c.query<{ user_id: string }>(
      `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'owner' AND r.company_id IS NULL
          AND ur.scope_type = 'company' AND ur.scope_id = $1
          AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
      [tenantId],
    ),
  );
  for (const o of owners.rows) {
    try {
      await notify(tenantId, o.user_id, null, NOTIFICATION_TYPE, {
        title: `${notice.what} is still being prepared`,
        body: message,
        href: notice.href,
        entityType: TARGET[role],
        entityId,
        severity: "warning",
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[document-jobs] owner notify failed (recipient=${o.user_id}):`, (err as Error)?.message ?? err);
    }
  }
}

/** Store the bytes as THE role file of the parent. The unique index decides a race; the loser stores nothing. */
async function storeRoleFile(
  tenantId: string, role: DocumentRole, entityId: string, filename: string, bytes: Buffer,
): Promise<DocumentJobOutcome> {
  const fileId = newId();
  const storageKey = `${tenantId}/${fileId}`;
  const hash = sha256Hex(bytes);
  await storage().put(storageKey, bytes);
  try {
    await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type,
                            byte_size, storage_key, sha256, scrubbed, origin_site, role)
         VALUES ($1, $2, NULL, $3, $4, $5, 'application/pdf', $6, $7, $8, false, $9, $10)`,
        [fileId, tenantId, TARGET[role], entityId, filename, bytes.byteLength, storageKey, hash, config.originSite, role],
      );
      await c.query(
        `INSERT INTO document_jobs (tenant_id, role, entity_id, status, file_id, last_error, last_attempt_at, next_attempt_at)
         VALUES ($1, $2, $3, 'stored', $4, NULL, now(), NULL)
         ON CONFLICT (tenant_id, role, entity_id) DO UPDATE
           SET status = 'stored', file_id = EXCLUDED.file_id, last_error = NULL, next_attempt_at = NULL,
               attempts = document_jobs.attempts + 1, last_attempt_at = now(), updated_at = now()`,
        [tenantId, role, entityId, fileId],
      );
    });
  } catch (e) {
    await storage().del(storageKey).catch(() => undefined);
    if (e instanceof DatabaseError && e.code === "23505" && e.constraint === "ux_files_live_role") {
      const winner = await liveRoleFile(tenantId, role, entityId);
      if (winner) {
        await markStored(tenantId, role, entityId, winner);
        return { status: "exists", fileId: winner };
      }
    }
    throw e;
  }
  await writeActivity(tenantId, null, role === "invoice_pdf" ? "pdf_prepared" : "sealed", TARGET[role], entityId, {
    fileId, sha256: hash, byteSize: bytes.byteLength,
  });
  return { status: "stored", fileId };
}

/** Runs a job body; an unexpected throw (a bug, a library choking on an odd PDF) is recorded as a transient failure so
 *  the sweep's backoff governs it, instead of the bus hammering it five times and dead-lettering it. */
async function guarded(
  tenantId: string, role: DocumentRole, entityId: string, notice: () => Notice,
  body: () => Promise<DocumentJobOutcome>,
): Promise<DocumentJobOutcome> {
  try {
    return await body();
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return recordFailure(tenantId, role, entityId, "failed", "unexpected", `the job failed unexpectedly (${msg.slice(0, 200)})`, notice());
  }
}

const SAFE_NAME = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The issued invoice's PDF
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface InvoiceRow {
  id: string; invoiceNo: string; status: string; issueDate: string; dueDate: string;
  periodStart: string | null; periodEnd: string | null; currency: string; minorUnit: number;
  subtotal: string; taxTotal: string; total: string; taxCode: string | null;
  issuer: { legalName?: string; address?: string; npwp?: string | null; isPkp?: boolean | null;
            bank?: { name?: string | null; accountName?: string | null; accountNo?: string | null } | null } | null;
  arInvoiceId: string | null; clientName: string | null;
}

/** The invoice of record, entirely from the database (the issuer block frozen at issue, the ledger's lines). Null when
 *  the invoice is not issued or is gone. Throws when an issued invoice has no readable ledger lines: an invoice of
 *  record with no lines is never rendered. */
export async function loadInvoicePrintPayload(tenantId: string, invoiceId: string): Promise<InvoicePrintPayload | null> {
  return withBilling(tenantId, async (c) => {
    const r = await c.query<InvoiceRow>(
      `SELECT i.id, i.invoice_no AS "invoiceNo", i.status,
              to_char(i.issue_date, 'YYYY-MM-DD') AS "issueDate", to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate",
              to_char(i.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(i.period_end, 'YYYY-MM-DD') AS "periodEnd",
              i.currency, COALESCE(fc.minor_unit, 2)::int AS "minorUnit",
              i.subtotal::text AS subtotal, i.tax_total::text AS "taxTotal", i.total::text AS total, i.tax_code AS "taxCode",
              i.issuer, i.ar_invoice_id AS "arInvoiceId", cl.name AS "clientName"
         FROM invoices i
         LEFT JOIN clients cl ON cl.id = i.client_id
         LEFT JOIN finance_currencies fc ON fc.code = i.currency
        WHERE i.id = $1 AND i.issued_at IS NOT NULL AND i.deleted_at IS NULL`,
      [invoiceId],
    );
    const inv = r.rows[0];
    if (!inv) return null;
    const lines = await c.query<{
      lineNo: number; description: string; quantity: string; unitPrice: string; amount: string;
      taxCode: string | null; taxRate: string | null; taxAmount: string;
    }>(
      `SELECT l.line_no::int AS "lineNo", l.description, l.quantity::text AS quantity, l.unit_price::text AS "unitPrice",
              l.line_subtotal::text AS amount, l.tax_code AS "taxCode", l.tax_rate::text AS "taxRate",
              COALESCE(l.tax_amount, 0)::text AS "taxAmount"
         FROM finance_ar_invoice_lines l WHERE l.invoice_id = $1 ORDER BY l.line_no`,
      [inv.arInvoiceId],
    );
    if (lines.rows.length === 0) {
      throw new Error("the issued invoice's ledger lines could not be read (finance scope, or no AR invoice)");
    }
    const taxLines = await c.query<{ code: string; rate: string | null; base: string; amount: string }>(
      `SELECT l.tax_code AS code, l.tax_rate::text AS rate, sum(l.line_subtotal)::text AS base, sum(l.tax_amount)::text AS amount
         FROM finance_ar_invoice_lines l WHERE l.invoice_id = $1 AND l.tax_code IS NOT NULL
        GROUP BY l.tax_code, l.tax_rate ORDER BY l.tax_code`,
      [inv.arInvoiceId],
    );
    const iss = inv.issuer ?? {};
    const bank = iss.bank && iss.bank.name && iss.bank.accountName && iss.bank.accountNo
      ? { name: iss.bank.name, accountName: iss.bank.accountName, accountNo: iss.bank.accountNo }
      : null;
    return {
      kind: "invoice",
      renderNonce: newRenderNonce(),
      invoice: {
        id: inv.id, invoiceNo: inv.invoiceNo, status: inv.status, issueDate: inv.issueDate, dueDate: inv.dueDate,
        periodStart: inv.periodStart, periodEnd: inv.periodEnd, currency: inv.currency, minorUnit: Number(inv.minorUnit),
        subtotal: inv.subtotal, taxTotal: inv.taxTotal, total: inv.total, taxCode: inv.taxCode,
      },
      issuer: {
        legalName: iss.legalName ?? "", address: iss.address ?? "", npwp: iss.npwp ?? null, isPkp: iss.isPkp ?? null, bank,
      },
      client: { name: inv.clientName ?? "" },
      lines: lines.rows.map((l) => ({ ...l, lineNo: Number(l.lineNo) })),
      taxLines: taxLines.rows,
    };
  });
}

/** Render and store an issued invoice's PDF. Safe to call any number of times. */
export async function runInvoicePdfJob(tenantId: string, invoiceId: string): Promise<DocumentJobOutcome> {
  const role: DocumentRole = "invoice_pdf";
  let notice: Notice = { what: "An invoice PDF", href: `/invoices/${invoiceId}` };
  return guarded(tenantId, role, invoiceId, () => notice, async () => {
    const existing = await liveRoleFile(tenantId, role, invoiceId);
    if (existing) {
      await markStored(tenantId, role, invoiceId, existing);
      return { status: "exists", fileId: existing };
    }
    const payload = await loadInvoicePrintPayload(tenantId, invoiceId);
    if (!payload) return { status: "skipped", reason: "not_issued" };
    notice = { what: `The PDF of invoice ${payload.invoice.invoiceNo}`, href: `/invoices/${invoiceId}` };
    if (!documentRendererConfigured()) {
      return recordFailure(tenantId, role, invoiceId, "blocked", "renderer_not_configured",
        "the PDF renderer is not configured on this server", notice);
    }
    let rendered: Buffer;
    try {
      rendered = await renderDocumentPdf(payload);
    } catch (e) {
      if (e instanceof DocumentRenderError) {
        return recordFailure(tenantId, role, invoiceId, e.reason === "renderer_not_configured" ? "blocked" : "failed", e.reason, e.message, notice);
      }
      throw e;
    }
    const pdf = await finalizeRenderedPdf(rendered, {
      title: `Invoice ${payload.invoice.invoiceNo}`,
      author: payload.issuer.legalName,
      subject: `Invoice ${payload.invoice.invoiceNo}${payload.client.name ? ` to ${payload.client.name}` : ""}`,
    });
    return storeRoleFile(tenantId, role, invoiceId, `invoice-${SAFE_NAME(payload.invoice.invoiceNo)}.pdf`, pdf);
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The signed contract's sealed copy
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface ContractRow {
  id: string; clientId: string; title: string; reference: string | null; version: number; kind: string | null;
  status: string; value: string | null; currency: string; startsOn: string | null; endsOn: string | null;
  sentAt: string | null; signedAt: string | null; contentSha256: string | null; contentFixedAt: string | null;
  signatureTier: string | null; fileId: string | null; bodyMd: string | null; clientName: string | null;
  legalName: string | null;
  // DW-10f-2a (BFF §61.2, §61.9): the schedule hash stored at send (or by DW-D49's addition), when an addition happened,
  // and the hash the rows give NOW, from the one SQL function.
  scheduleSha256: string | null; scheduleAddedAt: Date | null; scheduleNow: string | null; scheduleTotal: string;
}

const isPdfFile = (contentType: string | null, bytes: Buffer): boolean =>
  (contentType ?? "").toLowerCase().includes("pdf") || bytes.subarray(0, 5).toString("latin1") === "%PDF-";

/** Seal and store a signed contract's copy. Safe to call any number of times. */
export async function runContractSealJob(tenantId: string, contractId: string): Promise<DocumentJobOutcome> {
  const role: DocumentRole = "contract_signed_copy";
  let notice: Notice = { what: "The signed copy of a contract", href: "/clients" };
  return guarded(tenantId, role, contractId, () => notice, async () => {
    const existing = await liveRoleFile(tenantId, role, contractId);
    if (existing) {
      await markStored(tenantId, role, contractId, existing);
      return { status: "exists", fileId: existing };
    }
    const loaded = await withTenants([tenantId], async (c) => {
      const r = await c.query<ContractRow>(
        `SELECT k.id, k.client_id AS "clientId", k.title, k.reference, k.version, k.kind, k.status,
                k.value::text AS value, k.currency,
                to_char(k.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(k.ends_on, 'YYYY-MM-DD') AS "endsOn",
                k.sent_at AS "sentAt", k.signed_at AS "signedAt", k.content_sha256 AS "contentSha256",
                k.content_fixed_at AS "contentFixedAt", k.signature_tier AS "signatureTier",
                k.file_id AS "fileId", k.body_md AS "bodyMd", cl.name AS "clientName", bp.legal_name AS "legalName",
                k.schedule_sha256 AS "scheduleSha256", k.schedule_added_at AS "scheduleAddedAt",
                contract_schedule_sha256(k.id, k.currency, k.value) AS "scheduleNow",
                (SELECT trim_scale(COALESCE(sum(x.amount), 0))::text FROM contract_instalments x
                  WHERE x.contract_id = k.id AND x.tenant_id = k.tenant_id) AS "scheduleTotal"
           FROM contracts k
           LEFT JOIN clients cl ON cl.id = k.client_id
           LEFT JOIN company_billing_profiles bp ON bp.tenant_id = k.tenant_id
          WHERE k.id = $1 AND k.deleted_at IS NULL`,
        [contractId],
      );
      const k = r.rows[0];
      if (!k) return null;
      const sigs = await c.query<{
        party: "client" | "provider"; signerName: string | null; signerTitle: string | null; signedAt: Date;
        ipHash: string | null; userAgent: string | null; contentSha256: string | null;
      }>(
        `SELECT party, signer_name AS "signerName", signer_title AS "signerTitle", signed_at AS "signedAt",
                ip_hash AS "ipHash", user_agent AS "userAgent", content_sha256 AS "contentSha256"
           FROM contract_signatures WHERE contract_id = $1 ORDER BY signed_at ASC`,
        [contractId],
      );
      const file = k.fileId
        ? (await c.query<{ storageKey: string | null; filename: string; contentType: string | null }>(
            `SELECT storage_key AS "storageKey", filename, content_type AS "contentType"
               FROM files WHERE id = $1 AND deleted_at IS NULL`,
            [k.fileId],
          )).rows[0] ?? null
        : null;
      // DW-10f-2a: the instalments of a schedule fixed at send (none for one added after signing: it is never printed).
      const instalments = k.scheduleSha256 && !k.scheduleAddedAt
        ? (await c.query<{ position: number; label: string; amount: string; due: string }>(
            `SELECT position::int AS position, label, trim_scale(amount)::text AS amount,
                    CASE WHEN due_kind = 'on_signing' THEN 'on_signing' ELSE to_char(due_on, 'YYYY-MM-DD') END AS due
               FROM contract_instalments WHERE contract_id = $1 ORDER BY position`,
            [contractId],
          )).rows
        : [];
      const certs = await c.query<{ serial: string; subject: string; fingerprint: string; validTo: Date; pem: string }>(
        `SELECT serial, subject, fingerprint_sha256 AS fingerprint, valid_to AS "validTo", certificate_pem AS pem
           FROM company_seal_certificates
          WHERE tenant_id = $1 AND valid_from <= now() AND valid_to > now()
          ORDER BY valid_from DESC`,
        [tenantId],
      );
      return { k, sigs: sigs.rows, file, certs: certs.rows, instalments };
    });
    if (!loaded || loaded.k.status !== "signed") return { status: "skipped", reason: "not_signed" };
    // PV5-11: a CERTIFIED contract's document is the provider's signed copy (stored at completion, src/signatures/), never
    // a company-sealed one. Nothing is owed here, and nothing is recorded as a failure.
    if (loaded.k.signatureTier === "certified") return { status: "skipped", reason: "certified_tier" };
    const { k, sigs, file, certs, instalments } = loaded;
    const label = k.reference ? `${k.title} (${k.reference})` : k.title;
    notice = { what: `The signed copy of "${label}"`, href: `/clients/${k.clientId}/billing` };

    // 0. Is there fixed content to seal at all?
    if (!k.contentSha256 || !k.contentFixedAt || !k.signatureTier) {
      return recordFailure(tenantId, role, contractId, "refused", "no_fixed_content",
        "this contract was signed before its content was fixed (no content hash), so there is nothing a seal could vouch for", notice);
    }
    const parties = new Set(sigs.map((s) => s.party));
    if (!parties.has("client") || !parties.has("provider")) {
      return recordFailure(tenantId, role, contractId, "refused", "signatures_incomplete",
        "the contract is marked signed but does not carry both parties' signatures", notice);
    }
    if (sigs.some((s) => s.contentSha256 && s.contentSha256 !== k.contentSha256)) {
      return recordFailure(tenantId, role, contractId, "refused", "signature_hash_mismatch",
        "a signature on record covers different content than the contract's fixed content", notice);
    }
    // DW-10f-2a (BFF §61.9): a schedule fixed at send must still be exactly the rows both parties signed. The hash is
    // recomputed by contract_schedule_sha256() (the one place it is computed); any difference is refused, never sealed.
    if (k.scheduleSha256 && !k.scheduleAddedAt && k.scheduleNow !== k.scheduleSha256) {
      return recordFailure(tenantId, role, contractId, "refused", "schedule_changed",
        "the contract's payment schedule no longer matches the schedule fixed when it was sent; it was not sealed", notice);
    }

    // 1. The key FIRST: on live, "no key yet" is the likeliest blocker, and nothing is rendered without one.
    let privateKey: KeyObject;
    try {
      privateKey = await loadSealPrivateKey(config.documents.sealKeysDir, tenantId);
    } catch (e) {
      if (e instanceof SealKeyError) return recordFailure(tenantId, role, contractId, "blocked", e.reason, e.message, notice);
      throw e;
    }
    const cert = certs.find((c) => certificateMatchesKey(c.pem, privateKey));
    if (!cert) {
      return recordFailure(tenantId, role, contractId, "blocked", "seal_certificate_missing",
        "no current certificate on record matches the mounted sealing key", notice);
    }

    // 2. The agreement, verified against the hash both parties signed. Refused on any difference.
    let agreementPdf: Buffer | undefined;
    let attachment: { bytes: Buffer; filename: string; mimeType: string; sha256: string } | undefined;
    let source: ContractPrintPayload["document"]["source"];
    if (k.fileId) {
      if (!file || !file.storageKey) {
        return recordFailure(tenantId, role, contractId, "refused", "content_missing",
          "the attached agreement document is gone or has no stored content", notice);
      }
      let bytes: Buffer;
      try {
        bytes = await storage().get(file.storageKey);
      } catch {
        return recordFailure(tenantId, role, contractId, "failed", "content_unreadable",
          "the attached agreement document's stored content could not be read", notice);
      }
      if (sha256Hex(bytes) !== k.contentSha256) {
        return recordFailure(tenantId, role, contractId, "refused", "content_mismatch",
          "the attached agreement document no longer matches the content both parties signed; it was not sealed", notice);
      }
      if (isPdfFile(file.contentType, bytes) && (await isUsablePdf(bytes))) {
        agreementPdf = bytes;
        source = "attached_pdf";
      } else {
        attachment = { bytes, filename: file.filename, mimeType: file.contentType ?? "application/octet-stream", sha256: k.contentSha256 };
        source = "attached_file";
      }
    } else {
      if (k.bodyMd === null || sha256Hex(k.bodyMd) !== k.contentSha256) {
        return recordFailure(tenantId, role, contractId, "refused", "content_mismatch",
          "the agreement's terms no longer match the content both parties signed; they were not sealed", notice);
      }
      source = "body";
    }

    // 3. The evidence page (and the body, when the terms were written in the ERP), through the print route.
    if (!documentRendererConfigured()) {
      return recordFailure(tenantId, role, contractId, "blocked", "renderer_not_configured",
        "the PDF renderer is not configured on this server", notice);
    }
    const sealedAt = new Date();
    const legalName = k.legalName ?? cert.subject;
    const payload: ContractPrintPayload = {
      kind: "contract",
      renderNonce: newRenderNonce(),
      includeBody: source === "body",
      contract: {
        id: k.id, title: k.title, reference: k.reference, version: Number(k.version), kind: k.kind, value: k.value,
        currency: k.currency, startsOn: k.startsOn, endsOn: k.endsOn,
        sentAt: k.sentAt ? new Date(k.sentAt).toISOString() : null,
        signedAt: k.signedAt ? new Date(k.signedAt).toISOString() : null,
        contentSha256: k.contentSha256, contentFixedAt: new Date(k.contentFixedAt).toISOString(),
        signatureTier: k.signatureTier, bodyMd: source === "body" ? k.bodyMd : null,
      },
      parties: { issuerLegalName: legalName, clientName: k.clientName ?? "" },
      schedule: k.scheduleSha256 && !k.scheduleAddedAt && instalments.length > 0
        ? {
            currency: k.currency,
            total: k.scheduleTotal,
            sha256: k.scheduleSha256,
            instalments,
          }
        : null,
      document: { source, filename: file?.filename ?? null, sha256: k.contentSha256 },
      signatures: sigs.map((s) => ({
        party: s.party, signerName: s.signerName, signerTitle: s.signerTitle, signedAt: new Date(s.signedAt).toISOString(),
        ipHash: s.ipHash, userAgent: s.userAgent, contentSha256: s.contentSha256,
      })),
      seal: {
        legalName: cert.subject, certificateSerial: cert.serial, certificateFingerprint: cert.fingerprint,
        certificateValidTo: new Date(cert.validTo).toISOString(), sealedAt: sealedAt.toISOString(),
      },
    };
    let rendered: Buffer;
    try {
      rendered = await renderDocumentPdf(payload);
    } catch (e) {
      if (e instanceof DocumentRenderError) {
        return recordFailure(tenantId, role, contractId, e.reason === "renderer_not_configured" ? "blocked" : "failed", e.reason, e.message, notice);
      }
      throw e;
    }

    // 4. One PDF (agreement, then evidence), sealed, and the seal checked against OUR certificate before storing.
    const meta = { title: `${label}: signed copy`, author: legalName, subject: `Signed agreement, sealed ${sealedAt.toISOString()}` };
    const assembled = await assembleContractPdf({ rendered, agreementPdf, attachment, meta });
    const sealed = await sealPdf(assembled, { privateKey, certificateDer: certificateDer(cert.pem) }, {
      name: cert.subject,
      reason: "Sealed copy of a signed agreement: unmodified since sealed. Identity not certified by a trusted authority.",
      location: "",
      signingTime: sealedAt,
    });
    const check = verifySealedPdf(sealed, cert.pem);
    if (!check.ok) {
      return recordFailure(tenantId, role, contractId, "failed", "seal_self_check_failed",
        `the sealed copy did not verify (${check.reason}); it was not stored`, notice);
    }
    const name = `contract-${SAFE_NAME(k.reference ?? k.id)}-v${k.version}-signed.pdf`;
    return storeRoleFile(tenantId, role, contractId, name, sealed);
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Event handlers and the sweep
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export async function invoiceIssuedDocumentHandler(event: OutboxEvent): Promise<void> {
  if (!event.tenantId || !event.entityId) return;
  await runInvoicePdfJob(event.tenantId, event.entityId);
}

export async function contractSignedDocumentHandler(event: OutboxEvent): Promise<void> {
  if (!event.tenantId || !event.entityId) return;
  await runContractSealJob(event.tenantId, event.entityId);
}

/** Called once from main.ts before the consumer loop starts. The `invoice` and `contract` streams are in its list. */
export function registerDocumentJobHandlers(): void {
  registerCoreEventHandler("invoice.issued", invoiceIssuedDocumentHandler);
  registerCoreEventHandler("contract.signed", contractSignedDocumentHandler);
}

/**
 * One pass over every company: each document still owed whose retry time has come (or every one, with
 * `ignoreBackoff`, as at boot) is attempted once. Refused documents are never retried here.
 */
export async function sweepDocumentJobs(opts: { ignoreBackoff?: boolean; limitPerCompany?: number } = {}): Promise<{ attempted: number; outcomes: DocumentJobOutcome[] }> {
  const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies ORDER BY id`));
  const outcomes: DocumentJobOutcome[] = [];
  for (const co of companies.rows) {
    let due: Array<{ role: DocumentRole; entityId: string }>;
    try {
      const r = await withTenants([co.id], (c) =>
        c.query<{ role: DocumentRole; entityId: string }>(
          `WITH owed AS (
             SELECT 'invoice_pdf'::text AS role, i.id AS entity_id, i.issued_at AS at
               FROM invoices i
              WHERE i.issued_at IS NOT NULL AND i.deleted_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM files f WHERE f.target_entity_type = 'invoice' AND f.target_entity_id = i.id
                                   AND f.role = 'invoice_pdf' AND f.deleted_at IS NULL)
             UNION ALL
             SELECT 'contract_signed_copy', k.id, k.signed_at
               FROM contracts k
              WHERE k.status = 'signed' AND k.deleted_at IS NULL AND k.content_sha256 IS NOT NULL
                -- PV5-11: a certified contract's copy is the provider's, stored at completion; never sealed here.
                AND k.signature_tier IS DISTINCT FROM 'certified'
                AND NOT EXISTS (SELECT 1 FROM files f WHERE f.target_entity_type = 'contract' AND f.target_entity_id = k.id
                                   AND f.role = 'contract_signed_copy' AND f.deleted_at IS NULL)
           )
           SELECT o.role, o.entity_id AS "entityId"
             FROM owed o
             LEFT JOIN document_jobs j ON j.tenant_id = $1 AND j.role = o.role AND j.entity_id = o.entity_id
            WHERE j.status IS DISTINCT FROM 'refused'
              AND ($2::boolean OR j.next_attempt_at IS NULL OR j.next_attempt_at <= now())
            ORDER BY o.at ASC NULLS FIRST
            LIMIT $3`,
          [co.id, opts.ignoreBackoff === true, opts.limitPerCompany ?? 25],
        ),
      );
      due = r.rows;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[document-jobs] sweep could not list company ${co.id}:`, (err as Error).message);
      continue;
    }
    for (const d of due) {
      try {
        outcomes.push(d.role === "invoice_pdf" ? await runInvoicePdfJob(co.id, d.entityId) : await runContractSealJob(co.id, d.entityId));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[document-jobs] sweep: ${d.role} ${d.entityId} failed to record:`, (err as Error).message);
      }
    }
  }
  return { attempted: outcomes.length, outcomes };
}

/** The sweep loop: a first pass shortly after boot that ignores the backoff (a new key or a fixed renderer usually
 *  arrives with a restart), then one pass per interval. Self-rescheduling, so a slow pass never overlaps itself. */
export function startDocumentJobSweep(intervalMs: number, firstDelayMs = 30_000): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (ignoreBackoff: boolean) => {
    if (stopped) return;
    try {
      const r = await sweepDocumentJobs({ ignoreBackoff });
      if (r.attempted > 0) {
        // eslint-disable-next-line no-console
        console.log(`[document-jobs] sweep attempted ${r.attempted}: ${r.outcomes.map((o) => o.status).join(", ")}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[document-jobs] sweep failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(() => void tick(false), intervalMs);
  };
  timer = setTimeout(() => void tick(true), firstDelayMs);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
