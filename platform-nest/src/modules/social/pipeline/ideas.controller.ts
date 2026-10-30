// SCP-5 W5-B2 — "Ideas for next month" (FRONTEND-BFF-CONTRACT §63.25.3; PERMISSION §57: no new action, no new Cerbos kind). Mounted under
// `api/:tenantId/modules/social`, behind AuthGuard and ModuleEnabledGuard("social"). Routes only: every write runs `ideas.service.ts`.
//
//   GET    engagements/:engagementId/ideas?status=&reportId=   social_post · read       {items: [Idea], canWrite}
//   POST   engagements/:engagementId/ideas                     the would-be post's gate   201 {idea, created}
//   PATCH  ideas/:ideaId                                       the same gate              200 {idea}          (409 idea_planned)
//   POST   ideas/:ideaId/share                                 the same gate              200 {idea, alreadyApplied}
//   POST   ideas/:ideaId/plan                                  the same gate              201 {idea, post}; a replay 200 {alreadyApplied: true, idea, post}
//   DELETE ideas/:ideaId                                       the same gate              200 {deleted: true, id}   (409 idea_planned)
//
// THE GATE is the client's would-be post (63.25.2): `create` plus `author` or `approve`: the client's officer and the four. Anyone else is 403
// `not_officer_or_approver`; an unattended automation 403 `automation_cannot_act`. Every write answers in the order 404, 403, 400, 409.
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { createIdea, deleteIdea, editIdea, listIdeas, planIdea, shareIdea } from "./ideas.service";

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialIdeasController {
  @Get("engagements/:engagementId/ideas")
  async list(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
    @Query("status") status?: string, @Query("reportId") reportId?: string,
  ) {
    return listIdeas(req.principal, tenantId, engagementId, { status, reportId });
  }

  @Post("engagements/:engagementId/ideas")
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string, @Body() body: unknown) {
    return createIdea(req.principal, tenantId, engagementId, body);
  }

  @Patch("ideas/:ideaId")
  async edit(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("ideaId") ideaId: string, @Body() body: unknown) {
    return editIdea(req.principal, tenantId, ideaId, body);
  }

  @Post("ideas/:ideaId/share")
  @HttpCode(200)
  async share(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("ideaId") ideaId: string) {
    const out = await shareIdea(req.principal, tenantId, ideaId);
    return out.alreadyApplied ? { alreadyApplied: true, idea: out.idea } : { idea: out.idea };
  }

  @Post("ideas/:ideaId/plan")
  @HttpCode(201)
  async plan(
    @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply,
    @Param("tenantId") tenantId: string, @Param("ideaId") ideaId: string, @Body() body: unknown,
  ) {
    const out = await planIdea(req.principal, tenantId, ideaId, body);
    if (!out.alreadyApplied) return { idea: out.idea, post: out.post };
    void reply.status(200);
    return { alreadyApplied: true, idea: out.idea, post: out.post };
  }

  @Delete("ideas/:ideaId")
  async remove(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("ideaId") ideaId: string) {
    return deleteIdea(req.principal, tenantId, ideaId);
  }
}
