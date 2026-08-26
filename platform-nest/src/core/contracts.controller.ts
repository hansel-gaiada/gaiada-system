// CP-19 — the STAFF counterpart to the client portal's commerce surface: authoring and sending
// contracts, countersigning them, and confirming the payments clients record.
//
// ── WHY THIS EXISTS IN THE SAME CHANGE AS THE PORTAL ──────────────────────────────────────────────
// Without it the portal's two newest sections are permanently empty and its two write paths are
// dead ends: nothing can create a contract for a client to sign, and a client-recorded payment stays
// `pending` forever because only staff may confirm it. The client half is not shippable on its own —
// "the client can sign agreements" is not true if no agreement can be created.
//
// This is deliberately MINIMAL. It is the smallest staff surface that makes the client side function
// end to end: draft, send, countersign; confirm or reject a payment; and the queues to find both. A
// richer authoring experience (templates, clause libraries, PDF generation, reminders) is a separate
// piece of work and is called out as a deferral in the deployment runbook rather than half-built here.
//
// ── THE ASYMMETRY WITH THE PORTAL IS INTENTIONAL ─────────────────────────────────────────────────
// The portal's signing path is narrow, scope-checked and idempotent because it is used by an external
// party once. This one is a staff CRUD surface authorized by Cerbos (`contract` resource) with tenant
// RLS beneath it — no per-client predicate, because staff legitimately see every contract of their
// company. That difference is why the two live in different files under different policies: a change
// to the staff surface must not be able to widen the client's.
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { scrubText } from "./scrub";
import { notifyBestEffort, resolveClientRecipients } from "./client-notify";
import { recordInvoiceRevision, snapshotInvoice } from "../modules/invoice/invoice-revisions";

const CONTRACT_SELECT = `
  SELECT k.id, k.client_id AS "clientId", cl.name AS "clientName", k.project_id AS "projectId",
         p.name AS "projectName", k.title, k.reference, k.version, k.supersedes_id AS "supersedesId",
         k.status, k.file_id AS "fileId", k.body_md AS "bodyMd",
         k.value::float8 AS value, k.currency,
         to_char(k.starts_on, 'YYYY-MM-DD') AS "startsOn",
         to_char(k.ends_on, 'YYYY-MM-DD') AS "endsOn",
         k.sent_at AS "sentAt", k.signed_at AS "signedAt", k.decline_reason AS "declineReason",
         k.created_by AS "createdBy", k.created_at AS "createdAt",
         EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'client') AS "clientSigned",
         EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'provider') AS "providerSigned",
         (k.ends_on IS NOT NULL AND k.ends_on < current_date) AS "termEnded"
    FROM contracts k
    LEFT JOIN clients cl ON cl.id = k.client_id
    LEFT JOIN projects p ON p.id = k.project_id
   WHERE k.deleted_at IS NULL`;

