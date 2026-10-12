// M5-A4 — website analytics reads for a search property, from Umami (WSK-D66).
//   GET /api/:tenantId/modules/search/properties/:propertyId/analytics/:kind?from=YYYY-MM-DD&to=YYYY-MM-DD
//   kind: summary | pages | sources | sections | ctas | forms | vitals
// Cerbos: the EXISTING `resource_search_property` kind, action `read` (no new kind, no policy change).
// The property is resolved through withTenants([tenantId],{modules:['search']}), so a property id from
// another company is invisible (404) and a principal outside the tenant is refused at authorize (403).
//
// A SEPARATE controller class on SearchController's prefix (same reason as search-reports.controller.ts).
//
// Response is always 200 with a `state`, so the UI can say what is wrong in plain words instead of
// showing an empty dashboard (an empty list is a claim):
//   ok            { state, kind, range, data }
//   not_configured  UMAMI_BASE_URL / UMAMI_API_KEY unset on the server
//   not_bound       the property has no umami_site_id
//   unreachable     Umami / the gate did not answer (timeout, network, 5xx)
//   rejected        Umami refused the key (401/403) or does not know the website (404)
// A bad date range is a 400. No error ever carries the key or a visitor value.
import { BadRequestException, Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../db";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { umamiSettings, UmamiAuthError, UmamiError, UmamiNotConfiguredError, UmamiNotFoundError, UmamiUnreachableError, type UmamiGetOpts } from "./umami-client";
import { ANALYTICS_KINDS, AnalyticsRangeError, readAnalytics, resolveRange, type AnalyticsKind } from "./umami-reads";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnalyticsState = "ok" | "not_configured" | "not_bound" | "unreachable" | "rejected";
export interface AnalyticsResponse {
  state: AnalyticsState;
  kind: AnalyticsKind;
  range: { from: string; to: string };
  /** Plain words for every non-ok state. */
  message?: string;
  data?: unknown;
}

const MESSAGES: Record<Exclude<AnalyticsState, "ok">, string> = {
  not_configured: "Website analytics is not set up on this server yet (the Umami address and key are missing).",
  not_bound: "This property is not linked to an Umami website yet.",
  unreachable: "Umami could not be reached. Try again in a moment.",
  rejected: "Umami refused the request: the ERP's key was rejected or the website is not known to Umami.",
};

/** Pure core of the route (no DB): used by the controller and by tests. */
export async function buildAnalytics(
  kind: AnalyticsKind, siteId: string | null, from?: string, to?: string, opts: UmamiGetOpts & { now?: Date } = {},
): Promise<AnalyticsResponse> {
  let r;
  try {
    r = resolveRange(from, to, opts.now);
  } catch (e) {
    if (e instanceof AnalyticsRangeError) throw new BadRequestException(e.message);
    throw e;
  }
  const base = { kind, range: { from: r.from, to: r.to } };
  const fail = (state: Exclude<AnalyticsState, "ok">): AnalyticsResponse => ({ state, ...base, message: MESSAGES[state] });
  const settings = opts.settings === undefined ? umamiSettings() : opts.settings;
  if (!settings) return fail("not_configured");
  if (!siteId || !UUID_RE.test(siteId)) return fail("not_bound");
  try {
    const data = await readAnalytics(kind, { siteId, startAt: r.startAt, endAt: r.endAt, opts: { ...opts, settings } });
    return { state: "ok", ...base, data };
  } catch (e) {
    if (e instanceof UmamiNotConfiguredError) return fail("not_configured");
    if (e instanceof UmamiAuthError || e instanceof UmamiNotFoundError) return fail("rejected");
    if (e instanceof UmamiUnreachableError) return fail("unreachable");
    if (e instanceof UmamiError) return fail("unreachable"); // bad_response: treat as upstream trouble
    throw e;
  }
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchAnalyticsController {
  @Get("properties/:propertyId/analytics/:kind")
  async read(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Param("kind") kind: string, @Query("from") from?: string, @Query("to") to?: string,
  ): Promise<AnalyticsResponse> {
    return this.run(req, tenantId, propertyId, kind, from, to);
  }

  /** The same read with the range in the path: the MCP hub forwards only path params on a GET, so the
   *  MCP tools bind here (search.analytics*). */
  @Get("properties/:propertyId/analytics/:kind/range/:from/:to")
  async readRange(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Param("kind") kind: string, @Param("from") from: string, @Param("to") to: string,
  ): Promise<AnalyticsResponse> {
    return this.run(req, tenantId, propertyId, kind, from, to);
  }

  private async run(
    req: FastifyRequest, tenantId: string, propertyId: string, kind: string, from?: string, to?: string,
  ): Promise<AnalyticsResponse> {
    if (!(ANALYTICS_KINDS as readonly string[]).includes(kind)) throw new NotFoundException("unknown analytics read");
    if (!UUID_RE.test(propertyId)) throw new BadRequestException("propertyId must be a valid id");
    await authorize(req.principal, { kind: "resource_search_property", id: propertyId, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) => c.query(`SELECT umami_site_id AS "umamiSiteId" FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [propertyId]),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("property not found");
    return buildAnalytics(kind as AnalyticsKind, (row.rows[0].umamiSiteId as string | null) ?? null, from, to);
  }
}
