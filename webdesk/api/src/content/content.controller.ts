import { BadRequestException, Body, Controller, Get, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { ContentService } from "./content.service";
import { ApiKeyAuthGuard } from "../auth/api-key-auth.guard";
import { ScopeGuard } from "../auth/scope.guard";
import { RequireScope } from "../auth/scope.decorator";
import { TenantQuotaGuard } from "../rate-limit/tenant-quota.guard";
import type { WebdeskRequest } from "../auth/webdesk-request";

@Controller("v1/t/:tenantSlug/content")
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  @RequireScope("read")
  @UseGuards(ApiKeyAuthGuard, ScopeGuard, TenantQuotaGuard)
  async list(@Req() req: WebdeskRequest) {
    if (!req.webdesk) throw new UnauthorizedException();
    const items = await this.content.list(req.webdesk);
    return { items };
  }

  @Post()
  @RequireScope("write")
  @UseGuards(ApiKeyAuthGuard, ScopeGuard)
  async create(
    @Req() req: WebdeskRequest,
    @Body() body: { collectionKey?: string; locale?: string; slug?: string; blocks?: unknown[] },
  ) {
    if (!req.webdesk) throw new UnauthorizedException();
    if (!body?.collectionKey || !body?.locale || !body?.slug) {
      throw new BadRequestException("collectionKey, locale and slug are required");
    }
    const item = await this.content.create(req.webdesk, {
      collectionKey: body.collectionKey,
      locale: body.locale,
      slug: body.slug,
      blocks: body.blocks,
    });
    return item;
  }
}
