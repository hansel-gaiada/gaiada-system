// Agency vertical routes (Nest port of modules/agency/index.ts routes). Mounted under
// /api/:tenantId/modules/agency and gated by AuthGuard + the per-tenant module enable guard.
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity, notify } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";

@Controller("api/:tenantId/modules/agency")
@UseGuards(AuthGuard, ModuleEnabledGuard("agency"))
export class AgencyController {
  @Get("campaigns")
  async listCampaigns(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "agency_campaign", tenantId, module: "agency" }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT id, name, status, project_id, budget_minor, currency FROM agency_campaigns
               WHERE deleted_at IS NULL ORDER BY created_at DESC`),
    );
    return rows.rows;
  }

  @Post("campaigns")
  @HttpCode(201)
  async createCampaign(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: { name?: string; projectId?: string }) {
    const { name, projectId } = body ?? {};
    if (!name || !projectId) throw new BadRequestException("name and projectId required");
    await authorize(req.principal, { kind: "agency_campaign", tenantId, module: "agency" }, "create");
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(`INSERT INTO agency_campaigns (id, tenant_id, project_id, name, origin_site) VALUES ($1, $2, $3, $4, $5)`, [
        id, tenantId, projectId, name, config.originSite,
      ]),
    );
    await writeActivity(tenantId, req.principal.userId, "created", "agency_campaign", id, { name });
    return { id };
  }

  @Post("approvals")
  @HttpCode(201)
  async createApproval(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: { campaignId?: string; subject?: string }) {
    const { campaignId, subject } = body ?? {};
    if (!campaignId || !subject) throw new BadRequestException("campaignId and subject required");
    await authorize(req.principal, { kind: "agency_approval", tenantId, module: "agency", ownerId: req.principal.userId ?? undefined }, "create");
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO agency_approvals (id, tenant_id, campaign_id, subject, requested_by, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, tenantId, campaignId, subject, req.principal.userId, config.originSite],
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "created", "agency_approval", id, { subject });
    return { id };
  }

  @Get("approvals/pending")
  async pending(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "agency_approval", tenantId, module: "agency" }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT a.id, a.subject, a.created_at, c.name AS campaign FROM agency_approvals a
               JOIN agency_campaigns c ON c.id = a.campaign_id
               WHERE a.status = 'pending' AND a.deleted_at IS NULL ORDER BY a.created_at`),
    );
    return rows.rows;
  }

  @Post("approvals/:approvalId/decide")
  @HttpCode(200)
  async decide(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("approvalId") approvalId: string, @Body() body: { decision?: "approved" | "rejected" }) {
    const decision = body?.decision;
    if (decision !== "approved" && decision !== "rejected") throw new BadRequestException("decision must be approved|rejected");
    await authorize(req.principal, { kind: "agency_approval", id: approvalId, tenantId, module: "agency" }, "approve");
    const requestedBy = await withTenants([tenantId], async (c) => {
      const upd = await c.query<{ asset_id: string | null; requested_by: string | null }>(
        `UPDATE agency_approvals SET status = $2, decided_by = $3, decided_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING asset_id, requested_by`,
        [approvalId, decision, req.principal.userId],
      );
      const assetId = upd.rows[0]?.asset_id;
      if (assetId) {
        await c.query(`UPDATE agency_creative_assets SET review_status = $2, updated_at = now() WHERE id = $1`, [assetId, decision]);
      }
      return upd.rows[0]?.requested_by ?? null;
    });
    await writeActivity(tenantId, req.principal.userId, decision, "agency_approval", approvalId);
    await notify(tenantId, requestedBy, req.principal.userId, "approval_decided", { approvalId, decision });
    return { id: approvalId, status: decision };
  }

  @Get("campaigns/:campaignId/briefs")
  async listBriefs(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string) {
    await authorize(req.principal, { kind: "agency_brief", tenantId, module: "agency" }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT id, title, body, status, created_at FROM agency_briefs
               WHERE campaign_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [campaignId]),
    );
    return rows.rows;
  }

  @Post("campaigns/:campaignId/briefs")
  @HttpCode(201)
  async createBrief(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string, @Body() body: { title?: string; body?: string }) {
    const { title, body: text = "" } = body ?? {};
    if (!title) throw new BadRequestException("title required");
    await authorize(req.principal, { kind: "agency_brief", tenantId, module: "agency" }, "create");
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(`INSERT INTO agency_briefs (id, tenant_id, campaign_id, title, body, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`, [
        id, tenantId, campaignId, title, text, config.originSite,
      ]),
    );
    await writeActivity(tenantId, req.principal.userId, "created", "agency_brief", id, { title });
    return { id };
  }

  @Get("campaigns/:campaignId/assets")
  async listAssets(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string) {
    await authorize(req.principal, { kind: "agency_creative_asset", tenantId, module: "agency" }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT id, name, kind, media_ref, review_status, custom_fields FROM agency_creative_assets
               WHERE campaign_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [campaignId]),
    );
    return rows.rows;
  }

  @Post("campaigns/:campaignId/assets")
  @HttpCode(201)
  async createAsset(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string, @Body() body: { name?: string; kind?: string; mediaRef?: string }) {
    const { name, kind = "design", mediaRef } = body ?? {};
    if (!name) throw new BadRequestException("name required");
    await authorize(req.principal, { kind: "agency_creative_asset", tenantId, module: "agency" }, "create");
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO agency_creative_assets (id, tenant_id, campaign_id, name, kind, media_ref, origin_site) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenantId, campaignId, name, kind, mediaRef ?? null, config.originSite],
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "created", "agency_creative_asset", id, { name });
    return { id };
  }

  @Post("assets/:assetId/submit")
  @HttpCode(201)
  async submit(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("assetId") assetId: string) {
    await authorize(req.principal, { kind: "agency_approval", tenantId, module: "agency", ownerId: req.principal.userId ?? undefined }, "create");
    const approvalId = await withTenants([tenantId], async (c) => {
      const asset = await c.query<{ campaign_id: string; name: string }>(
        `SELECT campaign_id, name FROM agency_creative_assets WHERE id = $1 AND deleted_at IS NULL`, [assetId],
      );
      if (!asset.rows[0]) return null;
      await c.query(`UPDATE agency_creative_assets SET review_status = 'in_review', updated_at = now() WHERE id = $1`, [assetId]);
      const id = newId();
      await c.query(
        `INSERT INTO agency_approvals (id, tenant_id, campaign_id, asset_id, subject, requested_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenantId, asset.rows[0].campaign_id, assetId, `Review: ${asset.rows[0].name}`, req.principal.userId, config.originSite],
      );
      return id;
    });
    if (!approvalId) throw new NotFoundException("asset not found");
    await writeActivity(tenantId, req.principal.userId, "submitted", "agency_creative_asset", assetId);
    return { approvalId };
  }
}
