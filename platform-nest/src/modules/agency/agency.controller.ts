// Agency vertical routes (Nest port of modules/agency/index.ts routes). Mounted under
// /api/:tenantId/modules/agency and gated by AuthGuard + the per-tenant module enable guard.
import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, HttpException,
  NotFoundException, Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { DatabaseError } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity, notify } from "../../core/http";
import { notifyBestEffort } from "../../core/client-notify";
import { resolveAgencyApprovalDeciders } from "../../core/approval-deciders";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { isModuleEnabled } from "../registry";
import { emitEvent } from "../../events/outbox.service";
import { isUuidShaped } from "../../core/dept-resolution";
import type { Resource } from "../../rbac/cerbos";
import * as parts from "./agency-campaign-parts.service";

@Controller("api/:tenantId/modules/agency")
@UseGuards(AuthGuard, ModuleEnabledGuard("agency"))
export class AgencyController {
  // DW-5a (§31.4): today's fields are unchanged; each row gains `leadUnitId`, `startsOn`, `endsOn`, `clientId` (from the
  // campaign's project) and `partCount`. `?unitId=<dept>` keeps only the campaigns where that department has a live part
  // or leads, and then every row carries `part: {id, status, ownerId, ownerName, dueOn} | null` (null = only leads).
  @Get("campaigns")
  async listCampaigns(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("unitId") unitIdQ?: string) {
    await authorize(req.principal, { kind: "agency_campaign", tenantId, module: "agency" }, "read");
    const unitId = unitIdQ === undefined || unitIdQ === "" ? null : await mapRules(async () => parts.parseUnitId(unitIdQ));
    if (unitId) await authorize(req.principal, partResource(tenantId), "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query<{
        id: string; name: string; status: string; project_id: string; budget_minor: string | null; currency: string | null;
        lead_unit_id: string | null; starts_on: string | null; ends_on: string | null; client_id: string | null; part_count: number;
        part_id: string | null; part_status: string | null; part_owner_id: string | null; part_owner_name: string | null; part_due_on: string | null;
      }>(
        `SELECT c.id, c.name, c.status, c.project_id, c.budget_minor, c.currency,
                c.lead_unit_id, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on, p.client_id,
                (SELECT count(*)::int FROM agency_campaign_parts x WHERE x.campaign_id = c.id AND x.deleted_at IS NULL) AS part_count,
                pt.id AS part_id, pt.status AS part_status, pt.owner_id AS part_owner_id, u.name AS part_owner_name,
                pt.due_on::text AS part_due_on
           FROM agency_campaigns c
           LEFT JOIN projects p ON p.id = c.project_id
           LEFT JOIN agency_campaign_parts pt ON pt.campaign_id = c.id AND pt.unit_id = $1::text AND pt.deleted_at IS NULL
           LEFT JOIN users u ON u.id = pt.owner_id
          WHERE c.deleted_at IS NULL
            AND ($1::text IS NULL OR pt.id IS NOT NULL OR c.lead_unit_id = $1::text)
          ORDER BY c.created_at DESC`,
        [unitId],
      ),
    );
    return rows.rows.map((r) => ({
      id: r.id, name: r.name, status: r.status, project_id: r.project_id, budget_minor: r.budget_minor, currency: r.currency,
      leadUnitId: r.lead_unit_id, startsOn: r.starts_on, endsOn: r.ends_on, clientId: r.client_id, partCount: r.part_count,
      ...(unitId
        ? {
            part: r.part_id
              ? { id: r.part_id, status: r.part_status, ownerId: r.part_owner_id, ownerName: r.part_owner_name, dueOn: r.part_due_on }
              : null,
          }
        : {}),
    }));
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
    // MAIL-06 (F1 fix) — subject-review creation path. Notify the mirrored agency_approval
    // DECIDE-equivalent set (resource_agency_approval.yaml's `approve` action; see
    // approval-deciders.ts's header for the exact mirror, ex-Q-V8).
    const deciders = await resolveAgencyApprovalDeciders(tenantId);
    await notifyBestEffort(tenantId, req.principal.userId, deciders, "approval.requested", {
      title: subject,
      // APPR-01: was the bare list — a decider clicking the email had to hunt for the row. The
      // per-approval detail route (`platform-ui` `/approvals/[id]`) resolves this id against
      // `GET .../modules/agency/approvals/:approvalId` (below).
      href: `/approvals/${id}`,
      entityType: "agency_approval",
      entityId: id,
      origin: "agency",
    });
    return { id };
  }

  @Get("approvals/pending")
  async pending(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "agency_approval", tenantId, module: "agency" }, "read");
    // campaignId lets the UI deep-link a pending item to its campaign.
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT a.id, a.subject, a.created_at, a.campaign_id AS "campaignId", c.name AS campaign FROM agency_approvals a
               JOIN agency_campaigns c ON c.id = a.campaign_id
               WHERE a.status = 'pending' AND a.deleted_at IS NULL ORDER BY a.created_at`),
    );
    return rows.rows;
  }

  // Decided-approval history (Approvals page "Recently decided").
  @Get("approvals/decided")
  async decided(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "agency_approval", tenantId, module: "agency" }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT a.id, a.subject, a.campaign_id AS "campaignId", c.name AS campaign, a.status AS decision,
                      a.decided_at, u.name AS decided_by
               FROM agency_approvals a
               JOIN agency_campaigns c ON c.id = a.campaign_id
               LEFT JOIN users u ON u.id = a.decided_by
               WHERE a.status IN ('approved','rejected') AND a.deleted_at IS NULL
               ORDER BY a.decided_at DESC LIMIT 100`),
    );
    return rows.rows;
  }

  @Post("approvals/:approvalId/decide")
  @HttpCode(200)
  async decide(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("approvalId") approvalId: string, @Body() body: { decision?: "approved" | "rejected" }) {
    const decision = body?.decision;
    if (decision !== "approved" && decision !== "rejected") throw new BadRequestException("decision must be approved|rejected");
    await authorize(req.principal, { kind: "agency_approval", id: approvalId, tenantId, module: "agency" }, "approve");
    const decided = await withTenants([tenantId], async (c) => {
      const upd = await c.query<{ asset_id: string | null; requested_by: string | null; campaign_id: string }>(
        `UPDATE agency_approvals SET status = $2, decided_by = $3, decided_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING asset_id, requested_by, campaign_id`,
        [approvalId, decision, req.principal.userId],
      );
      const assetId = upd.rows[0]?.asset_id;
      if (assetId) {
        await c.query(`UPDATE agency_creative_assets SET review_status = $2, updated_at = now() WHERE id = $1`, [assetId, decision]);
      }
      return upd.rows[0] ?? null;
    });
    await writeActivity(tenantId, req.principal.userId, decision, "agency_approval", approvalId);
    if (decided?.requested_by) {
      // Deep-link to the campaign the reviewed asset/subject belongs to (agency has no
      // standalone asset detail page today — /agency/campaigns/:id is the existing convention).
      await notify(tenantId, decided.requested_by, req.principal.userId, "approval_decided", {
        title: decision === "approved" ? "Your submission was approved" : "Your submission was rejected",
        severity: decision === "approved" ? "info" : "warning",
        entityType: "agency_approval", entityId: approvalId,
        href: `/agency/campaigns/${decided.campaign_id}`,
        approvalId, decision,
      });
    }
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
    const created = await withTenants([tenantId], async (c) => {
      const asset = await c.query<{ campaign_id: string; name: string }>(
        `SELECT campaign_id, name FROM agency_creative_assets WHERE id = $1 AND deleted_at IS NULL`, [assetId],
      );
      if (!asset.rows[0]) return null;
      await c.query(`UPDATE agency_creative_assets SET review_status = 'in_review', updated_at = now() WHERE id = $1`, [assetId]);
      const id = newId();
      const subject = `Review: ${asset.rows[0].name}`;
      await c.query(
        `INSERT INTO agency_approvals (id, tenant_id, campaign_id, asset_id, subject, requested_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenantId, asset.rows[0].campaign_id, assetId, subject, req.principal.userId, config.originSite],
      );
      return { id, subject };
    });
    if (!created) throw new NotFoundException("asset not found");
    await writeActivity(tenantId, req.principal.userId, "submitted", "agency_creative_asset", assetId);
    // MAIL-06 (F1 fix) — asset-review creation path (the SECOND of the two agency_approvals INSERT
    // sites the ticket names explicitly). Same mirrored decider set as the subject path above.
    const deciders = await resolveAgencyApprovalDeciders(tenantId);
    await notifyBestEffort(tenantId, req.principal.userId, deciders, "approval.requested", {
      title: created.subject,
      // APPR-01: was the bare list — see createApproval() above for the full rationale.
      href: `/approvals/${created.id}`,
      entityType: "agency_approval",
      entityId: created.id,
      origin: "agency",
    });
    return { approvalId: created.id };
  }

  // APPR-01 — single-row read backing `platform-ui`'s `/approvals/[id]` detail page. Fetch BEFORE
  // authorize (same "no weaker than the list, no info leak" pattern as
  // automation-approvals.controller.ts's `detail()`): RLS (withTenants) has already made a
  // cross-tenant id invisible, so "not found for this tenant" is a genuine 404. Same `read` action
  // the `pending`/`decided` endpoints above already gate on — no new authorization model.
  @Get("approvals/:approvalId")
  async approvalDetail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("approvalId") approvalId: string) {
    const { rows } = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT a.id, a.subject, a.campaign_id AS "campaignId", c.name AS campaign, a.asset_id AS "assetId",
                a.status, a.requested_by AS "requestedBy", ru.name AS "requestedByName",
                a.decided_by AS "decidedBy", du.name AS "decidedByName",
                a.decided_at AS "decidedAt", a.created_at AS "createdAt"
         FROM agency_approvals a
         JOIN agency_campaigns c ON c.id = a.campaign_id
         LEFT JOIN users ru ON ru.id = a.requested_by
         LEFT JOIN users du ON du.id = a.decided_by
         WHERE a.id = $1 AND a.deleted_at IS NULL`,
        [approvalId],
      ),
    );
    const row = rows[0];
    if (!row) throw new NotFoundException("approval not found");
    await authorize(req.principal, { kind: "agency_approval", tenantId, module: "agency" }, "read");
    return row;
  }

  // ══════════════════════════════════ DW-5a — campaign parts (FRONTEND-BFF-CONTRACT §31) ══════════════════════════════════
  // The money rules, validation and SQL live in agency-campaign-parts.service.ts. Every handler here follows one
  // order: (1) cheap path checks, (2) read what Cerbos needs to see (the part's owner and unit ancestry; never from
  // the body), (3) AUTHORIZE, (4) only then validate the body (so validation never pre-empts a 403), (5) one
  // `withTenants` transaction holding the campaign lock where money is involved, with the outbox event in it,
  // (6) activity and notification after the commit.

  @Get("campaigns/:campaignId")
  async getCampaign(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string) {
    await authorize(req.principal, { kind: "agency_campaign", id: campaignId, tenantId, module: "agency" }, "read");
    await authorize(req.principal, partResource(tenantId), "read");
    return mapRules(async () => {
      parts.requireUuid(campaignId, "campaign_not_found", "campaign not found");
      const base = await withTenants([tenantId], async (c) => {
        const camp = await c.query<{
          id: string; name: string; status: string; projectId: string; clientId: string | null;
          leadUnitId: string | null; startsOn: string | null; endsOn: string | null; budget_minor: string | null; currency: string | null;
        }>(
          `SELECT c.id, c.name, c.status, c.project_id AS "projectId", p.client_id AS "clientId",
                  c.lead_unit_id AS "leadUnitId", c.starts_on::text AS "startsOn", c.ends_on::text AS "endsOn",
                  c.budget_minor::text AS budget_minor, c.currency
             FROM agency_campaigns c LEFT JOIN projects p ON p.id = c.project_id
            WHERE c.id = $1 AND c.deleted_at IS NULL`,
          [campaignId],
        );
        if (!camp.rows[0]) throw new parts.PartRuleError(404, "campaign_not_found", "campaign not found");
        const partRows = await c.query<{
          id: string; unit_id: string; owner_id: string | null; owner_name: string | null; status: string;
          brief: string; due_on: string | null; budget_minor: string | null;
        }>(
          `SELECT pt.id, pt.unit_id, pt.owner_id, u.name AS owner_name, pt.status, pt.brief, pt.due_on::text AS due_on,
                  pt.budget_minor::text AS budget_minor
             FROM agency_campaign_parts pt LEFT JOIN users u ON u.id = pt.owner_id
            WHERE pt.campaign_id = $1 AND pt.deleted_at IS NULL ORDER BY pt.created_at, pt.id`,
          [campaignId],
        );
        const alloc = await parts.allocationOf(c, campaignId);
        const units = await parts.loadOrgUnits(c, tenantId);
        const reqs = await parts.requestCountsByPart(c, partRows.rows.map((r) => r.id));
        return { camp: camp.rows[0], partRows: partRows.rows, alloc, units, reqs };
      });

      // Department campaigns linked to each part. A link is shown only when its module is on for the tenant AND the
      // caller may read that kind of campaign (the same child gates the link route uses); `linkAccess` says which,
      // so an empty list is never mistaken for "nothing is linked".
      const partIds = base.partRows.map((r) => r.id);
      const linkAccess: Record<"searchCampaigns" | "socialCampaigns", "ok" | "module_off" | "forbidden"> = {
        searchCampaigns: "ok", socialCampaigns: "ok",
      };
      const searchByPart = new Map<string, Array<{ id: string; name: string; status: string; budgetMinor: number | null; currency: string | null }>>();
      const socialByPart = new Map<string, Array<{ id: string; name: string; status: string }>>();
      if (partIds.length) {
        linkAccess.searchCampaigns = await linkReadAccess(req, tenantId, "search_campaign");
        if (linkAccess.searchCampaigns === "ok") {
          const { rows } = await withTenants(
            [tenantId],
            (c) => c.query<{ id: string; name: string; status: string; budget_minor: string | null; currency: string | null; agency_part_id: string }>(
              `SELECT id, name, status, budget_minor::text AS budget_minor, currency, agency_part_id
                 FROM search_campaigns WHERE agency_part_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY created_at, id`,
              [partIds],
            ),
            { modules: ["search"] },
          );
          for (const r of rows) {
            const list = searchByPart.get(r.agency_part_id) ?? [];
            // A linked SEO campaign keeps its OWN budget and currency; it is listed beside its part, never summed (§31.3 rule 8).
            list.push({ id: r.id, name: r.name, status: r.status, budgetMinor: parts.toNum(r.budget_minor), currency: r.currency });
            searchByPart.set(r.agency_part_id, list);
          }
        }
        linkAccess.socialCampaigns = await linkReadAccess(req, tenantId, "social_campaign");
        if (linkAccess.socialCampaigns === "ok") {
          const { rows } = await withTenants(
            [tenantId],
            (c) => c.query<{ id: string; name: string; status: string; agency_part_id: string }>(
              `SELECT id, name, status, agency_part_id
                 FROM social_campaigns WHERE agency_part_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY created_at, id`,
              [partIds],
            ),
            { modules: ["social"] },
          );
          for (const r of rows) {
            const list = socialByPart.get(r.agency_part_id) ?? [];
            list.push({ id: r.id, name: r.name, status: r.status });
            socialByPart.set(r.agency_part_id, list);
          }
        }
      }

      const { camp, units } = base;
      return {
        id: camp.id, name: camp.name, status: camp.status, projectId: camp.projectId, clientId: camp.clientId,
        leadUnitId: camp.leadUnitId,
        // A unit that has since left the tree reads null, never a stale name.
        leadUnitName: camp.leadUnitId ? units.get(camp.leadUnitId)?.name ?? null : null,
        startsOn: camp.startsOn, endsOn: camp.endsOn,
        money: parts.moneySnapshot(parts.toBig(camp.budget_minor), camp.currency, base.alloc.allocated),
        parts: base.partRows.map((r) => {
          const unit = units.get(r.unit_id);
          return {
            id: r.id, unitId: r.unit_id, unitName: unit?.name ?? null, unitMissing: !unit,
            ownerId: r.owner_id, ownerName: r.owner_name, status: r.status, brief: r.brief, dueOn: r.due_on,
            budgetMinor: parts.toNum(r.budget_minor),
            links: { searchCampaigns: searchByPart.get(r.id) ?? [], socialCampaigns: socialByPart.get(r.id) ?? [] },
            requests: base.reqs.get(r.id) ?? { open: 0, delivered: 0, declined: 0 },
          };
        }),
        linkAccess,
      };
    });
  }

  @Patch("campaigns/:campaignId")
  async patchCampaign(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string, @Body() body: unknown,
  ) {
    await authorize(req.principal, { kind: "agency_campaign", id: campaignId, tenantId, module: "agency" }, "update");
    const out = await mapRules(async () => {
      parts.requireUuid(campaignId, "campaign_not_found", "campaign not found");
      const p = parts.parseCampaignPatch(body);
      return withTenants([tenantId], async (c) => {
        // The money lock first: rule 5 compares the NEW budget/currency with allocations no concurrent write can move.
        const cur = await parts.lockCampaign(c, campaignId);
        if (!cur) throw new parts.PartRuleError(404, "campaign_not_found", "campaign not found");
        if (p.leadUnitId) parts.requireDepartment(await parts.loadOrgUnits(c, tenantId), p.leadUnitId, "leadUnitId");
        const next = {
          name: p.name ?? cur.name,
          status: p.status ?? cur.status,
          budget: p.budgetMinor !== undefined ? p.budgetMinor : parts.toBig(cur.budget_minor),
          currency: p.currency !== undefined ? p.currency : cur.currency,
          lead: p.leadUnitId !== undefined ? p.leadUnitId : cur.lead_unit_id,
          startsOn: p.startsOn !== undefined ? p.startsOn : cur.starts_on,
          endsOn: p.endsOn !== undefined ? p.endsOn : cur.ends_on,
        };
        parts.checkDates(next.startsOn, next.endsOn);
        const alloc = await parts.allocationOf(c, campaignId);
        if (p.budgetMinor !== undefined || p.currency !== undefined) {
          parts.checkCampaignMoneyChange({
            currentCurrency: cur.currency, nextBudget: next.budget, nextCurrency: next.currency,
            allocatedMinor: alloc.allocated, allocationCount: alloc.count,
          });
        }
        await c.query(
          `UPDATE agency_campaigns
              SET name = $2, status = $3, budget_minor = $4::bigint, currency = $5, lead_unit_id = $6,
                  starts_on = $7::date, ends_on = $8::date, updated_at = now()
            WHERE id = $1`,
          [campaignId, next.name, next.status, next.budget === null ? null : next.budget.toString(), next.currency, next.lead, next.startsOn, next.endsOn],
        );
        await emitEvent(c, tenantId, "agency_campaign", campaignId, "agency.campaign.updated", { campaignId });
        return { fields: Object.keys(p), money: parts.moneySnapshot(next.budget, next.currency, alloc.allocated) };
      });
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "agency_campaign", campaignId, { fields: out.fields });
    return { id: campaignId, money: out.money };
  }

  @Post("campaigns/:campaignId/parts")
  @HttpCode(201)
  async createPart(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string, @Body() body: unknown,
  ) {
    // create FIRST, so a caller who may not add a department is refused 403 whatever they sent; `allocate` follows
    // only when a budget is actually being set.
    await authorize(req.principal, partResource(tenantId), "create");
    const p = await mapRules(async () => {
      parts.requireUuid(campaignId, "campaign_not_found", "campaign not found");
      return parts.parsePartCreate(body);
    });
    if (p.budgetMinor !== null) await authorize(req.principal, partResource(tenantId), "allocate");

    const created = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const camp = await parts.lockCampaign(c, campaignId);
        if (!camp) throw new parts.PartRuleError(404, "campaign_not_found", "campaign not found");
        const unit = parts.requireDepartment(await parts.loadOrgUnits(c, tenantId), p.unitId);
        if (p.ownerId) await parts.requireActiveOwner(c, tenantId, p.ownerId);
        if (p.budgetMinor !== null) {
          const a = await parts.allocationOf(c, campaignId);
          parts.checkAllocation({
            campaignBudget: parts.toBig(camp.budget_minor), campaignCurrency: camp.currency,
            allocatedByOthers: a.allocated, requested: p.budgetMinor,
          });
        }
        const dup = await c.query(
          `SELECT 1 FROM agency_campaign_parts WHERE campaign_id = $1 AND unit_id = $2 AND deleted_at IS NULL`,
          [campaignId, p.unitId],
        );
        if (dup.rows[0]) throw partExists();
        const id = newId();
        try {
          await c.query(
            `INSERT INTO agency_campaign_parts
               (id, tenant_id, campaign_id, unit_id, owner_id, brief, due_on, budget_minor, created_by, origin_site)
             VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::bigint, $9, $10)`,
            [id, tenantId, campaignId, p.unitId, p.ownerId, p.brief, p.dueOn, p.budgetMinor === null ? null : p.budgetMinor.toString(), req.principal.userId, config.originSite],
          );
        } catch (e) {
          if (e instanceof DatabaseError && e.code === "23505") throw partExists();
          throw e;
        }
        await emitEvent(c, tenantId, "agency_campaign_part", id, "agency.campaign_part.created", { campaignId, partId: id });
        return { id, campaignName: camp.name, unitName: unit.name };
      }),
    );
    await writeActivity(tenantId, req.principal.userId, "created", "agency_campaign_part", created.id, { campaignId, unitId: p.unitId });
    await notifyPartOwner(tenantId, p.ownerId, req.principal.userId, created.id, campaignId, created.unitName ?? p.unitId, created.campaignName);
    return { id: created.id };
  }

  @Patch("campaigns/:campaignId/parts/:partId")
  async patchPart(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string,
    @Param("partId") partId: string, @Body() body: unknown,
  ) {
    const pre = await this.preReadPart(tenantId, campaignId, partId);
    const gates = parts.partPatchGates(body);
    const resource = partResource(tenantId, { id: partId, ownerId: pre.part.owner_id ?? undefined, unitAncestors: pre.ancestors });
    // Both kinds of field are checked when both are sent. A body with neither falls through to validation (400).
    if (gates.nonMoney) await authorize(req.principal, resource, "update");
    if (gates.money) await authorize(req.principal, resource, "allocate");
    if (!gates.nonMoney && !gates.money) await authorize(req.principal, resource, "update");

    const out = await mapRules(async () => {
      const p = parts.parsePartPatch(body);
      return withTenants([tenantId], async (c) => {
        const camp = await parts.lockCampaign(c, campaignId);
        if (!camp) throw new parts.PartRuleError(404, "campaign_not_found", "campaign not found");
        const part = await parts.loadPart(c, campaignId, partId, "update");
        if (!part) throw partNotFound();
        // The decision above was made on the owner we read before the lock; if it moved since, that decision is stale.
        if (part.owner_id !== pre.part.owner_id) {
          throw new parts.PartRuleError(409, "part_changed", "this part changed while you were editing it; reload and try again");
        }
        const ownerChanged = p.ownerId !== undefined && p.ownerId !== part.owner_id;
        if (ownerChanged && p.ownerId) await parts.requireActiveOwner(c, tenantId, p.ownerId);
        const finalStatus = p.status ?? part.status;
        const finalBudget = p.budgetMinor !== undefined ? p.budgetMinor : parts.toBig(part.budget_minor);
        if (parts.needsAllocationCheck({
          finalStatus, finalBudget,
          budgetTouched: p.budgetMinor !== undefined,
          leavingCancelled: part.status === "cancelled" && finalStatus !== "cancelled",
        })) {
          const a = await parts.allocationOf(c, campaignId, partId);
          parts.checkAllocation({
            campaignBudget: parts.toBig(camp.budget_minor), campaignCurrency: camp.currency,
            allocatedByOthers: a.allocated, requested: finalBudget as bigint,
          });
        }
        await c.query(
          `UPDATE agency_campaign_parts
              SET status = $2, owner_id = $3, brief = $4, due_on = $5::date, budget_minor = $6::bigint, updated_at = now()
            WHERE id = $1`,
          [
            partId, finalStatus,
            p.ownerId !== undefined ? p.ownerId : part.owner_id,
            p.brief !== undefined ? p.brief : part.brief,
            p.dueOn !== undefined ? p.dueOn : part.due_on,
            finalBudget === null ? null : finalBudget.toString(),
          ],
        );
        await emitEvent(c, tenantId, "agency_campaign_part", partId, "agency.campaign_part.updated", { campaignId, partId });
        let unitName: string | null = null;
        if (ownerChanged && p.ownerId) unitName = (await parts.loadOrgUnits(c, tenantId)).get(part.unit_id)?.name ?? null;
        return { fields: Object.keys(p), newOwner: ownerChanged ? p.ownerId ?? null : null, unitName, unitId: part.unit_id, campaignName: camp.name };
      });
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "agency_campaign_part", partId, { campaignId, fields: out.fields });
    await notifyPartOwner(tenantId, out.newOwner, req.principal.userId, partId, campaignId, out.unitName ?? out.unitId, out.campaignName);
    return { id: partId };
  }

  @Delete("campaigns/:campaignId/parts/:partId")
  async deletePart(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string, @Param("partId") partId: string,
  ) {
    const pre = await this.preReadPart(tenantId, campaignId, partId);
    await authorize(
      req.principal, partResource(tenantId, { id: partId, ownerId: pre.part.owner_id ?? undefined, unitAncestors: pre.ancestors }), "delete",
    );
    await mapRules(() =>
      withTenants(
        [tenantId],
        async (c) => {
          const part = await parts.loadPart(c, campaignId, partId, "update");
          if (!part) throw partNotFound();
          // Both department-campaign tables are consulted under both module scopes, whatever is enabled today.
          const links = (await parts.countChildLinks(c, partId)) + (await parts.countRequestsOnPart(c, partId));
          if (links > 0) {
            throw new parts.PartRuleError(
              409, "part_has_links",
              "this part still has linked department campaigns or requests; cancel it instead, or unlink them first",
              undefined, { links },
            );
          }
          await c.query(`UPDATE agency_campaign_parts SET deleted_at = now(), updated_at = now() WHERE id = $1`, [partId]);
          await emitEvent(c, tenantId, "agency_campaign_part", partId, "agency.campaign_part.deleted", { campaignId, partId });
        },
        { modules: ["search", "social"] },
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "deleted", "agency_campaign_part", partId, { campaignId });
    return { id: partId };
  }

  @Post("campaigns/:campaignId/parts/:partId/links")
  @HttpCode(201)
  async linkPart(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string,
    @Param("partId") partId: string, @Body() body: unknown,
  ) {
    const pre = await this.preReadPart(tenantId, campaignId, partId);
    await authorize(
      req.principal, partResource(tenantId, { id: partId, ownerId: pre.part.owner_id ?? undefined, unitAncestors: pre.ancestors }), "update",
    );
    const { kind, refId } = await mapRules(async () => {
      if (!parts.isPlainObject(body)) throw new parts.PartRuleError(400, "body_invalid", "a JSON object body is required");
      const kind = parts.parseLinkKind(body.kind);
      if (typeof body.refId !== "string" || !isUuidShaped(body.refId)) {
        throw new parts.PartRuleError(400, "link_target_invalid", "refId must be the id of a live campaign of this company", "refId");
      }
      return { kind, refId: body.refId };
    });
    const spec = parts.LINK_TABLE[kind];
    if (!(await isModuleEnabled(tenantId, spec.module))) {
      throw new ConflictException({ message: `the ${spec.module} module is not enabled for this company`, reason: "link_kind_unavailable" });
    }
    await authorize(req.principal, childReadResource(tenantId, kind), "read");

    await mapRules(() =>
      withTenants(
        [tenantId],
        async (c) => {
          // A share lock on the part: a concurrent delete (FOR UPDATE) and this link cannot interleave.
          const part = await parts.loadPart(c, campaignId, partId, "share");
          if (!part) throw partNotFound();
          const child = await c.query<{ agency_part_id: string | null }>(
            `SELECT agency_part_id FROM ${spec.table} WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
            [refId, tenantId],
          );
          if (!child.rows[0]) throw new parts.PartRuleError(400, "link_target_invalid", "no live campaign with that id in this company", "refId");
          if (child.rows[0].agency_part_id) {
            throw new parts.PartRuleError(409, "already_linked", "that campaign is already linked to a part; unlink it first");
          }
          await c.query(`UPDATE ${spec.table} SET agency_part_id = $1, updated_at = now() WHERE id = $2`, [partId, refId]);
          await emitEvent(c, tenantId, "agency_campaign_part", partId, "agency.campaign_part.updated", { campaignId, partId, link: { kind, refId } });
        },
        { modules: [spec.module] },
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "linked", "agency_campaign_part", partId, { campaignId, kind, refId });
    return { id: partId, kind, refId };
  }

  @Delete("campaigns/:campaignId/parts/:partId/links/:kind/:refId")
  async unlinkPart(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("campaignId") campaignId: string,
    @Param("partId") partId: string, @Param("kind") kindParam: string, @Param("refId") refId: string,
  ) {
    const pre = await this.preReadPart(tenantId, campaignId, partId);
    await authorize(
      req.principal, partResource(tenantId, { id: partId, ownerId: pre.part.owner_id ?? undefined, unitAncestors: pre.ancestors }), "update",
    );
    const kind = await mapRules(async () => parts.parseLinkKind(kindParam));
    const spec = parts.LINK_TABLE[kind];
    await mapRules(() =>
      withTenants(
        [tenantId],
        async (c) => {
          const part = await parts.loadPart(c, campaignId, partId, "share");
          if (!part) throw partNotFound();
          const res = isUuidShaped(refId)
            ? await c.query(
                `UPDATE ${spec.table} SET agency_part_id = NULL, updated_at = now()
                  WHERE id = $1 AND agency_part_id = $2 AND tenant_id = $3`,
                [refId, partId, tenantId],
              )
            : { rowCount: 0 };
          if (!res.rowCount) throw new parts.PartRuleError(404, "link_not_found", "that campaign is not linked to this part");
          await emitEvent(c, tenantId, "agency_campaign_part", partId, "agency.campaign_part.updated", { campaignId, partId, unlink: { kind, refId } });
        },
        { modules: [spec.module] },
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "unlinked", "agency_campaign_part", partId, { campaignId, kind, refId });
    return { id: partId, kind, refId };
  }

  /** The part, and its unit's ancestry, as Cerbos must see them: read from the DB BEFORE the decision, never from the body. */
  private preReadPart(tenantId: string, campaignId: string, partId: string) {
    return mapRules(async () => {
      parts.requireUuid(campaignId, "campaign_not_found", "campaign not found");
      parts.requireUuid(partId, "part_not_found", "part not found");
      const pre = await withTenants([tenantId], async (c) => {
        const part = await parts.loadPart(c, campaignId, partId);
        if (!part) return null;
        return { part, ancestors: await parts.partUnitAncestors(c, tenantId, part.unit_id) };
      });
      if (!pre) throw partNotFound();
      return pre;
    });
  }
}

// ───────────────────────────── DW-5a helpers (module scope: the class above stays routes only) ─────────────────────────────

/** Exported for DW-6k (core/figma), which authorises a Figma link on a part with the SAME resource the part's own routes send. */
export const partResource = (tenantId: string, extra: Partial<Resource> = {}): Resource => ({
  kind: "agency_campaign_part", tenantId, module: "agency", ...extra,
});
const partNotFound = () => new parts.PartRuleError(404, "part_not_found", "part not found");
const partExists = () => new parts.PartRuleError(409, "part_exists", "that department already has a part in this campaign");

/** The read gate on the department's own campaign kind (§31.4 links): SEO campaigns are `resource_search_campaign`,
 *  social campaigns are `social_engagement` (what `GET social/campaigns` checks). */
function childReadResource(tenantId: string, kind: parts.LinkKind): Resource {
  return kind === "search_campaign"
    ? { kind: "resource_search_campaign", tenantId, module: "search" }
    : { kind: "social_engagement", tenantId, module: "social" };
}

/** Module on AND caller may read it, for the detail read. A denial here is an expected answer, not a failure. */
async function linkReadAccess(req: FastifyRequest, tenantId: string, kind: parts.LinkKind): Promise<"ok" | "module_off" | "forbidden"> {
  if (!(await isModuleEnabled(tenantId, parts.LINK_TABLE[kind].module))) return "module_off";
  try {
    await authorize(req.principal, childReadResource(tenantId, kind), "read");
    return "ok";
  } catch (e) {
    if (e instanceof ForbiddenException) return "forbidden";
    throw e;
  }
}

/** §31.5: best-effort, never fails the write. */
async function notifyPartOwner(
  tenantId: string, ownerId: string | null, actorId: string | null, partId: string, campaignId: string, unitName: string, campaignName: string,
): Promise<void> {
  if (!ownerId) return;
  try {
    await notify(tenantId, ownerId, actorId, "campaign_part.assigned", {
      title: `${unitName} has a part in ${campaignName}`,
      entityType: "agency_campaign_part", entityId: partId,
      href: `/agency/${campaignId}`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[agency] campaign_part.assigned notification failed (part=${partId}):`, (err as Error)?.message ?? err);
  }
}

/** PartRuleError -> the HTTP exception carrying the contract's machine code in `reason` (and `detail` / `field`). */
function httpFromRule(e: parts.PartRuleError): HttpException {
  const body = { message: e.message, reason: e.reason, ...(e.field ? { field: e.field } : {}), ...(e.detail ? { detail: e.detail } : {}) };
  if (e.httpStatus === 400) return new BadRequestException(body);
  if (e.httpStatus === 404) return new NotFoundException(body);
  return new ConflictException(body);
}
async function mapRules<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof parts.PartRuleError) throw httpFromRule(e);
    throw e;
  }
}
