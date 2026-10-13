// WSK-60 — the two routes the Website workspace (WSK-44) already calls, as a SEPARATE controller class
// on the shared `api/:tenantId/modules/webdev` prefix (the precedent every other webdev controller
// states: Nest registers several classes on one prefix as long as their route sets are disjoint).
//
//   GET  /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/build-status
//        → 200 { build: { approvalId|null, kind: "publish"|"rebuild", requestedAt, publishedAt|null,
//                         state: "rebuilding"|"live"|"unverified"|"failed", stagingUrl|null,
//                         verifiedAt|null } | null, stagingStale: boolean }
//   POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/rebuild-requests
//        → 202 { approvalId }      files ONE `content.rebuild` WS4 approval
//
// The shapes are EXACTLY platform-ui's `parseBuildStatus` / `parseApprovalId` (src/lib/webdeskContent.ts):
// no key is added, because the editor and this controller are tested against the same key lists
// (BUILD_STATUS_KEYS / BUILD_KEYS in site-builds.service.ts). Why a build failed (`github_app_not_installed`
// and the rest) is NOT on this wire: it is on the ledger row and in the approval's execution result.
//
// ── AUTHZ ────────────────────────────────────────────────────────────────────────────────────────
// M6-P6h: the staging target is resolved by `resolveSiteBuildTarget` (the WEBDESK_REBUILD_TARGETS override, else the
// registry); the 503 below names the typed reason when there is none.
//
// Both routes reuse `webdesk_content_item` (no new Cerbos kind): reading the state of a site's rebuild is
// `read`, and asking for a rebuild is `request_publish`, the same editor-tier action that files a publish
// (the approver, not the requester, holds the dispatch authority: `github_repo · deploy`, checked at
// decide()). authorize() runs FIRST, before any parameter validation, so a denial test that sends a
// well-formed request is really testing authorization (validation must not pre-empt it).
import { BadRequestException, Controller, Get, HttpCode, Param, Post, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { withTenants } from "../../db";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { fileWebdeskCommandApproval } from "./webdesk-approved-command";
import { getBuildStatus, resolveSiteBuildTarget, type BuildStatusBody } from "./site-builds.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;

function site(tenantSlug: string, siteId: string): void {
  if (!SLUG_RE.test(tenantSlug)) throw new BadRequestException("tenantSlug must be a WebDesk tenant slug");
  if (!UUID_RE.test(siteId)) throw new BadRequestException("siteId must be a uuid");
}

@Controller("api/:tenantId/modules/webdev")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
export class SiteBuildsController {
  @Get("content/sites/:tenantSlug/:siteId/build-status")
  async buildStatus(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
  ): Promise<BuildStatusBody> {
    await authorize(req.principal, { kind: "webdesk_content_item", tenantId, module: "webdev" }, "read");
    site(tenantSlug, siteId);
    return getBuildStatus(tenantId, tenantSlug, siteId.toLowerCase());
  }

  @Post("content/sites/:tenantSlug/:siteId/rebuild-requests")
  @HttpCode(202)
  async requestRebuild(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
  ): Promise<{ approvalId: string }> {
    await authorize(req.principal, { kind: "webdesk_content_item", tenantId, module: "webdev" }, "request_publish");
    site(tenantSlug, siteId);
    // Fail early and visibly: an approval for a site with no staging target could only ever fail. M6-P6h: the target is the
    // env override, else the registry (site-build-targets.ts); a wp site has nothing to rebuild (its theme reads /v1 live).
    const target = await resolveSiteBuildTarget(tenantId, tenantSlug, siteId.toLowerCase(), "staging");
    if (!target.ok) {
      throw new ServiceUnavailableException({
        message: `webdesk_not_configured: no staging rebuild target for this site (${target.reason})`,
        reason: "webdesk_not_configured",
      });
    }
    // One open request per site: a second click returns the first's id rather than queueing a duplicate.
    const open = await withTenants([tenantId], async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM automation_approvals
          WHERE tenant_id = $1 AND origin = 'webdesk' AND workflow_id = 'content.rebuild'
            AND status = 'pending' AND deleted_at IS NULL AND tool_args->>'siteId' = $2
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId, siteId.toLowerCase()],
      );
      return r.rows[0] ?? null;
    });
    if (open) return { approvalId: open.id };
    return fileWebdeskCommandApproval(req.principal, tenantId, {
      command: "content.rebuild",
      tenantSlug,
      siteId: siteId.toLowerCase(),
      args: {},
      summary: { title: `Rebuild ${tenantSlug} staging from its published content` },
    });
  }
}
