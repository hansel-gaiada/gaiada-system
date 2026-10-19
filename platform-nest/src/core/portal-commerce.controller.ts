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
//      column default — and `confirmed_by`/`confirmed_at` are left NULL. Only staff (the invoice
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
  BadGatewayException, BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException,
  Param, Post, Req, Res, ServiceUnavailableException, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { storage } from "./storage";
import { sha256Hex } from "./content-hash";
import { clientIpOf, hashForEvidence, userAgentOf } from "./evidence";
import { scrubText, isScrubbableText } from "./scrub";
import { notifyBestEffort } from "./client-notify";
import { canSignFor, requireSignerFor, resolvePortalScope, scopeValues, type PortalScope } from "./portal-scope";
// PV3-02: every row-visibility predicate below comes from portal-visibility.ts.
import {
  changeRequestInPortalScope, clientReportInPortalScope, contractInPortalScope, conversationAttachmentClientVisible, conversationThreadInPortalScope, deliverableClientVisible,
  invoiceInPortalScope, invoicePaymentClientVisible, projectInPortalScope, scopeAt, type PortalScopeParams,
} from "./portal-visibility";
import type { PoolClient } from "pg";
import { claimHeadroom, hasCurrencyPrecision } from "../modules/invoice/issue";
import { CONTRACT_SIGNED_COPY_FILE_ID, INVOICE_PDF_FILE_ID } from "./document-read-fields";
import { CLIENT_REPORT_FILE_ROLE } from "./client-reports";
// DW-10f-2a (BFF §61.6): the contract's payment schedule, as the portal reads it.
import { readPortalSchedule } from "./contract-schedule";
// PV5-10: online payment through the provider's hosted checkout. The decision and the checkout rows live in
// src/payments/; this controller only admits the invoice through the portal scope first.
import { providerForTenant } from "../payments/registry";
import {
  decideOnlinePayment, expireAtProvider, loadOnlinePaymentFacts, retireStaleCheckout, reusableCheckout, storeCheckout,
  type CheckoutView, type RetiredCheckout,
} from "../payments/checkout";
import { ProviderRequestError, ProviderUnavailableError } from "../payments/provider";
// PV5-11: certified signing (a provider's envelope; the SIMULATED PSrE while PV-D43's review stage lasts).
import { certifiedSigningAccount, signatureAccountNamed } from "../signatures/registry";
import { SIMULATED_PROVIDER } from "../signatures/simulated-psre";

const PAYMENT_METHODS = new Set(["bank_transfer", "card", "cash", "other"]);
/** Proof receipts are photos of a transfer slip or a small PDF. 10 MB is generous for both and well
 *  under the staff route's 25 MB — this is an unauthenticated-adjacent surface (an external party) and
 *  the smallest limit that does the job is the right one.
 *  The ONE definition: `core/upload-body-limits.ts` derives this route's Fastify `bodyLimit` from it
 *  (PV4-03b) — change it here and the request-body limit follows. */
export const MAX_PROOF_BYTES = 10 * 1024 * 1024;
// (PV5-04 removed the 1% overpayment tolerance: a claim is bounded by the LEDGER's outstanding amount, because an AR
// allocation can never exceed what is owed. See recordPayment.)

type DownloadableKind = "deliverable" | "contract" | "invoice_payment" | "project" | "conversation" | "invoice" | "client_report";

/** Where a client-visible file may live. An entity NOT in this map is unreachable through the portal's
 *  download route even if a file id is guessed, because the route resolves ownership by looking the
 *  parent entity up with the caller's scope applied — and it can only do that for shapes it knows. */
const DOWNLOADABLE: Record<string, DownloadableKind> = {
  deliverable: "deliverable",
  contract: "contract",
  invoice_payment: "invoice_payment",
  project: "project",
  // PV4-03: a Conversation message attachment (`target_entity_id` = the MESSAGE id). Reached through
  // message -> thread -> conversationThreadInPortalScope in ownsEntity below.
  conversation: "conversation",
  // PV5-07: an issued invoice's PDF (files.role = 'invoice_pdf'). ownsEntity admits only an ISSUED invoice in the
  // caller's scope, so a draft, an approved-but-unissued or a legacy never-issued invoice has no downloadable file, even
  // though some of those are visible in the portal. (A contract's sealed copy rides the existing `contract` kind.)
  invoice: "invoice",
  // PV7-04a (BFF §55.4): a published client report's own file (files.role = 'client_report_file'). ownsEntity admits only a
  // PUBLISHED report in the caller's reach (clientReportInPortalScope, the strict shape), so a draft, a withdrawn report or one
  // outside the caller's projects has no downloadable file, and any other file hung on a report is never served.
  client_report: "client_report",
};

