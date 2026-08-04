// CP-3 — the client portal's COMMERCE surface: invoices, payments (client-recorded, staff-confirmed),
// contracts and the client's countersignature, plus the portal's own file download.
//
// ── THESE ARE THE FIRST WRITES AN EXTERNAL PARTY MAKES INTO THIS SCHEMA ───────────────────────────
// Everything else a client can do today either decides a gate the agency opened for them or signs a
// scope the agency drafted. Recording a payment CREATES a row that makes a financial claim. Four rules
// hold that down, and none of them is "the controller is careful":
//
//   1. THE CLIENT NAMES NO MONEY KEYS. `client_id`, `currency` and the invoice link are read FROM the
//      invoice row (already scoped to the caller's clients), never from the request body. A body field
//      that could redirect a payment at another client's invoice does not exist to forget to validate.
//   2. A CLAIM IS NOT A PAYMENT. Inserted `status='pending'` — explicitly, not by relying on the
//      column default — and `confirmed_by`/`confirmed_at` are left NULL. Only staff (the billing
//      module, `invoice` resource) can confirm, and only confirmed rows count toward the balance.
//   3. NO STATUS SIDE EFFECT. Recording a payment does NOT touch `invoices.status`. A client cannot
//      mark their own invoice paid, not even transitively.
//   4. AMOUNT IS BOUNDED BY THE INVOICE. Overpayment beyond a small tolerance is refused, because the
//      realistic failure here is a typo'd extra digit, and a 10× claim sitting in finance's queue as
//      "pending" is a worse artifact than a 400.
//
// Contract signing mirrors `scope_signoffs`: one row per party, UNIQUE, idempotent on re-sign, and the
// contract flips to `signed` only on the transition where BOTH parties are present.
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException,
  Param, Post, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { storage } from "./storage";
import { scrubText, isScrubbableText } from "./scrub";
import { notifyBestEffort } from "./client-notify";
import { requireSigner, resolvePortalScope, type PortalScope } from "./portal-scope";
import type { PoolClient } from "pg";

const PAYMENT_METHODS = new Set(["bank_transfer", "card", "cash", "other"]);
/** Proof receipts are photos of a transfer slip or a small PDF. 10 MB is generous for both and well
 *  under the staff route's 25 MB — this is an unauthenticated-adjacent surface (an external party) and
 *  the smallest limit that does the job is the right one. */
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
/** Overpayment tolerance: rounding and bank fees legitimately push a transfer a hair over. Anything
 *  beyond this is a typo, not a payment. */
const OVERPAY_TOLERANCE = 1.01;

/** Where a client-visible file may live. An entity NOT in this map is unreachable through the portal's
 *  download route even if a file id is guessed, because the route resolves ownership by looking the
 *  parent entity up with the caller's scope applied — and it can only do that for shapes it knows. */
const DOWNLOADABLE: Record<string, "deliverable" | "contract" | "invoice_payment" | "project"> = {
  deliverable: "deliverable",
  contract: "contract",
  invoice_payment: "invoice_payment",
  project: "project",
};

