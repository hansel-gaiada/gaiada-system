// M5-V4 — content-decay findings: the BFF routes (and the MCP tools bound to them, content-decay-mcp-tools.ts).
//   GET  /api/:tenantId/modules/search/properties/:propertyId/decay[?status=live|open|acknowledged|resolved|refresh_brief_filed|all]
//   POST /api/:tenantId/modules/search/properties/:propertyId/decay/:findingId/acknowledge
//   POST /api/:tenantId/modules/search/properties/:propertyId/decay/:findingId/refresh-brief
// Cerbos: the EXISTING `resource_search_property` kind — read for the list, update for both writes (no new kind,
// no policy change). Rows are reached through withTenants([tenantId], {modules:['search']}) so another company's
// property or finding id is invisible (404) and a principal outside the tenant is refused at authorize (403).
// Impact class: acknowledge LOW, file-a-refresh-brief LOW (a draft row the human edits; nothing is published).
//
// A separate controller class on SearchController's prefix (same reason as search-analytics.controller.ts).
//
// The refresh brief is a plain `search_content_briefs` row (status 'draft', drafted_via 'fallback': a fixed
// template built from the finding, no AI call, so it works with the gateway down). It does not touch the
// WebDesk draft-link columns that M5-W4 adds.
//
// View counts under 5 leave this file as "<5" (visitor addendum R-V6).
import {
  BadRequestException, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { SMALL_CELL, DECAY_WINDOW_DAYS, type DecayReason } from "./content-decay";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DECAY_STATUSES = ["open", "acknowledged", "resolved", "refresh_brief_filed"] as const;
const LIVE_STATUSES = ["open", "acknowledged", "refresh_brief_filed"];
const LIST_LIMIT = 200;

interface FindingRow {
  id: string; page_path: string; window_from: string; window_to: string; window_days: number; status: string;
  reason: string; reasons: DecayReason[]; brief_id: string | null; detected_at: Date; acknowledged_at: Date | null; resolved_at: Date | null;
}

export interface DecayFindingDto {
  id: string;
  pagePath: string;
  status: string;
  reason: string;
  reasons: Array<{ metric: string; basis: string; recent: number | "<5"; baseline: number; drop: number | null; dropPct: number | null }>;
  window: { from: string; to: string; days: number };
  briefId: string | null;
  detectedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

const day = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export function toDto(r: FindingRow): DecayFindingDto {
  return {
    id: r.id,
    pagePath: r.page_path,
    status: r.status,
    reason: r.reason,
    reasons: (Array.isArray(r.reasons) ? r.reasons : []).map((x) => {
      const small = x.metric === "views" && x.recent < SMALL_CELL;
      return {
        metric: x.metric, basis: x.basis,
        recent: small ? ("<5" as const) : x.recent,
        baseline: x.baseline,
        drop: small ? null : x.drop,
        dropPct: small ? null : x.dropPct,
      };
    }),
    window: { from: day(r.window_from), to: day(r.window_to), days: r.window_days },
    briefId: r.brief_id,
    detectedAt: new Date(r.detected_at).toISOString(),
    acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at).toISOString() : null,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
  };
}

const COLS = `id, page_path, window_from, window_to, window_days, status, reason, reasons, brief_id,
              detected_at, acknowledged_at, resolved_at`;

/** The deterministic refresh brief for a finding (no AI, no network). Exported for the tests. */
export function buildRefreshBrief(pagePath: string, reason: string): { topic: string; outline: string[]; body: string } {
  const outline = ["Why this page lost traffic", "Re-check search intent and the queries it should win", "Update facts, dates and examples", "Improve title, description and internal links", "Re-publish and watch the next 28 days"];
  const body = [
    `Refresh brief for ${pagePath}`,
    "",
    "Why this page was flagged",
    reason,
    "",
    "Suggested steps",
    ...outline.slice(1).map((s, i) => `${i + 1}. ${s}.`),
  ].join("\n");
  return { topic: `Refresh: ${pagePath}`, outline, body };
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchContentDecayController {
  private async gate(req: FastifyRequest, tenantId: string, propertyId: string, action: "read" | "update"): Promise<void> {
    if (!UUID_RE.test(propertyId)) throw new BadRequestException("propertyId must be a valid id");
    await authorize(req.principal, { kind: "resource_search_property", id: propertyId, tenantId, module: "search" }, action);
  }

  @Get("properties/:propertyId/decay")
  async list(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Query("status") status?: string,
  ): Promise<{ propertyId: string; findings: DecayFindingDto[] }> {
    await this.gate(req, tenantId, propertyId, "read");
    const want = status ?? "live";
    if (want !== "live" && want !== "all" && !(DECAY_STATUSES as readonly string[]).includes(want)) {
      throw new BadRequestException("status must be live, all, open, acknowledged, resolved or refresh_brief_filed");
    }
    const rows = await withTenants([tenantId], async (c) => {
      const prop = await c.query(`SELECT 1 FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [propertyId]);
      if (!prop.rows[0]) throw new NotFoundException("property not found");
      const where = want === "all" ? "" : want === "live" ? "AND status = ANY($2)" : "AND status = $2";
      const params: unknown[] = [propertyId];
      if (want === "live") params.push(LIVE_STATUSES);
      else if (want !== "all") params.push(want);
      return c.query<FindingRow>(
        `SELECT ${COLS} FROM search_decay_findings WHERE property_id = $1 ${where}
          ORDER BY detected_at DESC, id LIMIT ${LIST_LIMIT}`,
        params,
      );
    }, { modules: ["search"] });
    return { propertyId, findings: rows.rows.map(toDto) };
  }

  @Post("properties/:propertyId/decay/:findingId/acknowledge")
  async acknowledge(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Param("findingId") findingId: string,
  ): Promise<DecayFindingDto> {
    await this.gate(req, tenantId, propertyId, "update");
    if (!UUID_RE.test(findingId)) throw new BadRequestException("findingId must be a valid id");
    const userId = req.principal.userId ?? null;
    const row = await withTenants([tenantId], async (c) => {
      const cur = await c.query<FindingRow>(
        `SELECT ${COLS} FROM search_decay_findings WHERE id = $1 AND property_id = $2 FOR UPDATE`, [findingId, propertyId],
      );
      const f = cur.rows[0];
      if (!f) throw new NotFoundException("finding not found");
      if (f.status === "acknowledged") return { f, changed: false };
      if (f.status !== "open") throw new ConflictException(`a ${f.status} finding cannot be acknowledged`);
      const upd = await c.query<FindingRow>(
        `UPDATE search_decay_findings SET status = 'acknowledged', acknowledged_by = $3, acknowledged_at = now(), updated_at = now()
          WHERE id = $1 AND property_id = $2 RETURNING ${COLS}`,
        [findingId, propertyId, userId],
      );
      return { f: upd.rows[0]!, changed: true };
    }, { modules: ["search"] });
    if (row.changed) await writeActivity(tenantId, userId, "decay_acknowledged", "search_decay_finding", findingId, { propertyId });
    return toDto(row.f);
  }

  @Post("properties/:propertyId/decay/:findingId/refresh-brief")
  async fileRefreshBrief(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Param("findingId") findingId: string,
  ): Promise<{ finding: DecayFindingDto; briefId: string; created: boolean }> {
    await this.gate(req, tenantId, propertyId, "update");
    if (!UUID_RE.test(findingId)) throw new BadRequestException("findingId must be a valid id");
    const userId = req.principal.userId ?? null;
    const out = await withTenants([tenantId], async (c) => {
      const cur = await c.query<FindingRow>(
        `SELECT ${COLS} FROM search_decay_findings WHERE id = $1 AND property_id = $2 FOR UPDATE`, [findingId, propertyId],
      );
      const f = cur.rows[0];
      if (!f) throw new NotFoundException("finding not found");
      if (f.status === "refresh_brief_filed" && f.brief_id) return { f, briefId: f.brief_id, created: false };
      if (f.status === "resolved") throw new ConflictException("a resolved finding cannot file a refresh brief");
      const b = buildRefreshBrief(f.page_path, f.reason);
      const briefId = newId();
      const grounding = {
        source: "content_decay", findingId: f.id, pagePath: f.page_path,
        window: { from: day(f.window_from), to: day(f.window_to), days: f.window_days || DECAY_WINDOW_DAYS },
        reasons: toDto(f).reasons,
      };
      await c.query(
        `INSERT INTO search_content_briefs
           (id, tenant_id, property_id, topic, status, outline, body, geo_notes, grounding, model, drafted_via, created_by, origin_site)
         VALUES ($1,$2,$3,$4,'draft',$5,$6,NULL,$7,NULL,'fallback',$8,$9)`,
        [briefId, tenantId, propertyId, b.topic, JSON.stringify(b.outline), b.body, JSON.stringify(grounding), userId, config.originSite],
      );
      const upd = await c.query<FindingRow>(
        `UPDATE search_decay_findings SET status = 'refresh_brief_filed', brief_id = $3, updated_at = now()
          WHERE id = $1 AND property_id = $2 RETURNING ${COLS}`,
        [findingId, propertyId, briefId],
      );
      return { f: upd.rows[0]!, briefId, created: true };
    }, { modules: ["search"] });
    if (out.created) {
      await writeActivity(tenantId, userId, "refresh_brief_filed", "search_content_brief", out.briefId, { propertyId, findingId });
    }
    return { finding: toDto(out.f), briefId: out.briefId, created: out.created };
  }
}