/**
 * PV5-04 — the invoice OF RECORD as the client sees it (portal list and detail). Needs `i` (invoices) and `ar` (the
 * LEFT-joined finance_ar_invoices on i.ar_invoice_id, read under the finance module scope).
 *  - `invoiceNo`, `issueDate`, `dueDate`, `subtotal`, `taxTotal`, `taxCode`: NULL on a legacy (pre-issue) invoice.
 *  - `issuer`: the snapshot frozen at issue (legal name, address, NPWP, the bank block clients pay into).
 *  - `outstanding`: the ledger's (AR total - paid - credited - written off) for an issued invoice; total - confirmed
 *    claims for a legacy one. Never negative.
 *  - `payable`: the invoice accepts a payment claim now (issued, `sent`, something still outstanding after the claims
 *    already being verified). The portal hides the "Tell us you've paid" form when false.
 *  - `overdue` (decision 10): past its DUE date and not fully paid; a legacy invoice has no due date, so its period end
 *    stands in.
 */
const PORTAL_INVOICE_RECORD_COLUMNS = `
  i.invoice_no AS "invoiceNo", to_char(i.issue_date, 'YYYY-MM-DD') AS "issueDate",
  to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate", i.subtotal::float8 AS subtotal, i.tax_total::float8 AS "taxTotal",
  i.tax_code AS "taxCode", i.issuer,
  GREATEST(CASE WHEN ar.id IS NOT NULL THEN ar.total - ar.amount_paid - ar.amount_credited - ar.amount_written_off
                ELSE i.total - COALESCE((SELECT sum(pp.amount) FROM invoice_payments pp
                                          WHERE pp.invoice_id = i.id AND pp.status = 'confirmed' AND pp.deleted_at IS NULL), 0)
           END, 0)::float8 AS outstanding,
  (ar.id IS NOT NULL AND i.status = 'sent'
     AND ar.total - ar.amount_paid - ar.amount_credited - ar.amount_written_off
         - COALESCE((SELECT sum(pp.amount) FROM invoice_payments pp
                      WHERE pp.invoice_id = i.id AND pp.status = 'pending' AND pp.deleted_at IS NULL), 0) > 0) AS payable,
  (i.status = 'sent' AND COALESCE(i.due_date, i.period_end) < current_date) AS overdue`;

/** PV5-10: where the provider sends the payer back to, when the ERP's public base URL is known (MAIL_LINK_BASE_URL, the
 *  one public-base setting the platform has). Otherwise null, and the provider dashboard's Finish URL applies
 *  (infra/runbooks/midtrans-payments.md). The page only says "we're confirming your payment"; the payment itself comes
 *  from the verified, re-fetched notice alone. */
function portalReturnUrl(invoiceId: string): string | null {
  const base = config.mail.linkBaseUrl;
  let host: string;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:") return null;
    host = u.hostname;
  } catch {
    return null;
  }
  if (host.endsWith(".invalid")) return null;
  return `${base}/portal/invoices/${encodeURIComponent(invoiceId)}?checkout=finished`;
}