@Controller("api")
@UseGuards(AuthGuard)
export class ContractsController {
  @Get(":tenantId/contracts")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("clientId") clientId?: string,
    @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "contract", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `${CONTRACT_SELECT}
           AND ($1::uuid IS NULL OR k.client_id = $1)
           AND ($2::text IS NULL OR k.status = $2)
         ORDER BY k.created_at DESC LIMIT 300`,
        [clientId ?? null, status ?? null],
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/contracts/:contractId")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("contractId") contractId: string) {
    await authorize(req.principal, { kind: "contract", id: contractId, tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const rows = await c.query(`${CONTRACT_SELECT} AND k.id = $1`, [contractId]);
      if (!rows.rows[0]) throw new NotFoundException("contract not found");
      const sigs = await c.query(
        `SELECT party, signer, signer_name AS "signerName", signer_title AS "signerTitle", signed_at AS "signedAt"
           FROM contract_signatures WHERE contract_id = $1 ORDER BY signed_at ASC`,
        [contractId],
      );
      return { ...rows.rows[0], signatures: sigs.rows };
    });
  }

  /** Draft a contract. Always created `draft` — never `sent` — so the terms cannot reach a client in the
   *  same request that creates them. Sending is a separate, separately-authorized act. */
  @Post(":tenantId/contracts")
  @HttpCode(201)
  async create(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() b: {
      clientId?: string; projectId?: string; title?: string; reference?: string; bodyMd?: string;
      fileId?: string; value?: number; currency?: string; startsOn?: string; endsOn?: string;
      supersedesId?: string;
    },
  ) {
    // Pulled into locals before the guard: narrowing `b.title` does not survive into the async closure
    // below (TS re-widens an optional property read across an await), and `b.title!` would be a
    // non-null assertion standing in for a check that is right here.
    const clientId = b?.clientId;
    const title = b?.title;
    if (!clientId || !title) throw new BadRequestException("clientId and title required");
    if (b.value !== undefined && b.value !== null && !(Number.isFinite(Number(b.value)) && Number(b.value) >= 0)) {
      throw new BadRequestException("value must be a non-negative number");
    }
    if (b.startsOn && b.endsOn && b.endsOn < b.startsOn) {
      // Also a table CHECK. Refused here so the caller gets a field-level message instead of a
      // constraint-violation 500.
      throw new BadRequestException("endsOn cannot be before startsOn");
    }
    await authorize(req.principal, { kind: "contract", tenantId }, "create");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      const client = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
      if (!client.rows[0]) throw new NotFoundException("client not found");
      if (b.projectId) {
        // The project must belong to the NAMED CLIENT, not merely to this tenant. Without this, a
        // contract could be scoped to another client's project — and the portal admits a contract to a
        // project-scoped contact by project id, so the mismatch would become a cross-client read.
        const proj = await c.query(
          `SELECT 1 FROM projects WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
          [b.projectId, clientId],
        );
        if (!proj.rows[0]) throw new BadRequestException("project does not belong to that client");
      }
      // A superseding contract starts at the previous version + 1, so version history is contiguous
      // without the caller having to compute it.
      let version = 1;
      if (b.supersedesId) {
        const prev = await c.query<{ version: number; client_id: string }>(
          `SELECT version, client_id FROM contracts WHERE id = $1 AND deleted_at IS NULL`, [b.supersedesId as string],
        );
        if (!prev.rows[0]) throw new NotFoundException("superseded contract not found");
        if (prev.rows[0].client_id !== clientId) throw new BadRequestException("cannot supersede another client's contract");
        version = prev.rows[0].version + 1;
      }
      await c.query(
        `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, reference, version, supersedes_id,
                                status, file_id, body_md, value, currency, starts_on, ends_on, created_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, $11, $12, $13::date, $14::date, $15, $16)`,
        [
          id, tenantId, clientId, b.projectId ?? null,
          scrubText(title).text.slice(0, 300),
          b.reference ? scrubText(b.reference).text.slice(0, 100) : null,
          version, b.supersedesId ?? null,
          b.fileId ?? null, b.bodyMd ?? null,
          b.value ?? null, (b.currency || "IDR").slice(0, 8),
          b.startsOn ?? null, b.endsOn ?? null,
          req.principal.userId, config.originSite,
        ],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "created", "contract", id, { title });
    return { id, status: "draft" };
  }

  /** Edit a DRAFT. Refused once sent: a signed contract is never edited in place — its signature would
   *  then attest to terms the signer never saw. Re-issue via `supersedesId` instead. */
  @Patch(":tenantId/contracts/:contractId")
  async update(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("contractId") contractId: string,
    @Body() b: {
      title?: string; reference?: string; bodyMd?: string; fileId?: string; value?: number;
      currency?: string; startsOn?: string; endsOn?: string; status?: string;
    },
  ) {
    await authorize(req.principal, { kind: "contract", id: contractId, tenantId }, "update");
    await withTenants([tenantId], async (c) => {
      const cur = await c.query<{ status: string }>(
        `SELECT status FROM contracts WHERE id = $1 AND deleted_at IS NULL`, [contractId],
      );
      if (!cur.rows[0]) throw new NotFoundException("contract not found");
      // `void` is the one status transition allowed from anywhere — cancelling a sent contract must
      // stay possible. Everything else requires the contract to still be a draft.
      const voiding = b?.status === "void";
      if (cur.rows[0].status !== "draft" && !voiding) {
        throw new BadRequestException(
          `a ${cur.rows[0].status} contract cannot be edited — issue a new version with supersedesId instead`,
        );
      }
      if (b?.status && b.status !== "void" && b.status !== "draft") {
        // `send` and `countersign` have their own routes precisely so the transitions that matter are
        // not reachable by poking this field.
        throw new BadRequestException("status here may only be set to void; use /send to issue");
      }
      const res = await c.query(
        `UPDATE contracts SET
           title = COALESCE($2, title), reference = COALESCE($3, reference),
           body_md = COALESCE($4, body_md), file_id = COALESCE($5, file_id),
           value = COALESCE($6, value), currency = COALESCE($7, currency),
           starts_on = COALESCE($8::date, starts_on), ends_on = COALESCE($9::date, ends_on),
           status = COALESCE($10, status), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [
          contractId,
          b?.title ? scrubText(b.title).text.slice(0, 300) : null,
          b?.reference ? scrubText(b.reference).text.slice(0, 100) : null,
          b?.bodyMd ?? null, b?.fileId ?? null, b?.value ?? null,
          b?.currency ?? null, b?.startsOn ?? null, b?.endsOn ?? null,
          voiding ? "void" : null,
        ],
      );
      if (res.rowCount === 0) throw new NotFoundException("contract not found");
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "contract", contractId, {});
    return { ok: true };
  }

  /** Issue the contract to the client: `draft` -> `sent`, and notify their portal contacts.
   *
   *  Refuses a contract with NO document (neither an attached file nor in-app terms). A `sent` contract
   *  with nothing to read makes the portal ask a client to sign an empty page, and the portal already
   *  refuses to render a sign form in that state — so this stops the bad state at its source rather
   *  than relying on the reader to hide it. */
  @Post(":tenantId/contracts/:contractId/send")
  @HttpCode(200)
  async send(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("contractId") contractId: string) {
    await authorize(req.principal, { kind: "contract", id: contractId, tenantId }, "send");
    const out = await withTenants([tenantId], async (c) => {
      const cur = await c.query<{ status: string; client_id: string; project_id: string | null; title: string; file_id: string | null; body_md: string | null }>(
        `SELECT status, client_id, project_id, title, file_id, body_md FROM contracts
          WHERE id = $1 AND deleted_at IS NULL`,
        [contractId],
      );
      const k = cur.rows[0];
      if (!k) throw new NotFoundException("contract not found");
      if (k.status !== "draft") throw new BadRequestException(`this contract is already ${k.status}`);
      if (!k.file_id && !k.body_md) throw new BadRequestException("attach a document or write the terms before sending");
      await c.query(`UPDATE contracts SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`, [contractId]);
      await emitEvent(c, tenantId, "contract", contractId, "contract.sent", { clientId: k.client_id, title: k.title });
      // Resolved inside the transaction; the notify() calls happen after it commits.
      const recipients = await resolveClientRecipients(c, { clientId: k.client_id, projectId: k.project_id, kind: "signature" });
      return { title: k.title, recipients };
    });
    await writeActivity(tenantId, req.principal.userId, "sent", "contract", contractId, {});
    await notifyBestEffort(tenantId, req.principal.userId, out.recipients, "contract.sent", {
      title: `Please review and sign: ${out.title}`,
      href: `/portal/contracts/${contractId}`,
      entityType: "contract",
      entityId: contractId,
      severity: "warning",
    });
    return { ok: true, status: "sent", notified: out.recipients.length };
  }

  /** This company's signature. Mirrors the portal's client-side path exactly: one row per party, unique,
   *  idempotent, and the contract flips to `signed` only on the transition where BOTH are present. */
  @Post(":tenantId/contracts/:contractId/countersign")
  @HttpCode(200)
  async countersign(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("contractId") contractId: string,
    @Body() b: { signerName?: string; signerTitle?: string },
  ) {
    const signerName = (b?.signerName ?? "").trim();
    if (signerName.length < 2) throw new BadRequestException("signerName required");
    await authorize(req.principal, { kind: "contract", id: contractId, tenantId }, "countersign");
    const out = await withTenants([tenantId], async (c) => {
      const cur = await c.query<{ status: string; client_id: string; project_id: string | null; title: string }>(
        `SELECT status, client_id, project_id, title FROM contracts WHERE id = $1 AND deleted_at IS NULL`,
        [contractId],
      );
      const k = cur.rows[0];
      if (!k) throw new NotFoundException("contract not found");
      // Same ordering lesson as the portal's sign route: already-signed is checked BEFORE status,
      // because signing is what changes the status.
      const existing = await c.query(
        `SELECT 1 FROM contract_signatures WHERE contract_id = $1 AND party = 'provider'`, [contractId],
      );
      // `recipients` is always present (empty when nobody is to be told), so the two return shapes
      // agree and the caller does not have to narrow a union to read it.
      if (existing.rows[0]) return { alreadySigned: true, complete: k.status === "signed", recipients: [] as string[], ...k };
      if (k.status !== "sent") throw new BadRequestException(`a ${k.status} contract cannot be countersigned`);
      await c.query(
        `INSERT INTO contract_signatures (id, tenant_id, contract_id, party, signer, signer_name, signer_title, origin_site)
         VALUES ($1, $2, $3, 'provider', $4, $5, $6, $7) ON CONFLICT (contract_id, party) DO NOTHING`,
        [
          newId(), tenantId, contractId, req.principal.userId,
          scrubText(signerName).text.slice(0, 200),
          b?.signerTitle ? scrubText(b.signerTitle).text.slice(0, 200) : null,
          config.originSite,
        ],
      );
      const parties = await c.query<{ party: string }>(`SELECT party FROM contract_signatures WHERE contract_id = $1`, [contractId]);
      const have = new Set(parties.rows.map((r) => r.party));
      const complete = have.has("client") && have.has("provider");
      if (complete) {
        await c.query(`UPDATE contracts SET status = 'signed', signed_at = now(), updated_at = now() WHERE id = $1 AND status = 'sent'`, [contractId]);
      }
      await emitEvent(c, tenantId, "contract", contractId, complete ? "contract.signed" : "contract.provider_signed", {
        clientId: k.client_id, parties: [...have],
      });
      const recipients = complete
        ? await resolveClientRecipients(c, { clientId: k.client_id, projectId: k.project_id, kind: "general" })
        : [];
      return { alreadySigned: false, complete, recipients, ...k };
    });
    if (!out.alreadySigned) {
      await writeActivity(tenantId, req.principal.userId, "countersigned", "contract", contractId, { complete: out.complete });
      // Only on completion: telling a client "we signed" while they have not is confusing, and the
      // portal already shows them both parties' state.
      await notifyBestEffort(tenantId, req.principal.userId, out.recipients ?? [], "contract.signed", {
        title: `Agreement fully signed: ${out.title}`,
        href: `/portal/contracts/${contractId}`,
        entityType: "contract",
        entityId: contractId,
        severity: "info",
      });
    }
    return { ok: true, complete: out.complete, alreadySigned: out.alreadySigned };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Payment confirmation — the other half of the portal's payment ledger
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  /** Finance's queue: payments clients have recorded and nobody has verified.
   *
   *  Authorized on `invoice` rather than a new resource kind: this IS invoice finance, and inventing a
   *  `payment` resource would mean a second policy to keep in step with resource_invoice.yaml for no
   *  additional expressiveness. */
  @Get(":tenantId/invoice-payments")
  async listPayments(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "invoice", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT pp.id, pp.invoice_id AS "invoiceId", pp.client_id AS "clientId", cl.name AS "clientName",
                pp.amount::float8 AS amount, pp.currency, to_char(pp.paid_on, 'YYYY-MM-DD') AS "paidOn",
                pp.method, pp.reference, pp.status, pp.note, pp.proof_file_id AS "proofFileId",
                pp.recorded_by AS "recordedBy", pp.created_at AS "recordedAt",
                pp.confirmed_by AS "confirmedBy", pp.confirmed_at AS "confirmedAt",
                pp.rejected_reason AS "rejectedReason",
                i.total::float8 AS "invoiceTotal", i.status AS "invoiceStatus"
           FROM invoice_payments pp
           JOIN invoices i ON i.id = pp.invoice_id
           LEFT JOIN clients cl ON cl.id = pp.client_id
          WHERE pp.deleted_at IS NULL AND ($1::text IS NULL OR pp.status = $1)
          ORDER BY (pp.status = 'pending') DESC, pp.paid_on DESC LIMIT 300`,
        [status ?? null],
      ),
    );
    return rows.rows;
  }

  /** Confirm or reject a client-recorded payment.
   *
   *  Confirming is what makes money real in this system: only `confirmed` rows count toward a balance
   *  (see the portal's finance query). So this is also the ONLY place `invoices.status` moves to `paid`,
   *  and it does so by comparing the CONFIRMED total against the invoice — never by trusting the
   *  incoming request. A client cannot reach this route at all: `invoice`/`update` is not granted to the
   *  `client` derived role. */
  @Post(":tenantId/invoice-payments/:paymentId/decide")
  @HttpCode(200)
  async decidePayment(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("paymentId") paymentId: string,
    @Body() b: { decision?: string; reason?: string },
  ) {
    const decision = b?.decision;
    if (decision !== "confirm" && decision !== "reject") throw new BadRequestException("decision must be confirm|reject");
    if (decision === "reject" && !(b?.reason ?? "").trim()) {
      // A rejection with no reason leaves the client unable to tell whether to re-send the transfer or
      // query the reference. The portal renders this string in the payment row.
      throw new BadRequestException("a reason is required when rejecting a payment");
    }
    await authorize(req.principal, { kind: "invoice", id: paymentId, tenantId }, "update");

    const out = await withTenants([tenantId], async (c) => {
      const cur = await c.query<{ status: string; invoice_id: string; client_id: string | null; amount: string; currency: string; recorded_by: string | null }>(
        `SELECT status, invoice_id, client_id, amount, currency, recorded_by FROM invoice_payments
          WHERE id = $1 AND deleted_at IS NULL`,
        [paymentId],
      );
      const pay = cur.rows[0];
      if (!pay) throw new NotFoundException("payment not found");
      if (pay.status !== "pending") throw new BadRequestException(`this payment is already ${pay.status}`);
      // The confirmer must not be the recorder. On a staff-recorded payment `recorded_by` is a staff
      // member, and one person both claiming and verifying the same money defeats the split the two
      // columns exist to express (see 0075's header).
      if (pay.recorded_by && pay.recorded_by === req.principal.userId) {
        throw new ForbiddenException("a payment must be confirmed by someone other than whoever recorded it");
      }

      if (decision === "reject") {
        await c.query(
          `UPDATE invoice_payments SET status = 'rejected', rejected_reason = $2, confirmed_by = $3,
             confirmed_at = now(), updated_at = now() WHERE id = $1`,
          [paymentId, scrubText(String(b?.reason ?? "")).text.slice(0, 500), req.principal.userId],
        );
        await emitEvent(c, tenantId, "invoice_payment", paymentId, "invoice.payment.rejected", {
          invoiceId: pay.invoice_id, clientId: pay.client_id,
        });
        return { decision, invoiceId: pay.invoice_id, clientId: pay.client_id, amount: Number(pay.amount), currency: pay.currency, invoicePaid: false };
      }

      await c.query(
        `UPDATE invoice_payments SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), updated_at = now()
          WHERE id = $1`,
        [paymentId, req.principal.userId],
      );
      // Derive the invoice's status from the confirmed ledger. Compared with a small tolerance because
      // `numeric` sums of client-entered amounts land a rupiah short of the total often enough that
      // requiring exact equality would leave settled invoices showing as unpaid forever.
      const totals = await c.query<{ total: string; confirmed: string }>(
        `SELECT i.total::text AS total,
                COALESCE((SELECT sum(pp.amount) FROM invoice_payments pp
                           WHERE pp.invoice_id = i.id AND pp.status = 'confirmed' AND pp.deleted_at IS NULL), 0)::text AS confirmed
           FROM invoices i WHERE i.id = $1`,
        [pay.invoice_id],
      );
      const total = Number(totals.rows[0]?.total ?? 0);
      const confirmed = Number(totals.rows[0]?.confirmed ?? 0);
      const fullyPaid = confirmed >= total - 1;
      if (fullyPaid) {
        // IAM-GAP-02: this is the THIRD (and last) place invoices.status ever moves — outside the
        // invoice module entirely. Snapshot before the conditional UPDATE; only record a revision
        // if the UPDATE actually matched a row (it may not: a `void` invoice must not be
        // resurrected to `paid` by a late confirmation, so "0 rows updated" is a legitimate no-op,
        // not an error, and must not fabricate a revision for a mutation that didn't happen).
        const before = await snapshotInvoice(c, pay.invoice_id);
        const res = await c.query(
          `UPDATE invoices SET status = 'paid', updated_by = $2, updated_at = now() WHERE id = $1 AND status = 'sent'`,
          [pay.invoice_id, req.principal.userId],
        );
        if (res.rowCount && res.rowCount > 0) {
          await recordInvoiceRevision(c, tenantId, pay.invoice_id, req.principal.userId, "paid_via_payment_confirmation", before);
        }
        await emitEvent(c, tenantId, "invoice", pay.invoice_id, "invoice.updated", { status: "paid" });
      }
      await emitEvent(c, tenantId, "invoice_payment", paymentId, "invoice.payment.confirmed", {
        invoiceId: pay.invoice_id, clientId: pay.client_id, amount: Number(pay.amount),
      });
      return { decision, invoiceId: pay.invoice_id, clientId: pay.client_id, amount: Number(pay.amount), currency: pay.currency, invoicePaid: fullyPaid };
    });

    await writeActivity(tenantId, req.principal.userId, out.decision === "confirm" ? "confirmed" : "rejected",
      "invoice_payment", paymentId, { invoiceId: out.invoiceId });

    // Tell the client either way. A rejection they are never told about is the worst outcome here: they
    // believe they have paid and we believe they have not.
    if (out.clientId) {
      const recipients = await withTenants([tenantId], (c) =>
        resolveClientRecipients(c, { clientId: out.clientId, projectId: null, kind: "general" }),
      );
      await notifyBestEffort(tenantId, req.principal.userId, recipients,
        out.decision === "confirm" ? "invoice.payment.confirmed" : "invoice.payment.rejected", {
          title: out.decision === "confirm"
            ? `Payment confirmed — thank you`
            : `We couldn't match your payment`,
          body: out.decision === "confirm"
            ? (out.invoicePaid ? "Your invoice is now fully settled." : "Your balance has been updated.")
            : String(b?.reason ?? "").slice(0, 280),
          href: `/portal/invoices/${out.invoiceId}`,
          entityType: "invoice",
          entityId: out.invoiceId,
          severity: out.decision === "confirm" ? "info" : "warning",
        });
    }
    return { ok: true, decision: out.decision, invoicePaid: out.invoicePaid };
  }
}
