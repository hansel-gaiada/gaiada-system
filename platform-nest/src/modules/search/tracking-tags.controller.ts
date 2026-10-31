// M5-P4 (WSK-D92) — the tracking-tags routes: staff set a website's LinkedIn partner id from the ERP. Under
// api/:tenantId/modules/search/properties/:id/ . Contract: docs/FRONTEND-BFF-CONTRACT.md section 28h. Rules and guarantees: tracking-tags.service.ts.
//   GET  tracking-tags?webdeskTenant=<slug>&site=<siteId>   Cerbos resource_search_property · read         (the value is public: it ends up in the site's HTML)
//   GET  tracking-tags/site   Cerbos resource_search_property · read   (M5-P4g: which WebDesk site is this property's, resolved on the server)
//   PUT  tracking-tags/linkedin  {webdeskTenant, site, partnerId}   Cerbos resource_search_property · manage_tags   (search manager, company admin)
//   PUT  tracking-tags/google-ads  {webdeskTenant, site, ids, conversions}   Cerbos resource_search_property · manage_tags   (M5-P4g)
//
// Authorize BEFORE validating (a denial never depends on the body or the query): the PUT's `manage_tags` check runs before the body is
// looked at, so a denial test with a valid body really tests authorization. 403 (not allowed) and 404 (not this company's property) are
// distinct. Every refusal is `{error: words, reason: token}`; GitHub being unable to answer is words, never an empty value.
import { Body, Controller, Get, Header, HttpCode, HttpException, Param, Put, Query, Req, UseGuards, BadRequestException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  TrackingTagsError, findTrackingSite, parseSiteQuery, putGoogleAds, putLinkedinPartnerId, readTrackingTags,
  type FoundTrackingSite, type GoogleAdsPutResponse, type TrackingTagsPutResponse, type TrackingTagsView,
} from "./tracking-tags.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A typed refusal as an HTTP error: `{error: words, reason: token}` (+ `detail.permission` for a missing GitHub App permission). */
export function asHttp(e: unknown): unknown {
  if (!(e instanceof TrackingTagsError)) return e;
  return new HttpException(
    { message: e.message, reason: e.reason, ...(e.permission ? { detail: { permission: e.permission } } : {}) },
    e.status,
  );
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchTrackingTagsController {
  private async gate(req: FastifyRequest, tenantId: string, propertyId: string, action: "read" | "manage_tags"): Promise<void> {
    if (!UUID_RE.test(propertyId)) throw new BadRequestException("propertyId must be a valid id");
    await authorize(req.principal, { kind: "resource_search_property", id: propertyId, tenantId, module: "search" }, action);
  }

  @Get("properties/:id/tracking-tags/site")
  @Header("Cache-Control", "no-store")
  async site(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string): Promise<FoundTrackingSite> {
    await this.gate(req, tenantId, id, "read");
    try {
      return await findTrackingSite(tenantId, id.toLowerCase());
    } catch (e) {
      throw asHttp(e);
    }
  }

  @Get("properties/:id/tracking-tags")
  @Header("Cache-Control", "no-store")
  async read(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("webdeskTenant") webdeskTenant?: string, @Query("site") site?: string,
  ): Promise<TrackingTagsView> {
    await this.gate(req, tenantId, id, "read");
    try {
      return await readTrackingTags(req.principal, tenantId, id.toLowerCase(), parseSiteQuery({ webdeskTenant, site }));
    } catch (e) {
      throw asHttp(e);
    }
  }

  @Put("properties/:id/tracking-tags/linkedin")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async putLinkedin(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown,
  ): Promise<TrackingTagsPutResponse> {
    await this.gate(req, tenantId, id, "manage_tags");
    try {
      return await putLinkedinPartnerId(req.principal, tenantId, id.toLowerCase(), body);
    } catch (e) {
      throw asHttp(e);
    }
  }

  @Put("properties/:id/tracking-tags/google-ads")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async putGoogleAds(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown,
  ): Promise<GoogleAdsPutResponse> {
    await this.gate(req, tenantId, id, "manage_tags");
    try {
      return await putGoogleAds(req.principal, tenantId, id.toLowerCase(), body);
    } catch (e) {
      throw asHttp(e);
    }
  }
}
