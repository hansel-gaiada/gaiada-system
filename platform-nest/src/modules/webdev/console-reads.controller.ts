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
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  getSiteRegistry, getReleaseHistory, getSubmissions, listContractPinStatuses,
  type SiteRegistryResult, type ReleaseHistoryResult, type SubmissionsResult, type ContractPinStatus,
} from "./console-reads.service";
import { getPortfolio, type PortfolioResult } from "./portfolio-reads.service";
import { withTenants } from "../../db";
import { fileAutomationApproval } from "../../core/approval-filing";
import {
  PROBE_CONSENT_WORKFLOW, PROBE_CONSENT_TOOL, PROBE_CONSENT_ATTESTATION, validateConsentBasis,
} from "../search/probe-consent";

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

  // ── Probe consent: Web Dev ASKS, it never grants (2026-09-03) ──────────────────────────────────
  // Rulings: docs/plans/2026-09-03-probe-consent-rulings.md. `search_properties.verified_at` is what
  // the monitoring sweep builds its probe allowlist from, so it is the record that we may reach out
  // and touch a client's website. 63 of the 81 sites on the live estate lack it. This files a
  // REQUEST; a holder of the authority to write that column decides it
  // (automation-approvals.controller.ts's probe-consent branch), and the search module applies it on
  // the decided event (modules/search/probe-consent.ts). Nothing here can grant anything.
  //
  // ── WHY THE REQUESTER IS GATED ON A WEBDEV ACTION, NOT A SEARCH ONE ───────────────────────────
  // The obvious gate is `resource_search_property · read` — you should see a property to ask about
  // it. It is the wrong gate HERE: Web Dev staff read consent and hosting topology through the
  // PORTFOLIO, which authorizes `webdev_provisioned_site · read` (see `portfolio()` above), and
  // requiring a search action would lock out exactly the people the flow is for. So the requester
  // proves the same thing they already proved to see the row, and no more.
  //
  // That is defensible because filing a request grants NOTHING and mutates no domain state: the
  // bounded risk is queue noise from someone who can already see the site, which is the audience
  // that should be asking. The ruling deferred "the exact Cerbos expression for an eligible
  // approver"; this is its mirror on the requester side, and it is recorded as a decision rather
  // than left implicit.
  @Post("console/probe-consent-requests")
  @HttpCode(201)
  async requestProbeConsent(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { propertyId?: string; basis?: string },
  ): Promise<{ ok: true; approvalId: string; domain: string; attestation: string }> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "read");

    // `requested_by` is the whole point of a request: it records WHO asserted the basis, and the
    // decide path's anti-privilege-amplification checks key on it. A principal with no user id
    // (a service token) must not be able to file an assertion nobody can be held to.
    const requestedBy = req.principal.userId;
    if (!requestedBy) throw new BadRequestException("a consent request must be filed by a signed-in user");

    const propertyId = typeof body?.propertyId === "string" ? body.propertyId : "";
    if (!propertyId) throw new BadRequestException("propertyId is required");

    // RULING §2 — the reference note is mandatory, and validated HERE. A required input in a
    // browser is a suggestion; this is the boundary that makes it a rule.
    const basis = validateConsentBasis(body?.basis);
    if (!basis.ok) throw new BadRequestException(basis.reason);

    // Read the property under the SEARCH module scope: `search_properties` carries
    // `app_module_allowed('search')` in its RLS, so a webdev-scoped connection sees ZERO rows and
    // the error would read as "no such property" rather than "search is off here". The GUC list is
    // the load-bearing part — see portfolio-reads.service.ts's own warning about this exact trap.
    const prop = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ domain: string; verified_at: Date | null }>(
          `SELECT domain, verified_at FROM search_properties
            WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
          [propertyId, tenantId],
        );
        return r.rows[0] ?? null;
      },
      { modules: ["search"] },
    );
    if (!prop) throw new NotFoundException("property not found");
    // Already consented: refuse rather than file a request that would be a no-op on approval. The
    // handler's `verified_at IS NULL` guard would swallow it silently, which is the wrong place to
    // find out.
    if (prop.verified_at) throw new ConflictException("this domain already has probe consent on record");

    // One open request per property. Without this the queue fills with duplicates for the same
    // domain and an approver cannot tell which one to act on.
    const open = await withTenants([tenantId], async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM automation_approvals
          WHERE tenant_id = $1 AND origin = 'search' AND workflow_id = $2
            AND status = 'pending' AND deleted_at IS NULL
            AND tool_args->>'propertyId' = $3
          LIMIT 1`,
        [tenantId, PROBE_CONSENT_WORKFLOW, propertyId],
      );
      return r.rows[0] ?? null;
    });
    if (open) throw new ConflictException("a consent request for this domain is already awaiting a decision");

    const filed = await fileAutomationApproval({
      tenantId,
      workflowId: PROBE_CONSENT_WORKFLOW,
      toolName: PROBE_CONSENT_TOOL,
      // RULING §3 — the attestation TEXT travels with the record, not just the fact of it, so a
      // later wording change cannot silently re-label consent granted under the old sentence.
      toolArgs: { propertyId, domain: prop.domain, basis: basis.basis, attestation: PROBE_CONSENT_ATTESTATION },
      // `high`: this authorizes reaching out to a third party's infrastructure. Every impact tier
      // suspends for a human here anyway (origin='search' can never auto-execute), so this is about
      // how the row READS to whoever finds it in the queue.
      impact: "high",
      reason: `Probe consent for ${prop.domain} — ${basis.basis}`,
      origin: "search",
      requestedBy,
    });

    await writeActivity(tenantId, requestedBy, "requested", "search_property", propertyId, {
      domain: prop.domain, approvalId: filed.id,
    });
    return { ok: true, approvalId: filed.id, domain: prop.domain, attestation: PROBE_CONSENT_ATTESTATION };
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
