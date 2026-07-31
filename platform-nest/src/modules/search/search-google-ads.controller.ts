// SM-25c — the HTTP surface over google/ads-client.ts's service layer (design addendum §A12; tracker
// §6x.3 item 5 "SM-25c · Ads read binding"). A SEPARATE controller class from `SearchController`
// (deliberately — SM-21 owns that file's edit surface for its own routes this wave; two agents
// touching one controller file concurrently is how work gets lost, per the coordinator's own standing
// rule). Nest permits multiple controller classes to share one route PREFIX as long as no individual
// route path collides — this class reuses `SearchController`'s exact prefix
// (`api/:tenantId/modules/search`) for the identical reason `search-google-oauth.controller.ts`
// explains it cannot: unlike that file's tenant-agnostic OAuth callback, every route here IS
// tenant-scoped (a normal authenticated BFF caller, never Google's own redirect), so there is no
// reason to diverge from the module's one conventional mount point.
//
// Every function imported from google/oauth.ts / google/ads-client.ts returns a MASKED view or a
// plain data outcome — token material is structurally absent from all of them, never re-widened by
// anything in this file (the same invariant search.controller.ts's own SM-25a section states).
//
// Cerbos kind stays `resource_search_property` throughout, matching every other Google-surface route
// in this module (§A12's own ruling, restated in search.controller.ts's SM-25a/SM-25b sections: "no
// new Cerbos policy file is needed"): `update` for the account link and the pull (both genuinely new
// writes), `read` for the history reader.
//
// THIS TICKET ADDS NO N8N-REACHABLE ROUTE and no scheduler wiring — every route below is triggered by
// an authenticated human/service caller only (§A9.8's "flows own zero routes", identical to
// SM-25b's own posture for gsc-pull/ga4-pull).
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../db";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { linkAdsCustomerId, listAdsCampaignMetrics, pullAdsMetricsForEngagement } from "./google/ads-client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(value: string, label: string): void {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new BadRequestException(`${label} must be a valid id`);
}

async function engagementPropertyId(tenantId: string, engagementId: string): Promise<string> {
  const row = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ property_id: string }>(
        `SELECT property_id FROM search_engagements WHERE id = $1 AND deleted_at IS NULL`,
        [engagementId],
      ),
    { modules: ["search"] },
  );
  const propertyId = row.rows[0]?.property_id;
  if (!propertyId) throw new NotFoundException("engagement not found");
  return propertyId;
}

async function campaignBelongsToTenant(tenantId: string, campaignId: string): Promise<boolean> {
  const row = await withTenants(
    [tenantId],
    (c) => c.query<{ id: string }>(`SELECT id FROM search_campaigns WHERE id = $1 AND deleted_at IS NULL`, [campaignId]),
    { modules: ["search"] },
  );
  return row.rows.length > 0;
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchGoogleAdsController {
  // ===================================================== SM-25c: THE ACCOUNT LINK =================
  // Sets/changes which Ads customer (account) id an ALREADY-linked google_ads connection queries —
  // the one fact the OAuth grant itself never carries (a Google login can see many Ads accounts under
  // an MCC). See google/ads-client.ts's file header for why this is a separate step from the
  // connection link itself.
  @Put("google/connections/:id/ads-account")
  @HttpCode(200)
  async linkAdsAccount(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { customerId?: string },
  ) {
    assertUuid(id, "id");
    if (!body?.customerId) throw new BadRequestException("customerId required");
    await authorize(req.principal, { kind: "resource_search_property", tenantId, module: "search" }, "update");
    let view;
    try {
      view = await linkAdsCustomerId(tenantId, id, body.customerId);
    } catch (err) {
      // linkAdsCustomerId throws a plain Error for its two validation cases (empty/non-digit
      // customerId, wrong-provider connection) — same convention sem-search-terms.ts's
      // validateSearchTermBatch uses, so the controller is what turns it into a 400. Every
      // GoogleSurfaceError it can ALSO throw (connection not found) is left to propagate — mapped
      // globally by GoogleOAuthErrorFilter, no catch/rethrow needed for that class.
      if (err instanceof Error && err.constructor === Error) throw new BadRequestException(err.message);
      throw err;
    }
    await writeActivity(tenantId, req.principal.userId, "google_ads_account_linked", "search_google_connection", id, {
      customerId: view.externalAccount,
    });
    return view;
  }

  // ===================================================== SM-25c: THE PULL ==========================
  @Post("engagements/:id/ads-pull")
  @HttpCode(200)
  async pullAdsMetrics(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { customerId?: string; startDate?: string; endDate?: string },
  ) {
    assertUuid(id, "id");
    await authorize(req.principal, { kind: "resource_search_property", tenantId, module: "search" }, "update");
    const propertyId = await engagementPropertyId(tenantId, id);
    const outcome = await pullAdsMetricsForEngagement({
      tenantId, engagementId: id, propertyId,
      customerId: body?.customerId, startDate: body?.startDate, endDate: body?.endDate,
    });
    await writeActivity(tenantId, req.principal.userId, "ads_pull", "search_engagement", id, {
      rowsUpserted: outcome.rowsUpserted, campaignsTracked: outcome.campaignsTracked,
      pagesFetched: outcome.pagesFetched, truncated: outcome.truncated,
      startDate: outcome.startDate, effectiveEndDate: outcome.effectiveEndDate,
    });
    return outcome;
  }

  // ===================================================== SM-25c: THE READER ========================
  // Raw history reader — BADGE, not filter (search.controller.ts's own established
  // listGscPerformance/listGa4Metrics/listRankSnapshots disposition, §A4.7): every row already
  // carries its own simulated/source, so a console can show CSV/Ads-Scripts/live-API rows side by
  // side without any of them silently vanishing the moment more than one pipe has written to this
  // campaign.
  @Get("campaigns/:id/ads-metrics")
  async listAdsMetrics(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("startDate") startDate?: string, @Query("endDate") endDate?: string, @Query("limit") limitParam?: string,
  ) {
    assertUuid(id, "id");
    await authorize(req.principal, { kind: "resource_search_property", tenantId, module: "search" }, "read");
    if (!(await campaignBelongsToTenant(tenantId, id))) throw new NotFoundException("campaign not found");
    return listAdsCampaignMetrics({
      tenantId, campaignId: id, startDate, endDate,
      limit: limitParam ? Number(limitParam) : undefined,
    });
  }
}
