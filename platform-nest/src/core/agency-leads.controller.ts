// AD-4/AD-5 — agency discovery intake (AD-1), STAFF reads + triage dispositions.
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md
//   §4.1 (lifecycle) · §5.2 (authz actions) · §9.2 (reviewer needs)
//
// Business logic lives in ./agency-leads.service; this file is authorize() + HTTP wiring + audit,
// mirroring the split `webdev-change-requests.controller.ts` keeps between itself and
// `webdev-cr-lock.ts`/`pm.controller.ts`'s exported helpers.
//
// ── WHY NO `ModuleEnabledGuard` (design §3.1) ────────────────────────────────────────────────────
// Every other vertical controller in `src/modules/*` carries `AuthGuard, ModuleEnabledGuard(...)`.
// This one deliberately does not: `agency_leads`/`agency_discovery_submissions` take the PLAIN
// tenant wall (MI-02's D-2a doctrine), because the primary writer (the token-guarded prospect
// intake endpoint, AD-2/AD-3) is a core surface that declares no module scope — a
// `ModuleEnabledGuard` in front of THIS file would not protect that path at all, it would only add
// an inconsistent extra gate to the STAFF side and, if `agency` were ever disabled for a tenant,
// would let a prospect submit into a queue staff could no longer open. What a module toggle would
// have bought (keeping non-agency staff out) is Cerbos's job below, via the ordinary `authorize()`
// calls — see agency-leads.service.ts's header for the matching DB-wall argument.
import {
  Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize, writeActivity } from "./http";
import { AuthGuard } from "../auth/guards";
import {
  createStaffLead, declineLead, describeIllegalTransition, getLeadDetail, listLeadsQueue,
  listLeadSubmissions, normalizeCreateLeadInput, normalizeDeclineReason, nurtureLead, openLead,
  type TransitionOutcome,
} from "./agency-leads.service";
import { mintInviteToken, revokeIntakeToken } from "./agency-intake-tokens.service";

/** Turns a `TransitionOutcome` into the HTTP response for a triage endpoint, or throws the typed
 *  refusal — shared by open/decline/nurture so the three endpoints cannot drift in how they report
 *  "not found" vs "illegal transition" (criterion 5: never a silent no-op, never folded into a
 *  success-shaped response). */
function resolveOrThrow(
  action: "open" | "decline" | "nurture",
  leadId: string,
  result: TransitionOutcome,
  toStatus: string,
): { id: string; status: string } {
  if (result.outcome === "not_found") throw new NotFoundException("lead not found");
  if (result.outcome === "illegal") {
    throw new ConflictException(describeIllegalTransition(action, result.currentStatus));
  }
  return { id: leadId, status: toStatus };
}

