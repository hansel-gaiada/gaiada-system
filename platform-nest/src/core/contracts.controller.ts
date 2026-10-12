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
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { currentVia } from "./request-context";
import { clientFilterSql, parseClientFilter } from "./client-filter";
import { contractClientVisible, staffClientVisible, staffInvoicePaymentClientVisible } from "./portal-visibility";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { scrubText } from "./scrub";
import { notifyBestEffort, resolveClientRecipients } from "./client-notify";
import { recordInvoiceRevision, snapshotInvoice } from "../modules/invoice/invoice-revisions";
import { check, type Resource } from "../rbac/cerbos";
import { assemblePrincipal, type Principal } from "../rbac/principal";
import { contractContentSha256 } from "./content-hash";
import { clientIpOf, hashForEvidence, userAgentOf } from "./evidence";
import { certifiedSigningProvider, NO_CERTIFIED_PROVIDER } from "./signature-provider";

// PV3-07: `clientVisible` (a client-wide contact of the contract's client can read it in the portal) is
// composed from the portal's own predicate, so a draft reads `false` here for exactly the reason the
// portal hides it. Shared by the list and the detail.
const CONTRACT_SELECT = `
  SELECT k.id, k.client_id AS "clientId", cl.name AS "clientName", k.project_id AS "projectId",
         p.name AS "projectName", k.title, k.reference, k.version, k.supersedes_id AS "supersedesId",
         k.status, k.file_id AS "fileId", k.body_md AS "bodyMd",
         k.value::float8 AS value, k.currency,
         to_char(k.starts_on, 'YYYY-MM-DD') AS "startsOn",
         to_char(k.ends_on, 'YYYY-MM-DD') AS "endsOn",
         k.sent_at AS "sentAt", k.signed_at AS "signedAt", k.decline_reason AS "declineReason",
         k.content_sha256 AS "contentSha256", k.content_fixed_at AS "contentFixedAt",
         k.signature_tier AS "signatureTier", k.certified_requested AS "certifiedRequested",
         k.created_by AS "createdBy", k.created_at AS "createdAt",
         EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'client') AS "clientSigned",
         EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'provider') AS "providerSigned",
         (k.ends_on IS NOT NULL AND k.ends_on < current_date) AS "termEnded",
         ${staffClientVisible("k", contractClientVisible("k"))} AS "clientVisible"
    FROM contracts k
    LEFT JOIN clients cl ON cl.id = k.client_id
    LEFT JOIN projects p ON p.id = k.project_id
   WHERE k.deleted_at IS NULL`;

/** PV3-01 — may this caller countersign contracts in this tenant? Feeds the `canCountersign` row flag.
 *
 *  ONE Cerbos check per request, never one per row: the countersign rule depends only on the tenant
 *  (the contract's `tenantId`), so a single decision covers every row of the response, and a per-row
 *  batch would hit Cerbos's 50-resource limit on any real list.
 *
 *  A soft probe through `check()`, not `authorize()`: a `false` here is a UI hint, not a refusal, so
 *  it must not write a "denied countersign" audit row every time a company_admin opens the list. The
 *  POST route still runs the full `authorize()`, which stays the authority. The delegation half of
 *  `authorize()` is mirrored (an `actFor` caller gets `true` only when the acting user is allowed
 *  too), so the flag can never promise more than the POST would grant. Any probe failure reads as
 *  `false`: the read it rides on has already been authorized and must not 500 over a hint. */
async function mayCountersign(p: Principal, resource: Resource): Promise<boolean> {
  try {
    if (!(await check(p, resource, "countersign")).allow) return false;
    if (p.actFor && p.actFor.userId !== p.userId) {
      const onBehalfOf = await assemblePrincipal(p.actFor.userId, p.assurance);
      if (!onBehalfOf) return false;
      return (await check({ ...onBehalfOf, via: p.via }, resource, "countersign")).allow;
    }
    return true;
  } catch {
    return false;
  }
}

/** A row is countersignable only while it waits for us: `sent`, and no provider signature yet. */
function withCountersign<T extends { status: string; providerSigned: boolean }>(row: T, may: boolean) {
  return { ...row, canCountersign: may && row.status === "sent" && !row.providerSigned };
}

/** PV5-06 (plan decision 13) — the signature tier a contract takes when it is sent.
 *
 *  `certified` when staff marked it, when its value reaches the company's `signature_threshold`, or when it
 *  amends a certified agreement (the default for PV5-Q1); otherwise `attested`. The threshold is NULL until counsel
 *  sets one. Once one exists:
 *    * an unvalued contract is refused (a missing value would silently escape the rule), and
 *    * a value in a different currency than the threshold's is refused (it cannot be compared).
 *  Both refusals are 400s that say what to fix. */
