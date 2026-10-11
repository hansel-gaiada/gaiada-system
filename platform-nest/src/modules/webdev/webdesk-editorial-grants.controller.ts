// M5-W1b — the writers' room grant routes (docs/plans/2026-10-11-m5-writers-room-design.md §2.6; FRONTEND-BFF-CONTRACT
// §27 "Writers' room grants"):
//
//   GET    /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants               who holds what here
//   POST   /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants               grant (or re-scope)
//   DELETE /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants/:userId/:role revoke on this site
//
// Who may: Cerbos `webdesk_collection` · `manage_editorial` (company_admin, owner, webdev_manager, platform_admin; sensitive,
// advancedOnly): the same holders as `apply_schema`, and the CEILING of an editorial grant (design §2.5). A writer, an
// editor, webdev_staff, a manager, a member and a client are all denied here.
//
// THE FIRST STATEMENT OF EVERY HANDLER IS THE CERBOS CHECK (the "validation pre-empts authz" trap): a denied caller gets
// 403 whatever it sent, and nothing is read from WebDesk or the database for it. The resource carries the route's
// `siteId` (no rule on this action reads it today; it is there so a later site-scoped rule gets the route value, never a
// body's). The POST then validates its body (pure, no I/O), runs the cross-company wall (`resolveEditableSite`: a site
// that is not this company's is the uniform 404) and reads the site's collections, all BEFORE the one short database
// transaction that writes the grant, its scope row and its audit row. The GET and the DELETE read ERP rows only, pinned to this company and this
// site id, so they need no WebDesk call (a revoke must work while WebDesk is down, and for a site it no longer lists).
//
// What a caller can NOT choose: the company (the route's tenant, validated by AuthGuard and Cerbos), a role outside the
// four, a scope type, a position or a service assignment. The choke point (`grantEditorialRole`) re-checks the rest.
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize } from "../../core/http";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { WebdeskProblemFilter } from "./webdesk-content.controller";
import {
  grantEditorialRoleOnSite, listEditorialGrants, parseEditorialGrantBody, parseEditorialRevokeParams,
  revokeEditorialRoleOnSite,
} from "./webdesk-editorial-grants.service";

@Controller("api/:tenantId/modules/webdev/content")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
@UseFilters(WebdeskProblemFilter)
export class WebdeskEditorialGrantsController {
  @Get("sites/:tenantSlug/:siteId/editorial/grants")
  async list(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
  ) {
    await authorize(req.principal, { kind: "webdesk_collection", tenantId, module: "webdev", siteId }, "manage_editorial");
    return listEditorialGrants(tenantId, { tenantSlug, siteId });
  }

  @Post("sites/:tenantSlug/:siteId/editorial/grants")
  @HttpCode(200)
  async grant(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Body() body: unknown,
  ) {
    await authorize(req.principal, { kind: "webdesk_collection", tenantId, module: "webdev", siteId }, "manage_editorial");
    const parsed = parseEditorialGrantBody(body);
    return grantEditorialRoleOnSite(req.principal, tenantId, { tenantSlug, siteId }, parsed);
  }

  @Delete("sites/:tenantSlug/:siteId/editorial/grants/:userId/:role")
  @HttpCode(200)
  async revoke(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("userId") userId: string, @Param("role") role: string,
  ) {
    await authorize(req.principal, { kind: "webdesk_collection", tenantId, module: "webdev", siteId }, "manage_editorial");
    const p = parseEditorialRevokeParams(userId, role);
    return revokeEditorialRoleOnSite(req.principal, tenantId, { tenantSlug, siteId }, p.userId, p.role);
  }
}