@Controller("api")
@UseGuards(AuthGuard)
export class AgencyLeadsController {
  // ── Reads (AD-4) ────────────────────────────────────────────────────────────────────────────
  /** The queue. Cerbos `read` on `agency_lead` — tenant-wide (no `id`): row reach beyond the
   *  tenant wall is RLS's job, since a staff reader legitimately sees the whole tenant's queue
   *  (same posture `webdev-change-requests.controller.ts`'s `list()` takes). `authorize()` is
   *  called BEFORE any query runs and THROWS on denial (it never returns a falsy value this
   *  handler could accidentally treat as "empty") — a denied caller gets a 403, never a queue that
   *  silently rendered `[]` (criterion 5, the "kickoff being processed" defect this ticket names). */
  @Get(":tenantId/agency/leads")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "agency_lead", tenantId, module: "agency" }, "read");
    return listLeadsQueue(tenantId);
  }

  /** Detail, joined to the latest submission. `authorize()` runs WITH the lead's `id` and BEFORE
   *  the read (mirrors `webdev-change-requests.controller.ts`'s `get()`): a caller who may not read
   *  `agency_lead` at all learns exactly that (403), and only a caller who IS allowed to read leads
   *  can go on to learn whether this particular one exists (404) — the two refusals stay distinct
   *  all the way to the response. */
  @Get(":tenantId/agency/leads/:leadId")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("leadId") leadId: string) {
    await authorize(req.principal, { kind: "agency_lead", tenantId, id: leadId, module: "agency" }, "read");
    const row = await getLeadDetail(tenantId, leadId);
    if (!row) throw new NotFoundException("lead not found");
    return row;
  }

  /** Full submission history — a SEPARATE Cerbos resource (`agency_discovery_submission`), per
   *  design §5.2: it carries `read` only (deliberately no `update` — the row is INSERT-only). */
  @Get(":tenantId/agency/leads/:leadId/submissions")
  async submissions(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("leadId") leadId: string) {
    await authorize(req.principal, { kind: "agency_discovery_submission", tenantId, module: "agency" }, "read");
    const rows = await listLeadSubmissions(tenantId, leadId);
    // `null` means the LEAD itself doesn't exist/isn't visible — distinct from a real `[]` (a lead
    // that exists but has genuinely never been submitted against, e.g. still `invited`).
    if (rows === null) throw new NotFoundException("lead not found");
    return rows;
  }

  // ── Staff-created lead (AD-4) ───────────────────────────────────────────────────────────────
  /** `source='staff'` — a prospect who came in by phone rather than through an invite link.
   *  `authorize()` runs BEFORE body validation: a caller who may not create a lead at all should
   *  learn that, not learn a body-validation detail first — same "authorize before validate" fix
   *  `webdev-change-requests.controller.ts`'s `triage()` documents at its own call site. */
  @Post(":tenantId/agency/leads")
  @HttpCode(201)
  async create(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { orgName?: string; contactName?: string; contactEmail?: string; contactPhone?: string },
  ) {
    await authorize(req.principal, { kind: "agency_lead", tenantId, module: "agency" }, "create");
    const input = normalizeCreateLeadInput(body ?? {});
    const { id } = await createStaffLead(tenantId, req.principal.userId, input);
    await writeActivity(tenantId, req.principal.userId, "created", "agency_lead", id, { source: "staff", orgName: input.orgName });
    // `'new'`, NOT `'invited'` — this must match what createStaffLead actually inserts. It said
    // "invited" until QA pinned the row and caught the contradiction: a staff-entered lead has had
    // nothing sent to it, and telling the caller otherwise erases exactly the distinction design
    // §4.1 exists to preserve ("we met them and never sent the form" vs "sent, waiting on them").
    return { id, status: "new" };
  }

  // ── Invites (AD-2's service, wired here after QA found nothing called it) ────────────────────
  /** Mint an invite link for a lead, and advance it to `invited`.
   *
   *  This endpoint did not exist until QA went looking: `mintInviteToken` shipped as a service
   *  function that no controller ever called, so there was no way through the API for a staff
   *  member to actually send a prospect the form. The flow read as complete end-to-end in every
   *  unit test and could not be started by a real person.
   *
   *  ⚠ THE PLAINTEXT IS RETURNED EXACTLY ONCE, HERE, AND IS NEVER RECOVERABLE.
   *  Only `sha256(plaintext)` is stored (design §2.2), so a lost link is re-minted, never looked
   *  up. Deliver it as a URL FRAGMENT (`…/discovery#t=<token>`), never `?t=` — a query parameter
   *  lands in nginx access logs, in the `Referer` of every outbound link on the page, and in
   *  browser history.
   *
   *  Cerbos: `update` on `agency_lead`, not `triage`. Sending someone a form is ordinary lead
   *  maintenance; it disposes of nothing and mints no client. */
  @Post(":tenantId/agency/leads/:leadId/invite")
  @HttpCode(201)
  async invite(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("leadId") leadId: string,
    @Body() body: { ttlDays?: number },
  ) {
    await authorize(req.principal, { kind: "agency_lead", tenantId, id: leadId, module: "agency" }, "update");

    // Authorize, THEN confirm the lead exists, then mint — so a caller who may not touch leads
    // learns that (403) rather than learning whether this particular lead exists (404).
    const lead = await getLeadDetail(tenantId, leadId);
    if (!lead) throw new NotFoundException("lead not found");
    // A converted or declined lead is finished; minting a fresh link into it would put a live form
    // in a prospect's hands for work that is already sold or already refused.
    if (lead.status === "converted" || lead.status === "declined") {
      throw new ConflictException({
        message: `cannot invite a lead in status '${lead.status}'`,
        reason: "lead_already_dispositioned",
      });
    }

    const ttlMs = typeof body?.ttlDays === "number" && body.ttlDays > 0
      ? Math.min(body.ttlDays, 365) * 24 * 60 * 60 * 1000
      : undefined;

    const minted = await mintInviteToken({ tenantId, leadId, createdBy: req.principal.userId, ttlMs });
    await writeActivity(tenantId, req.principal.userId, "invited", "agency_lead", leadId, {
      tokenId: minted.id, expiresAt: minted.expiresAt,
    });
    return { tokenId: minted.id, token: minted.plaintext, expiresAt: minted.expiresAt };
  }

  /** Revoke an outstanding invite. Idempotent — `revoked:false` means it was already revoked or
   *  already used, which is information, not a failure. */
  @Post(":tenantId/agency/leads/:leadId/invite/:tokenId/revoke")
  async revokeInvite(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("leadId") leadId: string,
    @Param("tokenId") tokenId: string,
  ) {
    await authorize(req.principal, { kind: "agency_lead", tenantId, id: leadId, module: "agency" }, "update");
    const { revoked } = await revokeIntakeToken(tenantId, tokenId);
    if (revoked) {
      await writeActivity(tenantId, req.principal.userId, "invite_revoked", "agency_lead", leadId, { tokenId });
    }
    return { revoked };
  }

  // ── Triage dispositions (AD-5; convert is AD-6, not this file) ──────────────────────────────
  /** `submitted -> in_review`, so the queue shows someone picked it up. NOT a disposition (no
   *  `triaged_by`/`triaged_at` stamp — see agency-leads.service.ts's `TransitionSpec.disposition`
   *  comment for why). */
  @Post(":tenantId/agency/leads/:leadId/open")
  @HttpCode(200)
  async open(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("leadId") leadId: string) {
    await authorize(req.principal, { kind: "agency_lead", tenantId, id: leadId, module: "agency" }, "triage");
    const result = await openLead(tenantId, leadId, req.principal.userId);
    const res = resolveOrThrow("open", leadId, result, "in_review");
    await writeActivity(tenantId, req.principal.userId, "opened", "agency_lead", leadId);
    return res;
  }

  /** `in_review -> declined`. `reason` is required — validated here so the caller gets a typed 400
   *  BEFORE the DB's `lead_declined_has_reason` CHECK would otherwise refuse a reasonless row as a
   *  raw constraint-violation 500. */
  @Post(":tenantId/agency/leads/:leadId/decline")
  @HttpCode(200)
  async decline(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("leadId") leadId: string,
    @Body() body: { reason?: string },
  ) {
    await authorize(req.principal, { kind: "agency_lead", tenantId, id: leadId, module: "agency" }, "triage");
    const reason = normalizeDeclineReason(body?.reason);
    const result = await declineLead(tenantId, leadId, req.principal.userId, reason);
    const res = resolveOrThrow("decline", leadId, result, "declined");
    await writeActivity(tenantId, req.principal.userId, "declined", "agency_lead", leadId, { reason });
    return res;
  }

  /** `in_review -> nurturing` — design §4.1: the difference between "we said no" and "not this
   *  quarter". No re-invite/re-mint here; that is AD-2's surface, not this ticket's. */
  @Post(":tenantId/agency/leads/:leadId/nurture")
  @HttpCode(200)
  async nurture(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("leadId") leadId: string) {
    await authorize(req.principal, { kind: "agency_lead", tenantId, id: leadId, module: "agency" }, "triage");
    const result = await nurtureLead(tenantId, leadId, req.principal.userId);
    const res = resolveOrThrow("nurture", leadId, result, "nurturing");
    await writeActivity(tenantId, req.principal.userId, "nurtured", "agency_lead", leadId);
    return res;
  }
}