function dispositionHeader(filename: string): string {
  const ascii = filename.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Controller("api")
@UseGuards(AuthGuard)
export class PortalCommerceController {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Invoices
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  /** The client's statement. `draft` invoices are excluded — see PortalWorkspaceController.finance().
   *
   *  NOT gated on the `billing` module. The staff BillingController is (`ModuleEnabledGuard("billing")`)
   *  because invoicing is an optional capability for a company; but a client who HAS invoices must be
   *  able to read them regardless of whether someone later toggled the module off, and a portal that
   *  answered 403 for that reason would be indistinguishable from a permissions bug. Reads only, and
   *  only the caller's own rows. */
  @Get(":tenantId/portal/invoices")
  async listInvoices(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const rows = await c.query(
        `SELECT i.id, i.status, i.currency, i.total::float8 AS total,
                to_char(i.period_start, 'YYYY-MM-DD') AS "periodStart",
                to_char(i.period_end, 'YYYY-MM-DD') AS "periodEnd",
                i.created_at AS "issuedAt", cl.name AS "clientName",
                COALESCE(pay.confirmed, 0)::float8 AS paid,
                COALESCE(pay.pending, 0)::float8 AS "pendingConfirmation",
                (i.status = 'sent' AND i.period_end < current_date) AS overdue
           FROM invoices i
           LEFT JOIN clients cl ON cl.id = i.client_id
           LEFT JOIN LATERAL (
             SELECT COALESCE(sum(pp.amount) FILTER (WHERE pp.status = 'confirmed'), 0) AS confirmed,
                    COALESCE(sum(pp.amount) FILTER (WHERE pp.status = 'pending'), 0) AS pending
               FROM invoice_payments pp WHERE pp.invoice_id = i.id AND pp.deleted_at IS NULL
           ) pay ON true
          WHERE i.client_id = ANY($1::uuid[]) AND i.deleted_at IS NULL AND i.status <> 'draft'
          ORDER BY i.created_at DESC LIMIT 200`,
        [scope.clientIds],
      );
      return rows.rows.map((r: Record<string, unknown>) => ({
        ...r,
        balance: Math.round(((r.total as number) - (r.paid as number)) * 100) / 100,
      }));
    });
  }

  /** One invoice with its frozen line items and its payment history. */
  @Get(":tenantId/portal/invoices/:invoiceId")
  async invoiceDetail(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("invoiceId") invoiceId: string,
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const inv = await this.ownedInvoice(c, scope, invoiceId);
      const payments = await c.query(
        `SELECT pp.id, pp.amount::float8 AS amount, pp.currency, to_char(pp.paid_on, 'YYYY-MM-DD') AS "paidOn",
                pp.method, pp.reference, pp.status, pp.note, pp.proof_file_id AS "proofFileId",
                pp.created_at AS "recordedAt", pp.confirmed_at AS "confirmedAt", pp.rejected_reason AS "rejectedReason"
           FROM invoice_payments pp
          WHERE pp.invoice_id = $1 AND pp.deleted_at IS NULL
          ORDER BY pp.paid_on DESC, pp.created_at DESC`,
        [invoiceId],
      );
      const paid = payments.rows
        .filter((p: Record<string, unknown>) => p.status === "confirmed")
        .reduce((s: number, p: Record<string, unknown>) => s + (p.amount as number), 0);
      return {
        ...inv,
        payments: payments.rows,
        paid: Math.round(paid * 100) / 100,
        balance: Math.round((inv.total - paid) * 100) / 100,
      };
    });
  }

  /** Record a payment against one of the caller's invoices.
   *
   *  This is a CLAIM (`status='pending'`) that finance confirms — see rule 2 in the file header. The
   *  proof receipt rides in the same request as base64 so a client on a phone makes one round trip
   *  rather than upload-then-link, which is the shape that leaves orphan files when the second call
   *  fails. Signing capability is NOT required: paying is not signing, and a `viewer` contact who
   *  handles accounts payable is an entirely ordinary person to exist. */
  @Post(":tenantId/portal/invoices/:invoiceId/payments")
  @HttpCode(201)
  async recordPayment(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("invoiceId") invoiceId: string,
    @Body() body: {
      amount?: number; paidOn?: string; method?: string; reference?: string; note?: string;
      proof?: { filename?: string; contentType?: string; content?: string };
    },
  ) {
    const b = body ?? {};
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("amount must be a positive number");
    if (!b.paidOn || !/^\d{4}-\d{2}-\d{2}$/.test(b.paidOn)) throw new BadRequestException("paidOn must be YYYY-MM-DD");
    // A transfer dated in the future has not happened. Compared in UTC against the DB's own clock
    // below rather than here, where the server's local date could differ from the client's by a day.
    const method = b.method ?? "bank_transfer";
    if (!PAYMENT_METHODS.has(method)) throw new BadRequestException("method must be bank_transfer|card|cash|other");
    await authorize(req.principal, { kind: "portal", tenantId }, "pay");

    const id = newId();
    const result = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const inv = await this.ownedInvoice(c, scope, invoiceId);
      if (inv.status === "void") throw new BadRequestException("this invoice has been cancelled");
      const future = await c.query<{ future: boolean }>(`SELECT $1::date > current_date AS future`, [b.paidOn]);
      if (future.rows[0]?.future) throw new BadRequestException("paidOn cannot be in the future");

      // Rule 4: bound the claim by what is actually outstanding on the invoice.
      const prior = await c.query<{ sum: string }>(
        `SELECT COALESCE(sum(amount), 0) AS sum FROM invoice_payments
          WHERE invoice_id = $1 AND status <> 'rejected' AND deleted_at IS NULL`,
        [invoiceId],
      );
      const already = Number(prior.rows[0]?.sum ?? 0);
      if (already + amount > inv.total * OVERPAY_TOLERANCE) {
        throw new BadRequestException(
          `amount exceeds the outstanding balance (${Math.max(0, Math.round((inv.total - already) * 100) / 100)} ${inv.currency})`,
        );
      }

      const proofFileId = b.proof?.content
        ? await this.storeProof(c, tenantId, req.principal.userId, id, b.proof)
        : null;

      await c.query(
        `INSERT INTO invoice_payments
           (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, method, reference,
            proof_file_id, status, note, recorded_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, 'pending', $11, $12, $13)`,
        [
          id, tenantId, invoiceId,
          // Rule 1: from the invoice row, not the body.
          inv.clientId, amount, inv.currency, b.paidOn, method,
          b.reference ? scrubText(b.reference).text.slice(0, 200) : null,
          proofFileId,
          b.note ? scrubText(b.note).text.slice(0, 1000) : null,
          req.principal.userId, config.originSite,
        ],
      );
      await emitEvent(c, tenantId, "invoice_payment", id, "invoice.payment.recorded", {
        invoiceId, clientId: inv.clientId, amount, currency: inv.currency, via: "portal",
      });
      return { inv, proofFileId };
    });

    await writeActivity(tenantId, req.principal.userId, "recorded", "invoice_payment", id, {
      invoiceId, amount, via: "portal",
    });
    // Finance has to act on this, so it must reach a human rather than only a table. Best-effort AFTER
    // the write stands: a notify failure must not turn a payment the client recorded into an error.
    await this.notifyInternal(tenantId, req.principal.userId, result.inv.clientId, "invoice.payment.recorded", {
      title: `Payment recorded by client — ${result.inv.currency} ${amount}`,
      body: "Awaiting your confirmation against the bank statement.",
      href: `/billing/${invoiceId}`,
      entityType: "invoice_payment",
      entityId: id,
      severity: "info",
    });
    return { id, status: "pending", proofFileId: result.proofFileId };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Contracts
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  /** The client's agreements. `draft` is excluded: a draft is the agency's internal working copy, and
   *  showing a client terms nobody has decided to offer them is worse than showing nothing. */
  @Get(":tenantId/portal/contracts")
  async listContracts(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const rows = await c.query(
        `SELECT k.id, k.title, k.reference, k.version, k.status, k.value::float8 AS value, k.currency,
                to_char(k.starts_on, 'YYYY-MM-DD') AS "startsOn",
                to_char(k.ends_on, 'YYYY-MM-DD') AS "endsOn",
                k.sent_at AS "sentAt", k.signed_at AS "signedAt",
                k.project_id AS "projectId", p.name AS "projectName",
                k.file_id IS NOT NULL AS "hasDocument",
                EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'client') AS "clientSigned",
                EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'provider') AS "providerSigned",
                -- Expiry is DERIVED for display and not written back: a nightly job that flips statuses
                -- does not exist, and a portal that showed a live contract as expired (or the reverse)
                -- because a cron missed a night would be worse than computing it on read.
                (k.ends_on IS NOT NULL AND k.ends_on < current_date) AS "termEnded"
           FROM contracts k LEFT JOIN projects p ON p.id = k.project_id
          WHERE k.client_id = ANY($1::uuid[]) AND k.deleted_at IS NULL AND k.status <> 'draft'
            AND ($2::uuid[] IS NULL OR k.project_id = ANY($2::uuid[]) OR k.project_id IS NULL)
          ORDER BY k.created_at DESC LIMIT 200`,
        [scope.clientIds, scope.projectIds],
      );
      return rows.rows;
    });
  }

  @Get(":tenantId/portal/contracts/:contractId")
  async contractDetail(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("contractId") contractId: string,
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const k = await this.ownedContract(c, scope, contractId);
      const [signatures, doc] = await Promise.all([
        c.query(
          `SELECT party, signer_name AS "signerName", signer_title AS "signerTitle", signed_at AS "signedAt"
             FROM contract_signatures WHERE contract_id = $1 ORDER BY signed_at ASC`,
          [contractId],
        ),
        k.fileId
          ? c.query(
              `SELECT id, filename, content_type AS "contentType", byte_size::int AS "byteSize", url
                 FROM files WHERE id = $1 AND deleted_at IS NULL`,
              [k.fileId],
            )
          : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      ]);
      return {
        ...k,
        // `canSign` is the exact conjunction the POST below enforces, surfaced so the UI disables the
        // button for the same reasons the server would refuse — rather than offering an action that
        // 403s. Kept as ONE expression in ONE place for that reason.
        canSign: scope.canSign && k.status === "sent" && !signatures.rows.some((s: Record<string, unknown>) => s.party === "client"),
        viewOnly: !scope.canSign,
        signatures: signatures.rows,
        document: doc.rows[0] ?? null,
      };
    });
  }

  /** The client's countersignature.
   *
   *  Shape copied from PortalController.scopeSign deliberately: insert one party row idempotently, read
   *  the party set back, and act only on the TRANSITION to complete. Re-signing is a 200 with
   *  `alreadySigned`, not an error — a double-tapped button on a phone must not read as a failure on
   *  something as consequential as a contract. */
  @Post(":tenantId/portal/contracts/:contractId/sign")
  @HttpCode(200)
  async signContract(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("contractId") contractId: string,
    @Body() body: { signerName?: string; signerTitle?: string; agree?: boolean },
  ) {
    const b = body ?? {};
    // An explicit attestation is what makes a typed name a signature rather than a form field. Refused
    // server-side so the record can never contain a signature the signer did not affirm.
    if (b.agree !== true) throw new BadRequestException("you must confirm you agree to the terms");
    const signerName = (b.signerName ?? "").trim();
    if (signerName.length < 2) throw new BadRequestException("signerName required");
    await authorize(req.principal, { kind: "portal", tenantId }, "sign");

    const out = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      requireSigner(scope);
      const k = await this.ownedContract(c, scope, contractId);
      // ORDER MATTERS, and it was wrong the first time. The already-signed check must come BEFORE the
      // status check, because signing is what FLIPS the status to `signed` — so a double-submit (a
      // double-tapped button on a phone, a retried request) hit `status !== 'sent'` and answered
      // 400 "this agreement is signed and cannot be signed" to the person who had just successfully
      // signed it. Caught by the demo-fixture test, which mirrors this ordering.
      //
      // Checked regardless of current status: if this caller's side has a signature on record, the
      // request is satisfied, and that is true whether the contract later became signed, expired or
      // void. Idempotency answers "is the thing you asked for already done", not "is the object still
      // in the state it was when you asked".
      const existing = await c.query(
        `SELECT 1 FROM contract_signatures WHERE contract_id = $1 AND party = 'client'`,
        [contractId],
      );
      if (existing.rows[0]) return { alreadySigned: true, complete: k.status === "signed", clientId: k.clientId, title: k.title };
      if (k.status !== "sent") {
        // Covers declined / expired / void in one message. Not a 404: the client can see this contract,
        // so pretending it is missing would be a worse lie than telling them its state.
        throw new BadRequestException(`this agreement is ${k.status} and cannot be signed`);
      }
      if (k.termEnded) throw new BadRequestException("this agreement's term has ended — ask your account manager to re-issue it");

      const ins = await c.query(
        `INSERT INTO contract_signatures
           (id, tenant_id, contract_id, party, signer, signer_name, signer_title, ip_hash, user_agent, origin_site)
         VALUES ($1, $2, $3, 'client', $4, $5, $6, $7, $8, $9)
         ON CONFLICT (contract_id, party) DO NOTHING`,
        [
          newId(), tenantId, contractId, req.principal.userId,
          scrubText(signerName).text.slice(0, 200),
          b.signerTitle ? scrubText(b.signerTitle).text.slice(0, 200) : null,
          hashForEvidence(clientIpOf(req), tenantId),
          String(req.headers["user-agent"] ?? "").slice(0, 400),
          config.originSite,
        ],
      );
      if (ins.rowCount === 0) return { alreadySigned: true, complete: false, clientId: k.clientId, title: k.title };

      const parties = await c.query<{ party: string }>(
        `SELECT party FROM contract_signatures WHERE contract_id = $1`, [contractId],
      );
      const have = new Set(parties.rows.map((r) => r.party));
      const complete = have.has("provider") && have.has("client");
      if (complete) {
        await c.query(
          `UPDATE contracts SET status = 'signed', signed_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'sent'`,
          [contractId],
        );
      }
      // Emitted on the client's signature either way (not only on completion): the internal side needs
      // to know the client has signed even while the agency's own countersignature is outstanding —
      // that is precisely the state someone has to act on.
      await emitEvent(c, tenantId, "contract", contractId, complete ? "contract.signed" : "contract.client_signed", {
        clientId: k.clientId, parties: [...have], via: "portal",
      });
      return { alreadySigned: false, complete, clientId: k.clientId, title: k.title };
    });

    if (!out.alreadySigned) {
      await writeActivity(tenantId, req.principal.userId, "signed", "contract", contractId, { via: "portal", complete: out.complete });
      await this.notifyInternal(tenantId, req.principal.userId, out.clientId, "contract.client_signed", {
        title: out.complete ? `Agreement fully signed — ${out.title}` : `Client signed ${out.title} — your countersignature is needed`,
        href: `/clients`,
        entityType: "contract",
        entityId: contractId,
        severity: out.complete ? "info" : "warning",
      });
    }
    return { id: contractId, party: "client", complete: out.complete, alreadySigned: out.alreadySigned };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Portal file download — the portal's OWN route, deliberately not the staff /files one
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  /** Stream a file the caller's client owns.
   *
   *  WHY NOT REUSE `GET /files/:id/content`: that route authorizes with
   *  `authorize({kind: <parent entity>}, "read")`, and no Cerbos policy grants the `client` derived role
   *  read on `deliverable`/`contract`. So the staff route correctly 403s a client — and would keep
   *  403ing however the portal linked to it. Granting `client` read on those resources to fix it would
   *  have widened access to EVERY row of those kinds tenant-wide, since Cerbos does not know which
   *  deliverable belongs to whom. The row-level answer is the portal's scope predicate, so the download
   *  lives here, authorizes on `portal`, and resolves ownership by walking the file's parent entity
   *  through that predicate. A file whose parent kind is not in DOWNLOADABLE is unreachable, full stop.
   *
   *  The three response headers are copied verbatim from the staff route: attachment-only disposition
   *  (no inline render), `nosniff`, and a sandboxing CSP — a client-uploaded proof receipt is untrusted
   *  bytes served from our origin, which is the classic stored-XSS shape. */
  @Get(":tenantId/portal/files/:fileId")
  async downloadFile(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Param("fileId") fileId: string,
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    const file = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const r = await c.query<{ storage_key: string | null; content_type: string; filename: string; target_entity_type: string; target_entity_id: string }>(
        `SELECT storage_key, content_type, filename, target_entity_type, target_entity_id
           FROM files WHERE id = $1 AND deleted_at IS NULL`,
        [fileId],
      );
      const f = r.rows[0];
      if (!f) throw new NotFoundException("file not found");
      const kind = DOWNLOADABLE[f.target_entity_type];
      if (!kind) throw new NotFoundException("file not found");
      if (!(await this.ownsEntity(c, scope, kind, f.target_entity_id))) {
        // 404, not 403: distinguishing them turns this route into an existence oracle for other
        // clients' file ids.
        throw new NotFoundException("file not found");
      }
      if (!f.storage_key) throw new NotFoundException("no stored content (link-only attachment)");
      return f;
    });
    const bytes = await storage().get(file.storage_key as string);
    await reply
      .header("content-disposition", dispositionHeader(file.filename))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .type(file.content_type || "application/octet-stream")
      .send(bytes);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Ownership helpers — every one of them applies the scope predicate; none takes an id on trust
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  private async ownedInvoice(c: PoolClient, scope: PortalScope, invoiceId: string) {
    const r = await c.query<{ id: string; clientId: string; status: string; currency: string; total: number; lines: unknown; periodStart: string | null; periodEnd: string | null; issuedAt: string; clientName: string | null }>(
      `SELECT i.id, i.client_id AS "clientId", i.status, i.currency, i.total::float8 AS total, i.lines,
              to_char(i.period_start, 'YYYY-MM-DD') AS "periodStart",
              to_char(i.period_end, 'YYYY-MM-DD') AS "periodEnd",
              i.created_at AS "issuedAt", cl.name AS "clientName"
         FROM invoices i LEFT JOIN clients cl ON cl.id = i.client_id
        WHERE i.id = $1 AND i.client_id = ANY($2::uuid[]) AND i.deleted_at IS NULL AND i.status <> 'draft'`,
      [invoiceId, scope.clientIds],
    );
    if (!r.rows[0]) throw new NotFoundException("invoice not found");
    return r.rows[0];
  }

  private async ownedContract(c: PoolClient, scope: PortalScope, contractId: string) {
    const r = await c.query<{ id: string; clientId: string; title: string; status: string; termEnded: boolean; fileId: string | null }>(
      `SELECT k.id, k.client_id AS "clientId", k.title, k.reference, k.version, k.status,
              k.value::float8 AS value, k.currency, k.body_md AS "bodyMd", k.file_id AS "fileId",
              to_char(k.starts_on, 'YYYY-MM-DD') AS "startsOn",
              to_char(k.ends_on, 'YYYY-MM-DD') AS "endsOn",
              k.sent_at AS "sentAt", k.signed_at AS "signedAt", k.decline_reason AS "declineReason",
              k.project_id AS "projectId",
              (k.ends_on IS NOT NULL AND k.ends_on < current_date) AS "termEnded"
         FROM contracts k
        WHERE k.id = $1 AND k.client_id = ANY($2::uuid[]) AND k.deleted_at IS NULL AND k.status <> 'draft'
          AND ($3::uuid[] IS NULL OR k.project_id = ANY($3::uuid[]) OR k.project_id IS NULL)`,
      [contractId, scope.clientIds, scope.projectIds],
    );
    if (!r.rows[0]) throw new NotFoundException("contract not found");
    return r.rows[0];
  }

  /** Does the caller's client own this entity? One switch, so the download route's reachability set is
   *  exactly DOWNLOADABLE and adding a kind there without adding a branch here fails CLOSED. */
  private async ownsEntity(
    c: PoolClient, scope: PortalScope, kind: "deliverable" | "contract" | "invoice_payment" | "project", id: string,
  ): Promise<boolean> {
    const q = {
      // Ownership travels through the project, because `deliverables.client_id` is nullable and a
      // deliverable on the client's project with a NULL client_id is the common case.
      deliverable: `SELECT 1 FROM deliverables d JOIN projects p ON p.id = d.project_id
                     WHERE d.id = $1 AND d.deleted_at IS NULL
                       AND p.client_id = ANY($2::uuid[]) AND ($3::uuid[] IS NULL OR p.id = ANY($3::uuid[]))`,
      project: `SELECT 1 FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL
                  AND p.client_id = ANY($2::uuid[]) AND ($3::uuid[] IS NULL OR p.id = ANY($3::uuid[]))`,
      contract: `SELECT 1 FROM contracts k WHERE k.id = $1 AND k.deleted_at IS NULL AND k.status <> 'draft'
                   AND k.client_id = ANY($2::uuid[])
                   AND ($3::uuid[] IS NULL OR k.project_id = ANY($3::uuid[]) OR k.project_id IS NULL)`,
      // Their own receipt. Scoped on client_id (denormalised onto the row for exactly this reason)
      // and NOT on recorded_by: a colleague at the same client legitimately reads it, and a
      // staff-recorded payment has no client recorder at all.
      invoice_payment: `SELECT 1 FROM invoice_payments pp WHERE pp.id = $1 AND pp.deleted_at IS NULL
                          AND pp.client_id = ANY($2::uuid[])`,
    }[kind];
    const r = await c.query(q, [id, scope.clientIds, scope.projectIds]);
    return r.rows.length > 0;
  }

  /** Store a client-supplied proof receipt as an ordinary `files` row targeting the payment.
   *
   *  The day-one scrub runs on scrubbable text exactly as the staff upload path does, so a receipt
   *  pasted as text cannot smuggle a PAN into storage. Binary images pass through unscrubbed (there is
   *  no OCR on this path) — which is why the download route serves them as sandboxed attachments. */
  private async storeProof(
    c: PoolClient, tenantId: string, uploaderId: string | null, paymentId: string,
    proof: { filename?: string; contentType?: string; content?: string },
  ): Promise<string> {
    const filename = scrubText(proof.filename || "receipt").text.slice(0, 200);
    const contentType = (proof.contentType || "application/octet-stream").slice(0, 120);
    const raw = Buffer.from(proof.content as string, "base64");
    if (raw.byteLength === 0) throw new BadRequestException("proof content is empty or not valid base64");
    if (raw.byteLength > MAX_PROOF_BYTES) throw new BadRequestException("proof file too large (max 10 MB)");
    let bytes = raw;
    let scrubbed = false;
    if (isScrubbableText(contentType)) {
      const { text, redactions } = scrubText(raw.toString("utf8"));
      bytes = Buffer.from(text, "utf8");
      scrubbed = redactions > 0;
    }
    const fileId = newId();
    const storageKey = `${tenantId}/${fileId}`;
    await storage().put(storageKey, bytes);
    await c.query(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename,
                          content_type, byte_size, storage_key, scrubbed, origin_site)
       VALUES ($1, $2, $3, 'invoice_payment', $4, $5, $6, $7, $8, $9, $10)`,
      [fileId, tenantId, uploaderId, paymentId, filename, contentType, bytes.byteLength, storageKey, scrubbed, config.originSite],
    );
    return fileId;
  }

  /** Tell the internal side. Recipients are the client's account owners — resolved from the projects of
   *  that client rather than a single env var, so the right PM hears about it. Falls back to nobody
   *  rather than to everybody: a notification storm across the whole company on every client payment
   *  would train people to ignore the bell, which costs more than a missed notification. */
  private async notifyInternal(
    tenantId: string, actorId: string | null, clientId: string, type: string,
    payload: { title: string; href: string; body?: string; entityType: string; entityId: string; severity: "info" | "warning" | "critical" },
  ): Promise<void> {
    const owners = await withTenants([tenantId], (c) =>
      c.query<{ owner_id: string }>(
        `SELECT DISTINCT owner_id FROM projects
          WHERE client_id = $1 AND owner_id IS NOT NULL AND deleted_at IS NULL`,
        [clientId],
      ),
    );
    const ids = owners.rows.map((r) => r.owner_id);
    if (!ids.length) return;
    await notifyBestEffort(tenantId, actorId, ids, type, payload);
  }
}

/** The client's IP as the proxy reports it, or the socket's. Read for EVIDENCE only and immediately
 *  hashed — never stored, logged or compared raw. `x-forwarded-for` is spoofable by the client, which
 *  is fine for its purpose here (weak corroboration in a dispute) and would NOT be fine if anything
 *  authorized on it. Nothing does. */
function clientIpOf(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : (fwd ?? "").split(",")[0];
  return (first || req.ip || "").trim();
}

/** Salted, truncated SHA-256. The tenant id is the salt so the same address does not produce the same
 *  digest across companies, and the digest is truncated because 128 bits is ample for "same browser?"
 *  and the shorter value is less useful to anyone who exfiltrates the table. */
function hashForEvidence(value: string, salt: string): string | null {
  if (!value) return null;
  // Local require rather than a top-level import: this is the only crypto use in the file, and
  // node:crypto at module scope would load in the edge-ish test paths that never call it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 32);
}
