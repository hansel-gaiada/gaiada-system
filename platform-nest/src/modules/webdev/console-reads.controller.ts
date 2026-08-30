// WSK-23 — the ERP console's HTTP surface (design §08/§09). NEW FILE, a SEPARATE controller class
// from `WebdevController` / `ZoneBEventsController` (this ticket's own file, not an edit to
// either) — Nest registers multiple controller classes on the SAME `@Controller()` path prefix
// fine as long as their own route sets are disjoint, exactly the precedent both of those files'
// headers already establish for this prefix. Route table:
//
//   GET /api/:tenantId/modules/webdev/console/sites                        -> 200 SiteRegistryResult
//   GET /api/:tenantId/modules/webdev/console/sites/:slug/releases          -> 200 ReleaseHistoryResult
//   GET /api/:tenantId/modules/webdev/console/sites/:slug/submissions[?formId=] -> 200 SubmissionsResult
//   GET /api/:tenantId/modules/webdev/console/contract-pins[?slug=]         -> 200 { pins: ContractPinStatus[] }
//
// ── AUTHZ — NO NEW CERBOS KIND (deliberate; see the ticket's own report on why) ─────────────────
// Design §08's button matrix lists site registry / env status / submissions under ONE gate,
// `webdesk:read` — and both existing kinds this file authorizes against already carry a `read`
// action with the right role tiers wired (`resource_webdev_provisioned_site.yaml`,
// `resource_webdev_contract_snapshot.yaml` — both landed by earlier tickets, both unedited here).
// A new resource kind costs six coupled artifacts (policy + catalog + groups + a seeded migration
// + both bundle resolvers + a regenerated bundle) and this ticket's own brief says: only pay that
// when the existing kinds genuinely do not fit. They fit. Site registry / releases / submissions
// all read against `webdev_provisioned_site` (the console asks "what do we know about this site");
// the contract pin view reads against `webdev_contract_snapshot` (it already owns `read`, WSK-19).
import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  getSiteRegistry, getReleaseHistory, getSubmissions, listContractPinStatuses,
  type SiteRegistryResult, type ReleaseHistoryResult, type SubmissionsResult, type ContractPinStatus,
} from "./console-reads.service";
import { getPortfolio, type PortfolioResult } from "./portfolio-reads.service";

@Controller("api/:tenantId/modules/webdev")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
export class ConsoleReadsController {
  // The ESTATE portfolio — a different question from `console/sites` below, which answers "which
  // Zone B tenants exist" and is honestly stale because the control plane is write-mostly. This
  // answers "what does the estate consist of", including the sites we do not host and must not
  // touch. It reads Zone A's own tables only: no egress, nothing to be stale about, and no reason
  // for it to degrade when Zone B is unreachable.
  //
  // Reuses `webdev_provisioned_site:read` rather than minting a Cerbos kind — the same reasoning as
  // WSK-23, which established that precedent for this module's read surface: a new kind costs six
  // coupled artifacts and this is the same audience reading the same department's site facts.
  @Get("console/portfolio")
  async portfolio(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<PortfolioResult> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "read");
    return getPortfolio(tenantId);
  }

  @Get("console/sites")
  async sites(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<SiteRegistryResult> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "read");
    return getSiteRegistry(tenantId);
  }

  @Get("console/sites/:slug/releases")
  async releases(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("slug") slug: string,
  ): Promise<ReleaseHistoryResult> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "read");
    return getReleaseHistory(tenantId, slug);
  }

  @Get("console/sites/:slug/submissions")
  async submissions(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("slug") slug: string,
    @Query("formId") formId?: string,
  ): Promise<SubmissionsResult> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "read");
    return getSubmissions(tenantId, slug, formId);
  }

  @Get("console/contract-pins")
  async contractPins(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("slug") slug?: string,
  ): Promise<{ pins: ContractPinStatus[] }> {
    await authorize(req.principal, { kind: "webdev_contract_snapshot", tenantId, module: "webdev" }, "read");
    return { pins: await listContractPinStatuses(tenantId, slug) };
  }
}
