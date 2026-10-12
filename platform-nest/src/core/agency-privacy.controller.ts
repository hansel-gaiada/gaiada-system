// M5-G5 — the privacy commands over the agency intake data, as BFF routes (and, through core-tools.ts, MCP
// tools `agency_privacy.find|export|erase`, impact HIGH). Business logic and the WS4 flow live in
// ./agency-privacy.service.ts (read its header first); this file is authorize() + HTTP wiring + audit.
//
//   POST /api/:tenantId/agency/privacy/find     { email?, phone?, visitorId?, consentId?, approvalId? }
//   (M5-G5b: with an approvalId, email and phone may be OMITTED: the subject is then rebuilt from the hashes the
//    approval was filed with. This is how an approval filed through the agent hub runs, and it means the requester
//    need not retype the person's contact data. Giving them is still allowed and is checked against the approval.)
//   POST /api/:tenantId/agency/privacy/export   { email?, phone?, visitorId?, consentId?, approvalId? }
//   POST /api/:tenantId/agency/privacy/erase    { email?, phone?, visitorId?, consentId?, approvalId? }
//   (M5-V3-h: `visitorId` = the consented website visitor id the site's privacy page shows the person; `consentId` =
//    their consent log id. Each a uuid. find/export then also cover the visitor profiles, erase deletes them,
//    tombstones both ids and tells the collector; see core/agency-privacy.service.ts and modules/search/visitor-erase.ts.)
//
// POST, never GET, for all three (find included): the identifier is a person's email or phone and must never
// sit in a URL that an intermediary logs (WSK-38's rule).
//
// ── AUTHORIZATION ───────────────────────────────────────────────────────────────────────────────────
// Cerbos `convert` on `agency_lead`: the tenant's top agency-lead tier (company_admin; platform_admin), the
// only existing action that is NOT granted to manager/member. No new Cerbos kind or action is added (a new one
// is six artifacts plus a Cerbos restart); a dedicated `privacy` action is a follow-up for the IAM owner.
// authorize() runs FIRST, before the body is read, so a denial is a 403 even for a malformed body and a
// denial test with a valid body can never be pre-empted by a 400. The SECOND gate is the WS4 approval, which
// a different person (with `decide` on automation_approval) must give.
//
// ── RESPONSES ───────────────────────────────────────────────────────────────────────────────────────
//   202 { outcome: "suspended", requestId, approvalId }    call 1: approval filed, nothing read
//   202 { outcome: "awaiting_approval", requestId, approvalId }
//   200 { outcome: "executed", requestId, ... }            find: leads; export: leads with data; erase: counts
//   200 { outcome: "executed", replayed: true, ... }       an erase called again with its used approval
//   503 visitor_store_busy                                 a visitor job held a property lock past the deadline:
//                                                          NOTHING was changed and the approval is still unused
//   400 subject_invalid | approval_id_invalid | privacy_request_mismatch
//   403 (Cerbos) | privacy_request_not_requester | self_approved
//   404 privacy_request_not_found
//   409 approval_rejected | approval_already_used
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, NotFoundException, Param, Post, Req, Res,
  ServiceUnavailableException, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authorize, writeActivity } from "./http";
import { AuthGuard } from "../auth/guards";
import { NO_SUBJECT_MESSAGE, parseSubject, type Subject } from "./agency-privacy.subject";
import {
  executeAgencyPrivacyRequest, fileAgencyPrivacyRequest, isPrivacyKind, type PrivacyKind,
} from "./agency-privacy.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** M5-V3-h: the collector outcome in words, beside the ledger's status word. Never claims a delivery that did not happen. */
export function collectorWords(status: string | null): string {
  switch (status) {
    case "delivered": return "The visitor-event collector confirmed the erase.";
    case "queued":
      return "The ERP data is erased, but the visitor-event collector could not be reached: the erase there is queued and " +
        "retried by the visitor jobs, and it is NOT confirmed yet.";
    case "not_configured": return "The visitor-event collector is not configured in this deployment; nothing was sent to it.";
    case "id_not_held":
      return "An identifier was known only by its hash, so the collector could not be told by id; it is blocked in the ERP, " +
        "and the collector is told when its buffered events next arrive.";
    case "not_needed": return "No website-visitor data was in scope at the collector.";
    default: return "This erase was recorded before website-visitor profiles were covered.";
  }
}

