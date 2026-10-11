// WSK-49c — STAFF routes that say which client a WebDesk site serves (`webdesk_site_clients`).
//
//   GET    /api/:tenantId/modules/webdev/content/site-clients                              every link of the company
//   GET    /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/client          one site's link (`{link: null}` when unlinked)
//   PUT    /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/client          body {clientId}: link or re-point
//   DELETE /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/client          unlink
//
// Who may: `webdev_provisioned_site` . `read` (the two reads) and `operate` (PUT/DELETE): the same tiers that run a
// site (company_admin, manager, webdev_manager), no new Cerbos action. A client editor, a client admin and
// webdev_staff are all denied here: deciding which client may edit a live site is the agency's call.
//
// THE FIRST STATEMENT OF EVERY HANDLER IS THE CERBOS CHECK (the "validation pre-empts authz" trap): a denied caller
// gets 403 whatever it sent. Then the cross-company wall (`resolveEditableSite`: a site that is not this company's
// is the uniform 404), then the body, then the write. A PUT is audited (`webdesk.site_client.linked|relinked`,
// DELETE `unlinked`) only when the link really changed.
import { Body, Controller, Delete, Get, HttpCode, Param, Put, Req, UseFilters, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize } from "../../core/http";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { WebdeskProblemFilter } from "./webdesk-content.controller";
import { invalidRequest, isPlainObject, strictBody, webdeskZoneB } from "./webdesk-content.service";
import { clearSiteClientLink, getSiteClientLink, listSiteClientLinks, setSiteClientLink } from "./webdesk-site-clients.service";

@Controller("api/:tenantId/modules/webdev/content")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
@UseFilters(WebdeskProblemFilter)
export class WebdeskSiteClientsController {
  @Get("site-clients")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "read");
    return { links: await listSiteClientLinks(tenantId) };
  }

  @Get("sites/:tenantSlug/:siteId/client")
  async get(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
  ) {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "read");
    await webdeskZoneB.resolveEditableSite(tenantId, tenantSlug, siteId);
    return { link: await getSiteClientLink(tenantId, { tenantSlug, siteId }) };
  }

  @Put("sites/:tenantSlug/:siteId/client")
  @HttpCode(200)
  async set(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Body() body: unknown,
  ) {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "operate");
    await webdeskZoneB.resolveEditableSite(tenantId, tenantSlug, siteId);
    const b = strictBody(body, ["clientId"]);
    if (!isPlainObject(b) || typeof b.clientId !== "string") throw invalidRequest("clientId is a required string");
    return setSiteClientLink(req.principal, tenantId, { tenantSlug, siteId }, b.clientId);
  }

  @Delete("sites/:tenantSlug/:siteId/client")
  @HttpCode(200)
  async clear(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
  ) {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "operate");
    // No wall: unlinking a site WebDesk no longer lists must still be possible (a dangling link grants nothing, but is clutter).
    return clearSiteClientLink(req.principal, tenantId, { tenantSlug, siteId });
  }
}
