// SCP-4a — the client's money answers for the Social Media content pipeline, in the portal (FRONTEND-BFF-CONTRACT §63.11 "The portal's
// approvals"; `/portal/approvals` gains a "Boost budgets" section in SCP-4b). Routes under `api/:tenantId/portal/social/spend`, behind
// AuthGuard, gated by Cerbos `portal` and narrowed by `resolvePortalScope`.
//
//   GET  /                              portal · read            {budgets, boosts, history, canDecide}
//   POST budgets/:proposalId/decide     portal · approve_spend   {decision: 'agree'|'decline', note?}
//   POST boosts/:boostId/decide         portal · approve_spend   {decision: 'approve'|'decline', note?}
//
// A thin controller, as social-pipeline-portal.controller.ts is (the portal is core: its controllers stay in `src/core/`; the DOMAIN logic,
// the order of checks and the signing rule are `modules/social/pipeline/portal-spend.ts`'s). The client sees only their own budgets and
// spend, never our fees (PV-D38).
import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/guards";
import { portalDecideBoost, portalDecideBudget, portalSpend } from "../modules/social/pipeline/portal-spend";

@Controller("api/:tenantId/portal/social/spend")
@UseGuards(AuthGuard)
export class SocialSpendPortalController {
  @Get()
  async read(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    return portalSpend(req.principal, tenantId);
  }

  @Post("budgets/:proposalId/decide")
  @HttpCode(200)
  async decideBudget(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("proposalId") proposalId: string, @Body() body: unknown) {
    return portalDecideBudget(req.principal, tenantId, proposalId, body);
  }

  @Post("boosts/:boostId/decide")
  @HttpCode(200)
  async decideBoost(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("boostId") boostId: string, @Body() body: unknown) {
    return portalDecideBoost(req.principal, tenantId, boostId, body);
  }
}