@Controller("api")
@UseGuards(AuthGuard)
export class AgencyPrivacyController {
  @Post(":tenantId/agency/privacy/:kind")
  async command(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Param("kind") kindRaw: string,
    @Body() body: { email?: unknown; phone?: unknown; visitorId?: unknown; consentId?: unknown; approvalId?: unknown },
  ) {
    // An unknown command is a route that does not exist, before anything else.
    if (!isPrivacyKind(kindRaw)) throw new NotFoundException("unknown privacy command");
    const kind: PrivacyKind = kindRaw;
    await authorize(req.principal, { kind: "agency_lead", tenantId, module: "agency" }, "convert");

    // The ledger, the maker != checker rule and the requester re-call all key on a user; a principal without one
    // (a bare service token) can never file or run a privacy request.
    const actorId = req.principal.userId;
    if (!actorId) throw new ForbiddenException({ message: "a privacy request needs a user principal", reason: "user_required" });

    const approvalRaw = body?.approvalId;
    const hasApproval = !(approvalRaw === undefined || approvalRaw === null || approvalRaw === "");
    const given = (v: unknown) => v !== undefined && v !== null;
    // Run-by-approval (M5-G5b): an approvalId and NO identifier at all. Anything else, including a bad identifier
    // next to an approvalId, is parsed (and refused) exactly as before.
    let subject: Subject | null = null;
    if (!hasApproval || given(body?.email) || given(body?.phone) || given(body?.visitorId) || given(body?.consentId)) {
      const parsed = parseSubject(body);
      if (!parsed.ok) throw new BadRequestException({ message: parsed.message, reason: parsed.reason });
      subject = parsed.subject;
    }

    if (!hasApproval) {
      if (!subject) throw new BadRequestException({ message: NO_SUBJECT_MESSAGE, reason: "subject_invalid" });
      const filed = await fileAgencyPrivacyRequest({ tenantId, kind, subject, requestedBy: actorId });
      await writeActivity(tenantId, actorId, `privacy_${kind}_requested`, "agency_privacy_request", filed.requestId, {
        approvalId: filed.approvalId,
      });
      reply.status(202);
      return {
        outcome: "suspended" as const,
        kind,
        requestId: filed.requestId,
        approvalId: filed.approvalId,
        message:
          "Nothing was read or changed. A high-impact approval was filed; once a different company admin approves it, " +
          "call this endpoint again with this approvalId (the same identifiers are optional) to run it exactly once.",
      };
    }
    if (typeof approvalRaw !== "string" || !UUID_RE.test(approvalRaw)) {
      throw new BadRequestException({ message: "approvalId must be a uuid", reason: "approval_id_invalid" });
    }

    const r = await executeAgencyPrivacyRequest({ tenantId, kind, subject, approvalId: approvalRaw, actorId });
    switch (r.outcome) {
      case "not_found":
        throw new NotFoundException({ message: "no privacy request is filed under this approval", reason: "privacy_request_not_found" });
      case "mismatch":
        throw new BadRequestException({
          message: "this approval was filed for a different command or different identifiers; an approval never widens",
          reason: "privacy_request_mismatch",
        });
      case "not_requester":
        throw new ForbiddenException({ message: "only the person who filed this request may run it", reason: "privacy_request_not_requester" });
      case "awaiting_approval":
        reply.status(202);
        return {
          outcome: "awaiting_approval" as const, kind, requestId: r.requestId, approvalId: approvalRaw,
          message: "Nothing was read or changed. The approval is still pending a decision.",
        };
      case "rejected":
        throw new ConflictException({ message: "this approval was rejected; file a new request if it is still needed", reason: "approval_rejected" });
      case "self_approved":
        throw new ForbiddenException({
          message: "a privacy request must be approved by someone other than its requester; nothing was read or changed",
          reason: "self_approved",
        });
      case "already_used":
        throw new ConflictException({
          message: "this approval was already used; its response is personal data and is never stored, so a new request is needed",
          reason: "approval_already_used",
        });
      case "busy":
        throw new ServiceUnavailableException({
          message: "a website-visitor job is working on this company's data right now; nothing was read or changed and " +
            "the approval is still unused, so run the same request again in a minute",
          reason: "visitor_store_busy",
        });
      case "replayed":
        reply.status(200);
        return {
          outcome: "executed" as const, kind, replayed: true, requestId: r.requestId, counts: r.counts,
          collector: collectorWords(r.counts.collectorForget),
        };
      case "executed": {
        const res = r.result;
        await writeActivity(tenantId, actorId, `privacy_${kind}_executed`, "agency_privacy_request", r.requestId, {
          approvalId: approvalRaw, ...res.counts,
        });
        reply.status(200);
        if (res.kind === "erase") {
          return {
            outcome: "executed" as const, kind, replayed: false, requestId: r.requestId, erasedAt: res.erasedAt,
            counts: res.counts, outOfScope: res.outOfScope, collector: collectorWords(res.counts.collectorForget),
          };
        }
        return {
          outcome: "executed" as const, kind, requestId: r.requestId, generatedAt: new Date().toISOString(),
          counts: res.counts, outOfScope: res.outOfScope, leads: res.leads, visitorProfiles: res.visitorProfiles,
        };
      }
    }
  }
}
