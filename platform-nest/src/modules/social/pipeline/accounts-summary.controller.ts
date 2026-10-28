// SCP-Sg — the client's accounts read back (FRONTEND-BFF-CONTRACT §63.1 file 8, §63.10; plan §8 row Sg). Mounted under `api/:tenantId/modules/social`, behind
// AuthGuard and ModuleEnabledGuard("social"), beside the other pipeline controllers (no path collides: `engagements/:engagementId/accounts-summary` is new).
//
//   GET engagements/:engagementId/accounts-summary    social_post · read     followers, 30-day reach and "Last synced" per account, and the totals
//
// Routes only: the rule, the SQL and the marks are `accounts-summary.ts` (its header says how each number is judged).
import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { readAccountsSummary, type AccountsSummaryAnswer } from "./accounts-summary";

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialAccountsSummaryController {
  @Get("engagements/:engagementId/accounts-summary")
  async accountsSummary(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
  ): Promise<AccountsSummaryAnswer> {
    return readAccountsSummary(req.principal, tenantId, engagementId);
  }
}
