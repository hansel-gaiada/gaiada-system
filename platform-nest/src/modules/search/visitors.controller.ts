// M5-V3-g — the consented-visitor routes (design 2026-10-12 §4.8). Under api/:tenantId/modules/search/properties/:propertyId/:
//   GET  visitors?minScore&facet&tag&hasLead&seenFrom&order&limit&cursor   Cerbos resource_search_property · read_visitors
//   GET  visitors/filter/:minScore/:order                                    the same list, first page, filters in the PATH (the MCP hub
//                                                                            forwards only path params on a GET): search.visitors.list
//   GET  visitors/:visitorId                                                 read_visitors · summary, latest 200 events, interests, score parts, lead
//   GET  visitors/interest-rules                                             read_visitors
//   PUT  visitors/interest-rules  (and POST, the same handler: the hub has no PUT)   update · body {rules:[...]} = the COMPLETE set
//   GET  visitors/status                                                     read_visitors · configured, enabled, last ok ingest, bot counts
// The recordings routes are V6's and are not here.
//
// Authorize BEFORE validating (a denial never depends on the body or the query). `read_visitors` is a new action on the existing kind
// (V3-f): module_manager and company_admin, never plain module_staff. 403 (not allowed, or not in the tenant) and 404 (the property or
// visitor is not this company's) are distinct. A non-ok state (status) is words, never an empty list.
//
// THE LEAD LINK. A profile's consent id is matched to `agency_leads.visitor_consent->>'consentId'` in the same tenant, inside the one
// withTenants (as P2 joins agency_leads). The lead id is returned only when the principal may `read` that agency_lead (a Cerbos
// probe through authorize(), on the DETAIL route only (one audit row per opened visitor; list rows say only linked or none), so an acting-for human is intersected too); otherwise the row says "a lead you cannot open".
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  VisitorRequestError, buildVisitorStatus, getVisitor, listInterestRules, listVisitors, parseListFilters, parseRulesBody, replaceInterestRules,
  type InterestRuleDto, type LeadReadProbe, type VisitorDetail, type VisitorRow, type VisitorStatus,
} from "./visitors.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asHttp(e: unknown): unknown {
  return e instanceof VisitorRequestError ? new BadRequestException({ message: e.message, reason: e.reason }) : e;
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchVisitorsController {
  private async gate(req: FastifyRequest, tenantId: string, propertyId: string, action: "read_visitors" | "update"): Promise<void> {
    if (!UUID_RE.test(propertyId)) throw new BadRequestException("propertyId must be a valid id");
    await authorize(req.principal, { kind: "resource_search_property", id: propertyId, tenantId, module: "search" }, action);
  }

  /** May this principal open this lead? Only a Cerbos denial answers no; anything else (a revoked session, an outage) propagates. */
  private leadProbe(req: FastifyRequest, tenantId: string): LeadReadProbe {
    return async (leadId) => {
      try {
        await authorize(req.principal, { kind: "agency_lead", id: leadId, tenantId, module: "agency" }, "read");
        return true;
      } catch (e) {
        if (e instanceof ForbiddenException) return false;
        throw e;
      }
    };
  }

  private async list(
    req: FastifyRequest, tenantId: string, propertyId: string, q: Record<string, string | undefined>,
  ): Promise<{ propertyId: string; visitors: VisitorRow[]; nextCursor: string | null }> {
    await this.gate(req, tenantId, propertyId, "read_visitors");
    let out;
    try {
      const filters = parseListFilters(q);
      out = await listVisitors(tenantId, propertyId, filters);
    } catch (e) { throw asHttp(e); }
    if (!out) throw new NotFoundException("property not found");
    return { propertyId, ...out };
  }

  @Get("properties/:propertyId/visitors")
  async visitors(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.list(req, tenantId, propertyId, query ?? {});
  }

  /** The tool's twin of the list: `minScore` (0 = everyone) and `order` (score | recent) in the path. */
  @Get("properties/:propertyId/visitors/filter/:minScore/:order")
  async visitorsFiltered(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Param("minScore") minScore: string, @Param("order") order: string,
  ) {
    return this.list(req, tenantId, propertyId, { minScore, order });
  }

  @Get("properties/:propertyId/visitors/status")
  async status(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
  ): Promise<VisitorStatus> {
    await this.gate(req, tenantId, propertyId, "read_visitors");
    const s = await buildVisitorStatus(tenantId, propertyId);
    if (!s) throw new NotFoundException("property not found");
    return s;
  }

  @Get("properties/:propertyId/visitors/interest-rules")
  async rules(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
  ): Promise<{ propertyId: string; rules: InterestRuleDto[]; note: string }> {
    await this.gate(req, tenantId, propertyId, "read_visitors");
    const rules = await listInterestRules(tenantId, propertyId);
    if (!rules) throw new NotFoundException("property not found");
    return { propertyId, rules, note: rules.length ? "Interests come only from these rules." : "No rules yet, so no visitor has any interests." };
  }

  @Put("properties/:propertyId/visitors/interest-rules")
  @HttpCode(200)
  async putRules(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Body() body: unknown,
  ) {
    return this.setRules(req, tenantId, propertyId, body);
  }

  /** The tool's twin of the PUT (the MCP hub has no PUT). Nest keeps one HTTP method per handler, so this is a second handler. */
  @Post("properties/:propertyId/visitors/interest-rules")
  @HttpCode(200)
  async postRules(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Body() body: unknown,
  ) {
    return this.setRules(req, tenantId, propertyId, body);
  }

  private async setRules(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Body() body: unknown,
  ): Promise<{ propertyId: string; rules: InterestRuleDto[]; removed: number; note: string }> {
    // Authorize BEFORE validating, so a denial never depends on the body.
    await this.gate(req, tenantId, propertyId, "update");
    let input;
    try { input = parseRulesBody(body); } catch (e) { throw asHttp(e); }
    const out = await replaceInterestRules(tenantId, propertyId, input);
    if (!out) throw new NotFoundException("property not found");
    await writeActivity(tenantId, req.principal.userId ?? null, "updated", "search_interest_rules", propertyId, {
      propertyId, rules: out.rules.length, removed: out.removed,
    });
    return { propertyId, ...out, note: "Interests and scores follow the new rules at the next daily refresh." };
  }

  @Get("properties/:propertyId/visitors/:visitorId")
  async visitor(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Param("visitorId") visitorId: string,
  ): Promise<{ propertyId: string; visitor: VisitorDetail }> {
    await this.gate(req, tenantId, propertyId, "read_visitors");
    if (!UUID_RE.test(visitorId)) throw new BadRequestException({ message: "visitorId must be a valid id", reason: "visitor_id_invalid" });
    const out = await getVisitor(tenantId, propertyId, visitorId.toLowerCase(), this.leadProbe(req, tenantId));
    if (!out.propertyFound) throw new NotFoundException("property not found");
    if (!out.visitor) throw new NotFoundException({ message: "no consented visitor with this id on this property", reason: "visitor_not_found" });
    return { propertyId, visitor: out.visitor };
  }
}