async function signatureTierFor(
  c: PoolClient, tenantId: string,
  k: { value: string | null; currency: string; certified_requested: boolean; kind: string; amends_id: string | null },
): Promise<"attested" | "certified"> {
  const prof = await c.query<{ threshold: string | null; currency_code: string; over: boolean | null }>(
    `SELECT signature_threshold::text AS threshold, currency_code,
            CASE WHEN $2::numeric IS NULL OR signature_threshold IS NULL THEN NULL ELSE $2::numeric >= signature_threshold END AS over
       FROM company_billing_profiles WHERE tenant_id = $1`,
    [tenantId, k.value],
  );
  const p = prof.rows[0];
  const threshold = p?.threshold ?? null;
  let overThreshold = false;
  if (threshold !== null) {
    if (k.value === null) {
      throw new BadRequestException("set the contract's value before sending: this company has a signature threshold, and an unvalued contract cannot be placed against it");
    }
    if (k.currency !== p.currency_code) {
      throw new BadRequestException(`the contract is in ${k.currency} but the signature threshold is set in ${p.currency_code}; they cannot be compared, so set the contract's value in ${p.currency_code}`);
    }
    overThreshold = p.over === true;
  }
  let amendsCertified = false;
  if (k.kind === "amendment" && k.amends_id) {
    const base = await c.query<{ signature_tier: string | null }>(
      `SELECT signature_tier FROM contracts WHERE id = $1 AND tenant_id = $2`, [k.amends_id, tenantId],
    );
    amendsCertified = base.rows[0]?.signature_tier === "certified";
  }
  return k.certified_requested || overThreshold || amendsCertified ? "certified" : "attested";
}

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
    // Parsed AFTER the read check, so an unauthorized caller gets 403, never a 400 about its query.
    // Strict (PV3-01): a malformed id is a 400. It used to reach a `::uuid` cast and 500.
    // `internal` means `client_id IS NULL`; `contracts.client_id` is NOT NULL, so it is always empty
    // here, and that is the honest answer (one vocabulary across every client-filterable list).
    const filter = clientFilterSql(parseClientFilter(clientId, true), "k.client_id", 2);
    const [rows, may] = await Promise.all([
      withTenants([tenantId], (c) =>
        c.query<{ status: string; providerSigned: boolean }>(
          `${CONTRACT_SELECT}
             AND ($1::text IS NULL OR k.status = $1)
             AND ${filter.sql}
           ORDER BY k.created_at DESC LIMIT 300`,
          [status ?? null, ...filter.params],
        ),
      ),
      mayCountersign(req.principal, { kind: "contract", tenantId }),
    ]);
    return rows.rows.map((r) => withCountersign(r, may));
  }

  @Get(":tenantId/contracts/:contractId")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("contractId") contractId: string) {
    await authorize(req.principal, { kind: "contract", id: contractId, tenantId }, "read");
    const may = await mayCountersign(req.principal, { kind: "contract", id: contractId, tenantId });
    return withTenants([tenantId], async (c) => {
      const rows = await c.query<{ status: string; providerSigned: boolean }>(`${CONTRACT_SELECT} AND k.id = $1`, [contractId]);
      if (!rows.rows[0]) throw new NotFoundException("contract not found");
      const sigs = await c.query(
        `SELECT party, signer, signer_name AS "signerName", signer_title AS "signerTitle", signed_at AS "signedAt",
                content_sha256 AS "contentSha256"
           FROM contract_signatures WHERE contract_id = $1 ORDER BY signed_at ASC`,
        [contractId],
      );
      return { ...withCountersign(rows.rows[0], may), signatures: sigs.rows };
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
    // PV3-06: AUTHORIZE BEFORE VALIDATING, as on `countersign` and `decide`: an unauthorized caller gets 403
    // whatever the body holds. This used to validate first, so a denial test with a thin body saw a 400.
    await authorize(req.principal, { kind: "contract", tenantId }, "create");
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
    // PV3-06 / agentic-native criterion 3 (idempotent writes). The natural dedupe key is the partial
    // unique index `ix_contracts_reference_uniq` on (tenant_id, reference, version) WHERE reference IS NOT
    // NULL: the insert below is `ON CONFLICT … DO NOTHING`, and a conflict returns the contract that is
    // already there (`deduped: true`) instead of a second row or a constraint-violation 500. The tool
    // `contracts.createDraft` makes `reference` required, so an agent or n8n retry is always covered;
    // a human draft with no reference has no natural key and still inserts every time (SQL NULLs are
    // distinct), exactly as before.
    const reference = b.reference ? scrubText(b.reference).text.slice(0, 100) : null;
    const newContractId = newId();
    const { id, existing } = await withTenants([tenantId], async (c) => {
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
      const ins = await c.query(
        `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, reference, version, supersedes_id,
                                status, file_id, body_md, value, currency, starts_on, ends_on, created_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, $11, $12, $13::date, $14::date, $15, $16)
         ON CONFLICT (tenant_id, reference, version) WHERE reference IS NOT NULL AND deleted_at IS NULL DO NOTHING`,
        [
          newContractId, tenantId, clientId, b.projectId ?? null,
          scrubText(title).text.slice(0, 300),
          reference,
          version, b.supersedesId ?? null,
          b.fileId ?? null, b.bodyMd ?? null,
          b.value ?? null, (b.currency || "IDR").slice(0, 8),
          b.startsOn ?? null, b.endsOn ?? null,
          req.principal.userId, config.originSite,
        ],
      );
      if (ins.rowCount) return { id: newContractId, existing: null };
      // A replay (or a concurrent twin: ON CONFLICT waits for the other insert to commit). Hand back the
      // contract that holds this key, but only for the SAME client: the same reference under another
      // client is a different request that happens to collide, and answering it with that client's
      // contract id would leak it across clients.
      const dup = await c.query<{ id: string; client_id: string; status: string }>(
        `SELECT id, client_id, status FROM contracts
          WHERE reference = $1 AND version = $2 AND deleted_at IS NULL`,
        [reference, version],
      );
      const hit = dup.rows[0];
      if (!hit) throw new ConflictException("contract reference is in use");
      if (hit.client_id !== clientId) throw new ConflictException("that reference is already used by another contract");
      return { id: hit.id, existing: { status: hit.status } };
    });
    if (existing) return { id, status: existing.status, deduped: true };
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
    // PV3-06: an agent or n8n call (anything that arrives through the hub's OBO envelope, which is what sets
    // `currentVia()`; a staff browser session never does) may edit a draft but never change its status. The
    // `contracts.updateDraft` tool is LOW impact and its schema omits `status`, but the hub does not enforce
    // schemas, and void is allowed from ANY state here, so without this an unattended caller could void a sent
    // or signed contract. Voiding stays a human act (the UI). Typed code, checked after authorize().
    if (currentVia() && b?.status !== undefined) {
      throw new BadRequestException("status_not_allowed_via_automation");
    }
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
   *  than relying on the reader to hide it.
   *
   *  PV5-06 (PV-D8, plan decisions 11 and 13) — SENDING FIXES THE CONTENT AND CHOOSES THE TIER, in ONE UPDATE:
   *    * `content_sha256` = SHA-256 of the attached file's STORED bytes, else of the exact UTF-8 `body_md`,
   *      computed here from what the server holds (never from anything the caller supplied), with
   *      `content_fixed_at`. From this statement on the database's freeze trigger refuses any change to the
   *      file, the body, the hash, the stamp or the tier.
   *    * `signature_tier` = `certified` when staff marked the contract, or its value reaches the company's
   *      `signature_threshold`, or it amends a certified agreement; else `attested`. Never changes afterwards.
   *    * Once a threshold exists an UNVALUED contract cannot be sent: a missing value would silently escape it.
   *      A value in a currency other than the threshold's cannot be compared, so that is refused too (failing
   *      closed: never an attested contract that should have been certified).
   *    * A certified tier needs a certified provider (PV5-11, parked by PV-D25). With none set up the send is
   *      refused 409 rather than producing a contract nobody can sign. */
  @Post(":tenantId/contracts/:contractId/send")
  @HttpCode(200)
  async send(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("contractId") contractId: string) {
    await authorize(req.principal, { kind: "contract", id: contractId, tenantId }, "send");
    const out = await withTenants([tenantId], async (c) => {
      // FOR UPDATE: two concurrent sends must not both fix content (the second sees `sent` and is refused).
      const cur = await c.query<{
        status: string; client_id: string; project_id: string | null; title: string; file_id: string | null; body_md: string | null;
        value: string | null; currency: string; certified_requested: boolean; kind: string; amends_id: string | null;
      }>(
        `SELECT status, client_id, project_id, title, file_id, body_md, value::text AS value, currency,
                certified_requested, kind, amends_id
           FROM contracts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [contractId],
      );
      const k = cur.rows[0];
      if (!k) throw new NotFoundException("contract not found");
      if (k.status !== "draft") throw new BadRequestException(`this contract is already ${k.status}`);
      if (!k.file_id && !k.body_md) throw new BadRequestException("attach a document or write the terms before sending");

      const tier = await signatureTierFor(c, tenantId, k);
      if (tier === "certified" && !certifiedSigningProvider()) {
        throw new ConflictException({ message: NO_CERTIFIED_PROVIDER, reason: "no_certified_provider" });
      }
      const sha = await contractContentSha256(c, tenantId, k);
      const upd = await c.query(
        `UPDATE contracts
            SET status = 'sent', sent_at = now(), content_sha256 = $2, content_fixed_at = now(), signature_tier = $3,
                updated_at = now()
          WHERE id = $1 AND status = 'draft'`,
        [contractId, sha, tier],
      );
      if (upd.rowCount === 0) throw new ConflictException("this contract was sent by someone else a moment ago");
      await emitEvent(c, tenantId, "contract", contractId, "contract.sent", { clientId: k.client_id, title: k.title });
      // Resolved inside the transaction; the notify() calls happen after it commits.
      const recipients = await resolveClientRecipients(c, { clientId: k.client_id, projectId: k.project_id, kind: "signature" });
      return { title: k.title, recipients, sha, tier };
    });
    await writeActivity(tenantId, req.principal.userId, "sent", "contract", contractId, { contentSha256: out.sha, signatureTier: out.tier });
    await notifyBestEffort(tenantId, req.principal.userId, out.recipients, "contract.sent", {
      title: `Please review and sign: ${out.title}`,
      href: `/portal/contracts/${contractId}`,
      entityType: "contract",
      entityId: contractId,
      severity: "warning",
    });
    return { ok: true, status: "sent", notified: out.recipients.length, contentSha256: out.sha, signatureTier: out.tier };
  }

  /** PV5-06 — "Mark certified" (PV-D8): staff ask for the certified (PSrE) signature tier for a DRAFT contract.
   *  It decides the tier `send` will set; it never changes content.
   *
   *  PV-D25 parks certified signing until counsel sets a threshold or a client asks, so with no provider set up
   *  this answers 409 "no certified signing provider is set up" and writes nothing. AUTHORIZED FIRST (Cerbos
   *  `contract` / `mark_certified`, PV5-02), so a denied caller gets 403 whatever the state. `{ certified: false }`
   *  clears the mark. */
  @Post(":tenantId/contracts/:contractId/mark-certified")
  @HttpCode(200)
  async markCertified(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("contractId") contractId: string,
    @Body() b: { certified?: boolean },
  ) {
    await authorize(req.principal, { kind: "contract", id: contractId, tenantId }, "mark_certified");
    const certified = b?.certified !== false;
    if (certified && !certifiedSigningProvider()) {
      throw new ConflictException({ message: NO_CERTIFIED_PROVIDER, reason: "no_certified_provider" });
    }
    await withTenants([tenantId], async (c) => {
      const cur = await c.query<{ status: string }>(
        `SELECT status FROM contracts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [contractId],
      );
      if (!cur.rows[0]) throw new NotFoundException("contract not found");
      if (cur.rows[0].status !== "draft") {
        throw new BadRequestException("the signature tier is fixed when a contract is sent; only a draft can be marked");
      }
      await c.query(`UPDATE contracts SET certified_requested = $2, updated_at = now() WHERE id = $1`, [contractId, certified]);
    });
    await writeActivity(tenantId, req.principal.userId, certified ? "marked_certified" : "unmarked_certified", "contract", contractId, {});
    return { ok: true, certifiedRequested: certified };
  }

  /** This company's signature. Mirrors the portal's client-side path exactly: one row per party, unique,
   *  idempotent, and the contract flips to `signed` only on the transition where BOTH are present. */
  @Post(":tenantId/contracts/:contractId/countersign")
  @HttpCode(200)
  async countersign(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("contractId") contractId: string,
    @Body() b: { signerName?: string; signerTitle?: string; contentSha256?: string },
  ) {
    // PV3-06: AUTHORIZE BEFORE VALIDATING. This used to read the body first, so a caller who may not
    // countersign got a 400 about `signerName` instead of a 403 (validation pre-empting authz), and any
    // denial test that sent an empty body silently stopped testing authorization.
    await authorize(req.principal, { kind: "contract", id: contractId, tenantId }, "countersign");
    const signerName = (b?.signerName ?? "").trim();
    if (signerName.length < 2) throw new BadRequestException("signerName required");
    const out = await withTenants([tenantId], async (c) => {
      const cur = await c.query<{
        status: string; client_id: string; project_id: string | null; title: string;
        content_sha256: string | null; signature_tier: string | null;
      }>(
        `SELECT status, client_id, project_id, title, content_sha256, signature_tier FROM contracts
          WHERE id = $1 AND deleted_at IS NULL`,
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
      // PV5-06: a certified-tier contract is signed through a certified provider, not by a typed name.
      if (k.signature_tier === "certified") {
        throw new BadRequestException({
          message: "this agreement is signed through a certified signing provider, not by typed name",
          reason: "certified_tier",
        });
      }
      // PV5-06: our signature records the SAME hash the client signed (the one fixed at send), plus the IP hash
      // and user agent exactly as the client side records them. An optional `contentSha256` is a "what I saw"
      // echo (an agent files its approval against a hash it read); when present it must match, else nothing is
      // written. When the call is a D14 re-drive (`contracts.countersign`, run as the human the agent served)
      // the IP and agent are those of the hub's hop, which is what the request really was.
      if (b?.contentSha256 !== undefined && k.content_sha256) {
        const echoed = String(b.contentSha256).trim().toLowerCase();
        if (echoed !== k.content_sha256) {
          throw new ConflictException({
            message: "this agreement changed since you read it; reload it and read it again before signing",
            reason: "content_changed",
          });
        }
      }
      await c.query(
        `INSERT INTO contract_signatures
           (id, tenant_id, contract_id, party, signer, signer_name, signer_title, ip_hash, user_agent, content_sha256, origin_site)
         VALUES ($1, $2, $3, 'provider', $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (contract_id, party) DO NOTHING`,
        [
          newId(), tenantId, contractId, req.principal.userId,
          scrubText(signerName).text.slice(0, 200),
          b?.signerTitle ? scrubText(b.signerTitle).text.slice(0, 200) : null,
          hashForEvidence(clientIpOf(req), tenantId),
          userAgentOf(req),
          k.content_sha256,
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
    @Query("clientId") clientId?: string,
  ) {
    await authorize(req.principal, { kind: "invoice", tenantId }, "read");
    // PV3-03 / CC-1: `?clientId=<uuid>|internal`, strict (a non-uuid is a 400). Filters on
    // `invoice_payments.client_id`, the denormalised column the portal's own isolation predicate uses;
    // `internal` is the payments whose invoice names no client. Parsed after authorize.
    const clientFilter = clientFilterSql(parseClientFilter(clientId, true), "pp.client_id", 2);
    // PV3-07: `clientVisible` travels through the PARENT INVOICE, as the portal shows a payment only in
    // that invoice's history ("detail" context), so a claim on a draft invoice reads `false`.
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT pp.id, pp.invoice_id AS "invoiceId", pp.client_id AS "clientId", cl.name AS "clientName",
                pp.amount::float8 AS amount, pp.currency, to_char(pp.paid_on, 'YYYY-MM-DD') AS "paidOn",
                pp.method, pp.reference, pp.status, pp.note, pp.proof_file_id AS "proofFileId",
                pp.recorded_by AS "recordedBy", pp.created_at AS "recordedAt",
                pp.confirmed_by AS "confirmedBy", pp.confirmed_at AS "confirmedAt",
                pp.rejected_reason AS "rejectedReason",
                i.total::float8 AS "invoiceTotal", i.status AS "invoiceStatus",
                ${staffInvoicePaymentClientVisible("pp", "i")} AS "clientVisible"
           FROM invoice_payments pp
           JOIN invoices i ON i.id = pp.invoice_id
           LEFT JOIN clients cl ON cl.id = pp.client_id
          WHERE pp.deleted_at IS NULL AND ($1::text IS NULL OR pp.status = $1) AND ${clientFilter.sql}
          ORDER BY (pp.status = 'pending') DESC, pp.paid_on DESC LIMIT 300`,
        [status ?? null, ...clientFilter.params],
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
    // PV3-06: authorize BEFORE validating the body (see `countersign`), so a caller who may not decide a
    // payment gets 403 whatever they sent.
    await authorize(req.principal, { kind: "invoice", id: paymentId, tenantId }, "update");
    const decision = b?.decision;
    if (decision !== "confirm" && decision !== "reject") throw new BadRequestException("decision must be confirm|reject");
    if (decision === "reject" && !(b?.reason ?? "").trim()) {
      // A rejection with no reason leaves the client unable to tell whether to re-send the transfer or
      // query the reference. The portal renders this string in the payment row.
      throw new BadRequestException("a reason is required when rejecting a payment");
    }

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
