// M5-W4 — the writers' room briefs BFF (docs/plans/2026-10-11-m5-writers-room-design.md §5; FRONTEND-BFF-CONTRACT §27 "Briefs";
// PERMISSION-CONTRACT §27.4). Under `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/…`, beside the content routes,
// with the same two-phase gate: THE FIRST STATEMENT OF EVERY HANDLER IS `authorizeSite(...)` (phase 1), and the service asks the real
// question (phase 2, on the brief's scope or on the linked item, with WebDesk's attributes) BEFORE any body or query is validated.
// Zone B's typed problems (a create-draft's 409 `slug-taken`, 422 `composition-violation`) leave byte for byte, as in the content controller.
//
// Cerbos: managing a brief is `webdesk_content_item:assign` on the brief's {site, collection, locale}; reading a linked brief is
// `webdesk_content_item:comment` on its item. No new kind: see `webdesk-briefs.service.ts`.
import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { ContributorRoute } from "../../auth/contributor-route";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { WebdeskProblemFilter } from "./webdesk-content.controller";
import { authorizeSite, idempotencyKeyOf } from "./webdesk-content.service";
import { webdeskBriefs } from "./webdesk-briefs.service";

// M5-W1d: the two brief READS are open to a contributor (`@ContributorRoute()`, assurance high): an assigned writer reads the
// brief of its own item (Cerbos `comment` on the linked item, PERMISSION-CONTRACT §27.5). Creating, editing, assigning and
// listing briefs stay closed to contributors (403 `contributor_route_forbidden` in AuthGuard).
@Controller("api/:tenantId/modules/webdev/content")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
@UseFilters(WebdeskProblemFilter)
export class WebdeskBriefsController {
  /** The writers' board: every brief of the site the caller may see (managers: their collections; others: briefs of items they may comment on). */
  @Get("sites/:tenantSlug/:siteId/briefs")
  async list(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Query() query: unknown,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    return webdeskBriefs.list(gate, { tenantSlug, siteId }, query);
  }

  /** File a brief for a collection and locale of this site, from search data. `assign` on {site, collectionKey, locale}. */
  @Post("sites/:tenantSlug/:siteId/briefs")
  @HttpCode(201)
  async create(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Body() body: unknown,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "assign");
    return webdeskBriefs.create(gate, { tenantSlug, siteId }, body);
  }

  @Get("sites/:tenantSlug/:siteId/briefs/:briefId")
  @ContributorRoute()
  async get(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("briefId") briefId: string,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    return webdeskBriefs.get(gate, { tenantSlug, siteId }, briefId);
  }

  @Patch("sites/:tenantSlug/:siteId/briefs/:briefId")
  async update(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("briefId") briefId: string,
    @Body() body: unknown,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "assign");
    return webdeskBriefs.update(gate, { tenantSlug, siteId }, briefId, body);
  }

  /** Link the brief to an existing item (same collection and locale) and, optionally, assign its author and dates. */
  @Post("sites/:tenantSlug/:siteId/briefs/:briefId/assign")
  @HttpCode(200)
  async assign(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("briefId") briefId: string,
    @Headers("idempotency-key") idem: string | undefined, @Body() body: unknown,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "assign");
    return webdeskBriefs.assign(gate, { tenantSlug, siteId }, briefId, body, idempotencyKeyOf(idem));
  }

  /** Create a WebDesk draft in the brief's collection and locale, and link it (`brief_ref` = the brief id). 201. */
  @Post("sites/:tenantSlug/:siteId/briefs/:briefId/create-draft")
  @HttpCode(201)
  async createDraft(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("briefId") briefId: string,
    @Headers("idempotency-key") idem: string | undefined, @Body() body: unknown,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "assign");
    return webdeskBriefs.createDraft(gate, { tenantSlug, siteId }, briefId, body, idempotencyKeyOf(idem));
  }

  /** The brief of one item: the writer's path ("what am I writing, and why"). Authorised as `comment` on the item. */
  @Get("sites/:tenantSlug/:siteId/items/:itemId/brief")
  @ContributorRoute()
  async forItem(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("itemId") itemId: string,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    return webdeskBriefs.forItem(gate, { tenantSlug, siteId }, itemId);
  }
}
