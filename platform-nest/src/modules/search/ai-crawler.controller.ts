// M5-P5b — the AI-crawler log + SM-16 AI-visibility panels: the BFF routes (MCP tools: ai-crawler-mcp-tools.ts).
//   POST /api/:tenantId/modules/search/properties/:propertyId/ai-crawlers/ingest        body {log}   (update, MEDIUM)
//   GET  .../properties/:propertyId/ai-crawlers/summary[?from=&to=]                      (read)
//   GET  .../properties/:propertyId/ai-crawlers/summary/range/:from/:to                  (read; the MCP hub drops a GET's query)
//   GET  .../properties/:propertyId/ai-visibility-summary                                (read)
// Cerbos: the EXISTING `resource_search_property` kind (read / update): no new kind, no policy change. Rows are
// reached through withTenants([t],{modules:['search']}), so another company's property is 404 and a principal
// outside the tenant is 403. Impact class of the ingest: MEDIUM (it changes a property's recorded history and the
// numbers its panels show, and cannot be taken back row by row), so the hub's D14 gate asks for approval.
//
// The ingest never echoes a line, an IP or a User-Agent, and never logs them: the response is counts only.
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { AnalyticsRangeError, resolveRange } from "./umami-reads";
import {
  MAX_CHUNK_CHARS, ingestAiCrawlerChunk, readCrawlerSummary, readVisibilitySummary,
  type CrawlerSummary, type IngestOutcome, type VisibilitySummary,
} from "./ai-crawler-store";
import { verifierFromEnv } from "./ai-crawler-verify";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchAiCrawlerController {
  private async gate(req: FastifyRequest, tenantId: string, propertyId: string, action: "read" | "update"): Promise<void> {
    if (!UUID_RE.test(propertyId)) throw new BadRequestException("propertyId must be a valid id");
    await authorize(req.principal, { kind: "resource_search_property", id: propertyId, tenantId, module: "search" }, action);
  }

  @Post("properties/:propertyId/ai-crawlers/ingest")
  @HttpCode(200)
  async ingest(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Body() body: { log?: unknown },
  ): Promise<IngestOutcome> {
    await this.gate(req, tenantId, propertyId, "update");
    const log = body?.log;
    if (typeof log !== "string" || log.trim() === "") throw new BadRequestException("log must be a non-empty string of access-log lines");
    if (log.length > MAX_CHUNK_CHARS) throw new BadRequestException(`log is limited to ${MAX_CHUNK_CHARS} characters per call; send the file in parts`);
    const out = await ingestAiCrawlerChunk({
      tenantId, propertyId, chunk: log, userId: req.principal.userId ?? null, verifier: verifierFromEnv(),
    });
    if (out === "no_property") throw new NotFoundException("property not found");
    await writeActivity(tenantId, req.principal.userId ?? null, "ai_crawler_ingest", "search_property", propertyId, {
      chunk: out.chunk, rows: out.rows, verification: out.verification, ...(out.stats ?? {}),
    });
    return out;
  }

  @Get("properties/:propertyId/ai-crawlers/summary")
  async summary(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Query("from") from?: string, @Query("to") to?: string,
  ): Promise<CrawlerSummary> {
    return this.run(req, tenantId, propertyId, from, to);
  }

  @Get("properties/:propertyId/ai-crawlers/summary/range/:from/:to")
  async summaryRange(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Param("from") from: string, @Param("to") to: string,
  ): Promise<CrawlerSummary> {
    return this.run(req, tenantId, propertyId, from, to);
  }

  private async run(req: FastifyRequest, tenantId: string, propertyId: string, from?: string, to?: string): Promise<CrawlerSummary> {
    await this.gate(req, tenantId, propertyId, "read");
    let r;
    try { r = resolveRange(from, to); } catch (e) {
      if (e instanceof AnalyticsRangeError) throw new BadRequestException(e.message);
      throw e;
    }
    const out = await readCrawlerSummary(tenantId, propertyId, { from: r.from, to: r.to });
    if (out === "no_property") throw new NotFoundException("property not found");
    return out;
  }

  @Get("properties/:propertyId/ai-visibility-summary")
  async visibility(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
  ): Promise<VisibilitySummary> {
    await this.gate(req, tenantId, propertyId, "read");
    const out = await readVisibilitySummary(tenantId, propertyId);
    if (out === "no_property") throw new NotFoundException("property not found");
    return out;
  }
}