function dispositionHeader(filename: string): string {
  const ascii = filename.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// PV4-04: the amendment fields every portal contract read carries. Both joined rows (the amended contract,
// the change request that caused it) go through the CALLER'S scope predicates, so a project-scoped contact
// never learns the id or reference of a contract, or the id of a request, outside their reach: out of scope
// reads null, exactly like a row that is not there.
const AMENDMENT_COLUMNS = `
  k.kind, am.id AS "amendsId", am.reference AS "amendsReference", wcr.id AS "changeRequestId"`;
const amendmentJoins = (params: PortalScopeParams) => `
  LEFT JOIN contracts am ON am.id = k.amends_id AND ${contractInPortalScope("am", params)}
  LEFT JOIN webdev_change_requests wcr ON wcr.id = k.change_request_id AND ${changeRequestInPortalScope("wcr", params)}`;

@Controller("api")
@UseGuards(AuthGuard)
export class PortalCommerceController {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Invoices
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  /** The client's statement. `draft` invoices are excluded — see PortalWorkspaceController.finance().
   *
   *  NOT gated on the `invoice` module. The staff InvoiceController is (`ModuleEnabledGuard("invoice")`)
   *  because invoicing is an optional capability for a company; but a client who HAS invoices must be
   *  able to read them regardless of whether someone later toggled the module off, and a portal that
   *  answered 403 for that reason would be indistinguishable from a permissions bug. Reads only, and
   *  only the caller's own rows. */
  @Get(":tenantId/portal/invoices")
  async listInvoices(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    // PV5-04: the finance scope is declared because an issued invoice's `outstanding` is the LEDGER's (the AR invoice,
    // module walled). Without it the join reads zero AR rows and every issued invoice would show nothing outstanding.
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const rows = await c.query(
        `SELECT i.id, i.status, i.currency, i.total::float8 AS total,
                to_char(i.period_start, 'YYYY-MM-DD') AS "periodStart",
                to_char(i.period_end, 'YYYY-MM-DD') AS "periodEnd",
                COALESCE(i.issued_at, i.created_at) AS "issuedAt", cl.name AS "clientName",
                COALESCE(pay.confirmed, 0)::float8 AS paid,
                COALESCE(pay.pending, 0)::float8 AS "pendingConfirmation",
                ${PORTAL_INVOICE_RECORD_COLUMNS},
                ${INVOICE_PDF_FILE_ID("i")} AS "pdfFileId"
           FROM invoices i
           LEFT JOIN clients cl ON cl.id = i.client_id
           LEFT JOIN finance_ar_invoices ar ON ar.id = i.ar_invoice_id
           LEFT JOIN LATERAL (
             SELECT COALESCE(sum(pp.amount) FILTER (WHERE pp.status = 'confirmed'), 0) AS confirmed,
                    COALESCE(sum(pp.amount) FILTER (WHERE pp.status = 'pending'), 0) AS pending
               FROM invoice_payments pp WHERE pp.invoice_id = i.id AND ${invoicePaymentClientVisible("pp", "detail")}
           ) pay ON true
          WHERE ${invoiceInPortalScope("i", { clients: 1 })}
          ORDER BY i.created_at DESC LIMIT 200`,
        [scope.clientIds],
      );
      return rows.rows.map((r: Record<string, unknown>) => ({
        ...r,
        balance: Math.round(((r.total as number) - (r.paid as number)) * 100) / 100,
      }));
    }, { modules: ["finance"] });
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
          WHERE pp.invoice_id = $1 AND ${invoicePaymentClientVisible("pp", "detail")}
          ORDER BY pp.paid_on DESC, pp.created_at DESC`,
        [invoiceId],
      );
      const paid = payments.rows
        .filter((p: Record<string, unknown>) => p.status === "confirmed")
        .reduce((s: number, p: Record<string, unknown>) => s + (p.amount as number), 0);
      // PV5-04: the tax lines of an issued invoice, from the ledger lines it was posted with (code, statutory rate,
      // base, amount). Empty for an untaxed or a legacy invoice.
      const taxLines = inv.arInvoiceId
        ? (await c.query(
            `SELECT l.tax_code AS code, l.tax_rate::float8 AS rate, sum(l.line_subtotal)::float8 AS base,
                    sum(l.tax_amount)::float8 AS amount
               FROM finance_ar_invoice_lines l
              WHERE l.invoice_id = $1 AND l.tax_code IS NOT NULL
              GROUP BY l.tax_code, l.tax_rate ORDER BY l.tax_code`,
            [inv.arInvoiceId],
          )).rows
        : [];
      // The ledger link is internal: the client gets the invoice of record, not our AR row id.
      const visible: Record<string, unknown> = { ...inv };
      delete visible.arInvoiceId;
      // PV5-04b: the tracker's lines carry the internal `projectId` (it defaults the service line at issue). The client
      // sees what each line says and costs, never our project ids. DW-10f-3a (BFF §61.6): an instalment line's
      // `contractId` and `instalmentId` are internal too; `kind`, `description`, `hours`, `rate` and `amount` stay.
      if (Array.isArray(visible.lines)) {
        visible.lines = (visible.lines as Array<Record<string, unknown>>).map((l) => {
          const { projectId: _projectId, contractId: _contractId, instalmentId: _instalmentId, ...rest } = l ?? {};
          return rest;
        });
      }
      // PV5-10: whether "Pay online" is offered, decided here so the UI never guesses (the checkout route uses the same
      // decision). Off unless the provider is configured for THIS company.
      const decision = providerForTenant(tenantId)
        ? decideOnlinePayment(true, await loadOnlinePaymentFacts(c, invoiceId))
        : decideOnlinePayment(false, null);
      return {
        ...visible,
        taxLines,
        payments: payments.rows,
        paid: Math.round(paid * 100) / 100,
        balance: Math.round((inv.total - paid) * 100) / 100,
        // `amount` is what the checkout will charge (the balance less the client's claims being verified), for display.
        onlinePayment: decision.available
          ? { available: true, amount: Number(decision.amount), currency: decision.currency }
          : { available: false, reason: decision.reason, message: decision.message },
      };
    }, { modules: ["finance"] });
  }

  /** PV5-10 — start (or resume) paying an invoice online through the provider's hosted checkout.
   *
   *  Any ACTIVE contact in the portal scope may pay (action `pay`, the same as a manual claim: paying is not signing).
   *  Order: authorize (403) -> provider configured for this company (404 otherwise: the route does not exist here) ->
   *  the invoice through the portal scope predicates (404 out of scope, never 403) -> the one decision
   *  (`decideOnlinePayment`, 409 with `reason` when refused) -> reuse the open checkout or create one at the provider
   *  (OUTSIDE any transaction) -> store it (the open-per-invoice unique index settles a race). Answers the hosted URL.
   *  The body is ignored: the amount is the invoice's, never the caller's. */
  @Post(":tenantId/portal/invoices/:invoiceId/checkout")
  @HttpCode(200)
  async startCheckout(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("invoiceId") invoiceId: string,
  ): Promise<CheckoutView> {
    await authorize(req.principal, { kind: "portal", tenantId }, "pay");
    const gw = providerForTenant(tenantId);
    if (!gw) throw new NotFoundException("online payment is not available");

    const refuse = (d: { reason: string; message: string }) => new ConflictException({ message: d.message, reason: d.reason });
    type Plan = { reuse: CheckoutView } | { create: { amount: string; currency: string; clientId: string } };
    const plan = await withTenants([tenantId], async (c): Promise<Plan> => {
      const scope = await resolvePortalScope(c, req.principal);
      const inv = await this.ownedInvoice(c, scope, invoiceId);
      const d = decideOnlinePayment(true, await loadOnlinePaymentFacts(c, invoiceId));
      if (!d.available) throw refuse(d);
      const open = await reusableCheckout(c, invoiceId, gw.provider.name, gw.provider.environment, d.amount);
      return open ? { reuse: open } : { create: { amount: d.amount, currency: d.currency, clientId: inv.clientId } };
    }, { modules: ["finance"] });
    if ("reuse" in plan) return plan.reuse;

    const orderId = gw.provider.mintOrderId();
    let created;
    try {
      created = await gw.provider.createCheckout({
        orderId, amount: plan.create.amount, currency: plan.create.currency,
        finishUrl: portalReturnUrl(invoiceId), expiryMinutes: config.payments.checkoutExpiryMinutes,
      });
    } catch (e) {
      if (e instanceof ProviderUnavailableError) {
        throw new ServiceUnavailableException({ message: "online payment is unavailable right now; please try again in a few minutes", reason: "provider_unavailable" });
      }
      if (e instanceof ProviderRequestError) {
        console.error(`[payments] checkout refused by ${gw.provider.name} for invoice ${invoiceId}: ${e.message}`);
        throw new BadGatewayException({ message: "the payment provider could not open a checkout; please pay by bank transfer or try again later", reason: "provider_refused" });
      }
      throw e;
    }

    let retired: RetiredCheckout[] = [];
    const view = await withTenants([tenantId], async (c) => {
      // Re-admit and re-decide: the amount must still be exactly what the provider was asked to collect.
      const scope = await resolvePortalScope(c, req.principal);
      await this.ownedInvoice(c, scope, invoiceId);
      const d = decideOnlinePayment(true, await loadOnlinePaymentFacts(c, invoiceId));
      if (!d.available) throw refuse(d);
      const same = await c.query<{ same: boolean }>(`SELECT $1::numeric = $2::numeric AS same`, [d.amount, plan.create.amount]);
      if (!same.rows[0]?.same) {
        throw new ConflictException({ message: "the amount due changed while the checkout was being opened; please try again", reason: "amount_changed" });
      }
      retired = await retireStaleCheckout(c, invoiceId, gw.provider.name, gw.provider.environment, d.amount);
      return storeCheckout(c, {
        id: newId(), tenantId, invoiceId, clientId: plan.create.clientId, amount: plan.create.amount,
        currency: plan.create.currency, provider: gw.provider.name, environment: gw.provider.environment,
        providerCheckoutId: created.providerCheckoutId,
        checkoutUrl: created.checkoutUrl, expiryMinutes: config.payments.checkoutExpiryMinutes,
        createdBy: req.principal.userId ?? null, originSite: config.originSite,
      });
    }, { modules: ["finance"] });

    // After commit, best effort: a retired checkout must stop taking money at the provider (a payer still on its page
    // would otherwise pay an amount we no longer ask for). Never blocks the answer; a failure is logged, and a payment
    // that still lands is recorded by the reconciliation sweep (src/payments/process.ts).
    await expireAtProvider(gw.provider, retired);
    if (!view.reused) {
      await writeActivity(tenantId, req.principal.userId, "checkout_started", "invoice", invoiceId, {
        provider: gw.provider.name, amount: view.amount, currency: view.currency,
      });
    }
    return view;
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
    // Authorization before validation (PV5 rule): a caller who may not pay gets 403 whatever they sent.
    await authorize(req.principal, { kind: "portal", tenantId }, "pay");
    const b = body ?? {};
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("amount must be a positive number");
    // The decimal text of the JSON number travels to Postgres as numeric; no float arithmetic on it below.
    const amountText = String(b.amount).trim();
    if (!/^\d+(\.\d+)?$/.test(amountText)) throw new BadRequestException("amount must be a plain decimal number");
    if (!b.paidOn || !/^\d{4}-\d{2}-\d{2}$/.test(b.paidOn)) throw new BadRequestException("paidOn must be YYYY-MM-DD");
    // A transfer dated in the future has not happened. Compared in UTC against the DB's own clock
    // below rather than here, where the server's local date could differ from the client's by a day.
    const method = b.method ?? "bank_transfer";
    if (!PAYMENT_METHODS.has(method)) throw new BadRequestException("method must be bank_transfer|card|cash|other");

    const id = newId();
    const result = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const inv = await this.ownedInvoice(c, scope, invoiceId);
      if (inv.status === "void") throw new BadRequestException("this invoice has been cancelled");
      // PV5-04: only an ISSUED invoice accepts a claim. A legacy invoice (sent before invoices were issued through the
      // ledger) has no ledger record to settle, so a claim on it could never be confirmed (409, nothing written).
      if (!inv.arInvoiceId) {
        throw new ConflictException({
          message: "this invoice cannot take a payment here; please contact us about it",
          reason: "not_issued",
        });
      }
      const future = await c.query<{ future: boolean }>(`SELECT $1::date > current_date AS future`, [b.paidOn]);
      if (future.rows[0]?.future) throw new BadRequestException("paidOn cannot be in the future");

      // Rule 4: bound the claim by what is actually outstanding — the LEDGER's outstanding on the AR invoice (PV5-04),
      // less the claims still pending, compared in numeric. No tolerance: an allocation can never exceed what is owed,
      // so a claim beyond it could never be confirmed.
      const room = await claimHeadroom(c, invoiceId);
      if (!room) throw new ConflictException({ message: "this invoice cannot take a payment here; please contact us about it", reason: "not_issued" });
      if (!(await hasCurrencyPrecision(c, amountText, room.minorUnit))) {
        throw new BadRequestException(`amount has more decimals than ${inv.currency} allows`);
      }
      const fits = await c.query<{ fits: boolean }>(`SELECT $1::numeric <= $2::numeric AS fits`, [amountText, room.headroom]);
      if (!fits.rows[0]?.fits) {
        throw new BadRequestException(
          `amount exceeds the outstanding balance (${room.headroom} ${inv.currency}, after claims still being verified)`,
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
          inv.clientId, amountText, inv.currency, b.paidOn, method,
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
    }, { modules: ["finance"] });

    await writeActivity(tenantId, req.principal.userId, "recorded", "invoice_payment", id, {
      invoiceId, amount, via: "portal",
    });
    // Finance has to act on this, so it must reach a human rather than only a table. Best-effort AFTER
    // the write stands: a notify failure must not turn a payment the client recorded into an error.
    await this.notifyInternal(tenantId, req.principal.userId, result.inv.clientId, "invoice.payment.recorded", {
      title: `Payment recorded by client — ${result.inv.currency} ${amount}`,
      body: "Awaiting your confirmation against the bank statement.",
      href: `/invoices/${invoiceId}`,
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
                (k.ends_on IS NOT NULL AND k.ends_on < current_date) AS "termEnded",
                ${AMENDMENT_COLUMNS},
                ${CONTRACT_SIGNED_COPY_FILE_ID("k")} AS "signedCopyFileId"
           FROM contracts k LEFT JOIN projects p ON p.id = k.project_id
           ${amendmentJoins(scopeAt(1))}
          WHERE ${contractInPortalScope("k", scopeAt(1))}
          ORDER BY k.created_at DESC LIMIT 200`,
        scopeValues(scope),
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
          `SELECT party, signer_name AS "signerName", signer_title AS "signerTitle", signed_at AS "signedAt", provider
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
      const clientSigned = signatures.rows.some((s: Record<string, unknown>) => s.party === "client");
      // DW-10f-2a (BFF §61.6): the contract is already admitted through the portal scope (ownedContract), so its schedule
      // is the caller's to read. Null without instalments; the date of an addition after signing, never who.
      const schedule = await readPortalSchedule(c, contractId);
      return {
        ...k,
        schedule,
        certifiedSigning: this.certifiedSigningView(tenantId, k, canSignFor(scope, k.clientId), clientSigned),
        // `canSign` is the exact conjunction the POST below enforces, surfaced so the UI disables the
        // button for the same reasons the server would refuse — rather than offering an action that
        // 403s. Kept as ONE expression in ONE place for that reason.
        // PV5-06: a certified-tier contract is signed through a provider, never by typed name, so it is never
        // offered to the typed-name form (the POST refuses it the same way).
        // Portal scope per client (2026-10-13): the capability is the caller's on THIS CONTRACT'S client, the
        // same `requireSignerFor(scope, k.clientId)` the POST enforces. A signer of another client reads false.
        canSign: canSignFor(scope, k.clientId) && k.status === "sent" && k.signatureTier !== "certified"
          && !signatures.rows.some((s: Record<string, unknown>) => s.party === "client"),
        viewOnly: !canSignFor(scope, k.clientId),
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
    @Body() body: { signerName?: string; signerTitle?: string; agree?: boolean; contentSha256?: string },
  ) {
    const b = body ?? {};
    // PV5-06: AUTHORIZE BEFORE VALIDATING. This used to read the body first, so a caller who may not sign got
    // a 400 about the body instead of a 403, and a denial test with a thin body silently stopped testing
    // authorization.
    await authorize(req.principal, { kind: "portal", tenantId }, "sign");
    const signerName = (b.signerName ?? "").trim();
    // PV5-06: the client signs WHAT THEY SAW. `contentSha256` is the hash the GET handed them; it is only an
    // echo, compared below against the hash the server fixed at send. It is never stored and never trusted.
    const echoed = typeof b.contentSha256 === "string" ? b.contentSha256.trim().toLowerCase() : "";

    const out = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      // Portal scope per client (2026-10-13): reach first (a contract outside the caller's scope is 404,
      // never 403), then the capability on THIS CONTRACT'S client, then the body. A signer of another client
      // the caller also represents grants nothing here.
      const k = await this.ownedContract(c, scope, contractId);
      requireSignerFor(scope, k.clientId);
      // An explicit attestation is what makes a typed name a signature rather than a form field. Refused
      // server-side so the record can never contain a signature the signer did not affirm.
      if (b.agree !== true) throw new BadRequestException("you must confirm you agree to the terms");
      if (signerName.length < 2) throw new BadRequestException("signerName required");
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
      // PV5-06: a certified-tier contract is signed through a certified provider, never by a typed name.
      if (k.signatureTier === "certified") {
        throw new BadRequestException({
          message: "this agreement is signed through a certified signing provider, not by typed name",
          reason: "certified_tier",
        });
      }
      // PV5-06: sign what you saw. A contract sent since PV5-06 carries the hash fixed at send; the echo must
      // match it, else NOTHING is written. A contract sent before PV5-06 carries none (it cannot be repaired:
      // nothing recorded what it said), so it signs as it always did and its signature records no hash.
      if (k.contentSha256) {
        if (!echoed) {
          throw new BadRequestException({
            message: "contentSha256 is required: reload the agreement and sign again",
            reason: "content_hash_required",
          });
        }
        if (echoed !== k.contentSha256) {
          throw new ConflictException({
            message: "this agreement changed since you opened it; reload it and read it again before signing",
            reason: "content_changed",
          });
        }
      }

      const ins = await c.query(
        // DW-10f-2a (BFF §61.2): the signature also records the schedule it covers, copied from the contract row
        // (never from the request), exactly as content_sha256 is.
        `INSERT INTO contract_signatures
           (id, tenant_id, contract_id, party, signer, signer_name, signer_title, ip_hash, user_agent, content_sha256,
            schedule_sha256, origin_site)
         VALUES ($1, $2, $3, 'client', $4, $5, $6, $7, $8, $9, (SELECT schedule_sha256 FROM contracts WHERE id = $3), $10)
         ON CONFLICT (contract_id, party) DO NOTHING`,
        [
          newId(), tenantId, contractId, req.principal.userId,
          scrubText(signerName).text.slice(0, 200),
          b.signerTitle ? scrubText(b.signerTitle).text.slice(0, 200) : null,
          hashForEvidence(clientIpOf(req), tenantId),
          userAgentOf(req),
          k.contentSha256,
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
      const r = await c.query<{ storage_key: string | null; content_type: string; filename: string; target_entity_type: string; target_entity_id: string; role: string | null }>(
        `SELECT storage_key, content_type, filename, target_entity_type, target_entity_id, role
           FROM files WHERE id = $1 AND deleted_at IS NULL`,
        [fileId],
      );
      const f = r.rows[0];
      if (!f) throw new NotFoundException("file not found");
      const kind = DOWNLOADABLE[f.target_entity_type];
      if (!kind) throw new NotFoundException("file not found");
      // PV5-07: under an invoice, only the invoice of record's PDF is a client document.
      if (kind === "invoice" && f.role !== "invoice_pdf") throw new NotFoundException("file not found");
      // PV7-04a: under a client report, only its own role file is a client document.
      if (kind === "client_report" && f.role !== CLIENT_REPORT_FILE_ROLE) throw new NotFoundException("file not found");
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

  /** `c` must declare the finance module scope (the AR join; see listInvoices). */
  private async ownedInvoice(c: PoolClient, scope: PortalScope, invoiceId: string) {
    const r = await c.query<{
      id: string; clientId: string; status: string; currency: string; total: number; lines: unknown;
      periodStart: string | null; periodEnd: string | null; issuedAt: string; clientName: string | null;
      payable: boolean; arInvoiceId: string | null;
    }>(
      `SELECT i.id, i.client_id AS "clientId", i.status, i.currency, i.total::float8 AS total, i.lines,
              to_char(i.period_start, 'YYYY-MM-DD') AS "periodStart",
              to_char(i.period_end, 'YYYY-MM-DD') AS "periodEnd",
              COALESCE(i.issued_at, i.created_at) AS "issuedAt", cl.name AS "clientName",
              i.ar_invoice_id AS "arInvoiceId",
              ${PORTAL_INVOICE_RECORD_COLUMNS},
              ${INVOICE_PDF_FILE_ID("i")} AS "pdfFileId"
         FROM invoices i LEFT JOIN clients cl ON cl.id = i.client_id
         LEFT JOIN finance_ar_invoices ar ON ar.id = i.ar_invoice_id
        WHERE i.id = $1 AND ${invoiceInPortalScope("i", { clients: 2 })}`,
      [invoiceId, scope.clientIds],
    );
    if (!r.rows[0]) throw new NotFoundException("invoice not found");
    return r.rows[0];
  }

  /** PV5-11 — the certified-signing block of the portal contract detail (BFF §16b, §30d). Null for an attested contract.
   *  `canStart` is the exact conjunction `POST …/certified-signing` enforces (signer of THIS client, sent, not signed by the
   *  client yet, term not ended, the provider switched on and the one the envelope is at), so the page offers "Sign with
   *  <provider>" for the same reasons the server would accept it. `signingUrl` is set once the envelope exists. */
  private certifiedSigningView(
    tenantId: string,
    k: { status: string; termEnded: boolean; signatureTier: string | null; signatureProvider: string | null; providerEnvelopeId: string | null },
    signer: boolean,
    clientSigned: boolean,
  ) {
    if (k.signatureTier !== "certified") return null;
    const account = k.signatureProvider ? signatureAccountNamed(k.signatureProvider) : certifiedSigningAccount();
    const canStart = !!account && signer && k.status === "sent" && !clientSigned && !k.termEnded;
    return {
      provider: account?.name ?? k.signatureProvider,
      label: account?.label ?? null,
      simulated: account ? account.simulated : k.signatureProvider === SIMULATED_PROVIDER,
      available: !!account,
      envelopeStarted: !!k.providerEnvelopeId,
      canStart,
      signingUrl: canStart && account && k.providerEnvelopeId ? account.forCompany(tenantId).signingUrl(k.providerEnvelopeId, "client") : null,
    };
  }

  private async ownedContract(c: PoolClient, scope: PortalScope, contractId: string) {
    const r = await c.query<{
      id: string; clientId: string; title: string; status: string; termEnded: boolean; fileId: string | null;
      contentSha256: string | null; signatureTier: string | null; signatureProvider: string | null; providerEnvelopeId: string | null;
    }>(
      `SELECT k.id, k.client_id AS "clientId", k.title, k.reference, k.version, k.status,
              k.value::float8 AS value, k.currency, k.body_md AS "bodyMd", k.file_id AS "fileId",
              k.content_sha256 AS "contentSha256", k.signature_tier AS "signatureTier",
              k.signature_provider AS "signatureProvider", k.provider_envelope_id AS "providerEnvelopeId",
              to_char(k.starts_on, 'YYYY-MM-DD') AS "startsOn",
              to_char(k.ends_on, 'YYYY-MM-DD') AS "endsOn",
              k.sent_at AS "sentAt", k.signed_at AS "signedAt", k.decline_reason AS "declineReason",
              k.project_id AS "projectId",
              (k.ends_on IS NOT NULL AND k.ends_on < current_date) AS "termEnded",
              ${AMENDMENT_COLUMNS},
              ${CONTRACT_SIGNED_COPY_FILE_ID("k")} AS "signedCopyFileId"
         FROM contracts k
         ${amendmentJoins(scopeAt(2))}
        WHERE k.id = $1 AND ${contractInPortalScope("k", scopeAt(2))}`,
      [contractId, ...scopeValues(scope)],
    );
    if (!r.rows[0]) throw new NotFoundException("contract not found");
    return r.rows[0];
  }

  /** Does the caller's client own this entity? One switch, so the download route's reachability set is
   *  exactly DOWNLOADABLE and adding a kind there without adding a branch here fails CLOSED. */
  private async ownsEntity(
    c: PoolClient, scope: PortalScope, kind: DownloadableKind, id: string,
  ): Promise<boolean> {
    const q = {
      // Ownership travels through the project, because `deliverables.client_id` is nullable and a
      // deliverable on the client's project with a NULL client_id is the common case.
      // PV3-02c: the project must itself be visible (not soft-deleted), as on every deliverable list.
      deliverable: `SELECT 1 FROM deliverables d JOIN projects p ON p.id = d.project_id
                     WHERE d.id = $1 AND ${deliverableClientVisible("d")}
                       AND ${projectInPortalScope("p", scopeAt(2))}`,
      project: `SELECT 1 FROM projects p WHERE p.id = $1
                  AND ${projectInPortalScope("p", scopeAt(2))}`,
      contract: `SELECT 1 FROM contracts k WHERE k.id = $1
                   AND ${contractInPortalScope("k", scopeAt(2))}`,
      // Their own receipt, reached THROUGH its invoice (PV3-02c): the invoice must be one the portal
      // shows (not deleted, not a draft) and one of the caller's clients, so a payment on a deleted
      // invoice has no receipt. Scoped on the invoice's client, NOT on recorded_by: a colleague at the
      // same client legitimately reads it, and a staff-recorded payment has no client recorder at all.
      invoice_payment: `SELECT 1 FROM invoice_payments pp JOIN invoices i ON i.id = pp.invoice_id
                         WHERE pp.id = $1 AND ${invoicePaymentClientVisible("pp", "detail")}
                           AND ${invoiceInPortalScope("i", { clients: 2 })}`,
      // PV4-03: a message attachment, reached THROUGH its thread. The thread predicate carries both
      // halves of layer 3 (the caller's clients AND, for a project-scoped contact, their projects with NO
      // client-wide-thread admission, PV4-Q1). A message retracted under the retired 15-minute window (PV-D34) keeps its files withdrawn.
      conversation: `SELECT 1 FROM conversation_messages m JOIN conversation_threads t ON t.id = m.thread_id
                      WHERE m.id = $1 AND ${conversationAttachmentClientVisible("m")}
                        AND ${conversationThreadInPortalScope("t", scopeAt(2))}`,
      // PV5-07: only an ISSUED invoice (the invoice of record) has a downloadable document, and only in scope.
      invoice: `SELECT 1 FROM invoices i WHERE i.id = $1 AND i.issued_at IS NOT NULL
                  AND ${invoiceInPortalScope("i", { clients: 2 })}`,
      // PV7-04a: a client report's file, reached THROUGH the report: published, and in reach by the strict shape (a report with
      // no project reaches client-wide contacts only). Withdrawn or out of reach is the same 404 as a file that does not exist.
      client_report: `SELECT 1 FROM client_reports cr WHERE cr.id = $1
                       AND ${clientReportInPortalScope("cr", scopeAt(2))}`,
    }[kind];
    // A receipt has no project reach, so its query binds only $1/$2. Passing an unreferenced $3/$4 makes
    // Postgres refuse the statement ("could not determine data type of parameter $3"), which 500s the
    // download for EVERY caller: no test had exercised the receipt route before PV3-02c.
    const clientOnly = kind === "invoice_payment" || kind === "invoice";
    const r = await c.query(q, clientOnly ? [id, scope.clientIds] : [id, ...scopeValues(scope)]);
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
                          content_type, byte_size, storage_key, sha256, scrubbed, origin_site)
       VALUES ($1, $2, $3, 'invoice_payment', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [fileId, tenantId, uploaderId, paymentId, filename, contentType, bytes.byteLength, storageKey, sha256Hex(bytes), scrubbed, config.originSite],
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
