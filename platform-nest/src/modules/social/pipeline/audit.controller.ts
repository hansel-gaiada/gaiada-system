// SCP-5g (W5-B4) — the social audit's routes (FRONTEND-BFF-CONTRACT §63.28.4). Mounted under `api/:tenantId/modules/social`, behind AuthGuard and
// ModuleEnabledGuard("social"). Routes only: every rule and every write runs `audit.service.ts`; the scoring is `audit-score.ts`'s (pure).
//
//   GET    audits?subject=client|prospect   social_post · read    {items, canAddProspect}   the list, worst first
//   GET    audits/:auditId                  social_post · read    the scorecard (a draft computed now, a final audit its `frozen`)
//   POST   audits                           the subject's gate    201 {audit, created: true}; 200 {audit, created: false} for a client with a draft or a replayed id
//   PATCH  audits/:auditId                  the subject's gate    200 {audit}                (409 audit_final)
//   POST   audits/:auditId/ai-summary       the subject's gate    200 {summary, draftedVia}  a proposal; nothing is saved (409 audit_final)
//   POST   audits/:auditId/finalize         the subject's gate    200 {audit}; a replay 200 {alreadyApplied: true, audit}
//   POST   audits/:auditId/attach           social_engagement · plan   200 {audit}; a replay 200 {alreadyApplied: true, audit} (409 audit_attached)
//   DELETE audits/:auditId                  the subject's gate    200 {deleted: true, id}    (409 audit_final)
//
// THE GATES (SCP-Q34): a client's audit is `manage` on the client's would-be post (its officer, the HoD and GM seats, the superadmin; 403 `not_officer_or_approver`);
// a prospect's is `plan` (the four; 403 `not_a_social_approver`); an unattended automation is 403 `automation_cannot_act`. Order: 404, 403, 400, 409.
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import {
  attachAudit, createAudit, deleteAudit, draftAuditSummary, editAudit, finalizeAudit, getAudit, listAudits,
} from "./audit.service";

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialAuditController {
  @Get("audits")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query() q: Record<string, unknown>) {
    return listAudits(req.principal, tenantId, q);
  }

  @Get("audits/:auditId")
  async read(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("auditId") auditId: string) {
    return getAudit(req.principal, tenantId, auditId);
  }

  @Post("audits")
  @HttpCode(201)
  async create(
    @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("tenantId") tenantId: string, @Body() body: unknown,
  ) {
    const out = await createAudit(req.principal, tenantId, body);
    if (!out.created) void reply.status(200);
    return out;
  }

  @Patch("audits/:auditId")
  async edit(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("auditId") auditId: string, @Body() body: unknown) {
    return editAudit(req.principal, tenantId, auditId, body);
  }

  @Post("audits/:auditId/ai-summary")
  @HttpCode(200)
  async aiSummary(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("auditId") auditId: string) {
    return draftAuditSummary(req.principal, tenantId, auditId);
  }

  @Post("audits/:auditId/finalize")
  @HttpCode(200)
  async finalize(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("auditId") auditId: string) {
    const out = await finalizeAudit(req.principal, tenantId, auditId);
    return out.alreadyApplied ? { alreadyApplied: true, audit: out.audit } : { audit: out.audit };
  }

  @Post("audits/:auditId/attach")
  @HttpCode(200)
  async attach(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("auditId") auditId: string, @Body() body: unknown) {
    const out = await attachAudit(req.principal, tenantId, auditId, body);
    return out.alreadyApplied ? { alreadyApplied: true, audit: out.audit } : { audit: out.audit };
  }

  @Delete("audits/:auditId")
  async remove(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("auditId") auditId: string) {
    return deleteAudit(req.principal, tenantId, auditId);
  }
}
