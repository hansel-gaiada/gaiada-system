// SCP-3d — the client's feed preview routes (FRONTEND-BFF-CONTRACT §63.10; plan §8 row 3d). Mounted under
// `api/:tenantId/modules/social`, behind AuthGuard and ModuleEnabledGuard("social"), beside the other pipeline controllers
// (no path collides: `engagements/:engagementId/feed-preview` is new).
//
//   GET  engagements/:engagementId/feed-preview        social_post · read     the client's grid, newest date first
//   POST engagements/:engagementId/feed-preview/swap   the date-move rules    two posts trade publish dates, all or nothing
//
// Routes only: the rule, the read and the one-transaction swap are `feed-preview.ts` (its header says how each is judged).
import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { readFeedPreview, swapFeedPreviewDates } from "./feed-preview";

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialFeedPreviewController {
  @Get("engagements/:engagementId/feed-preview")
  async feedPreview(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string) {
    return readFeedPreview(req.principal, tenantId, engagementId);
  }

  @Post("engagements/:engagementId/feed-preview/swap")
  @HttpCode(200)
  async swap(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string, @Body() body: unknown) {
    return swapFeedPreviewDates(req.principal, tenantId, engagementId, body);
  }
}
