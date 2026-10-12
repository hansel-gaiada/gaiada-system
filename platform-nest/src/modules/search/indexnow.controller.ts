// M5-P5a — the BFF routes (and the MCP tools bound to them, indexnow-mcp-tools.ts) for IndexNow and the Bing
// Webmaster connector. All under /api/:tenantId/modules/search/properties/:propertyId:
//   GET    indexnow                 status: switch, key proof, last 7 days of submissions, the 20 most recent
//   GET    indexnow/key             the key file the site build must serve (the key is public by protocol)
//   POST   indexnow/key             generate the key (idempotent) or {rotate:true}; 201 when created
//   PATCH  indexnow                 {enabled}: enabling FETCHES the key file back from the site first
//   POST   indexnow/submit          {urls:[...]}: submit URLs of THIS property's site now (rate limited)
//   POST   indexnow/notify          {transition, ref?, items:[...]}: report a publish/unpublish (the route twin of
//                                   the in-process hook); the URLs come from each item's route pattern. With no `ref`
//                                   the UTC hour names the event (retries within the hour dedupe)
//   GET    bing                     connection status, mode, last pull, row counts
//   POST   bing                     {apiKey}: connect (the key is sealed in the vault, never returned)
//   DELETE bing                     disconnect (revokes the vault row when no other property uses it)
//   POST   bing/pull                {days?}: pull query + page stats (simulate by default)
//   GET    bing/performance         stored stats (?kind=query|page&from&to&limit)
//   GET    bing/performance/:kind/:from/:to   the same, all in the path (the MCP hub passes only path params on a GET);
//                                   :kind is query, page or all
//
// Cerbos: the EXISTING `resource_search_property` kind: `read` for the GETs, `update` for every write (no new
// kind, no policy change). AUTHORIZATION RUNS FIRST, before the body is looked at, so a denied caller never learns
// whether a body was valid (validation cannot pre-empt authz). The rows are reached through
// withTenants([tenantId], .., {modules:['search']}): another company's property id is a 404, a principal outside
// the tenant a 403.
//
// Impact classes: every write is LOW except `POST bing` (MEDIUM: it puts a credential in the vault). Typed 409
// refusals carry `{message, reason}` (indexnow_platform_disabled, property_not_verified, indexnow_key_missing,
// indexnow_key_file_unreachable, no_submission_channel, bing_not_connected, ...). The manual submit is 429 beyond
// 300 URLs per property per hour, 400 beyond 100 per call. Nothing here returns or logs the Bing key; the
// activity rows carry ids and counts only.
//
// A separate controller class on SearchController's prefix (same reason as content-decay.controller.ts).
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import type { ChangedItem } from "./indexnow";
import {
  generateKey, getStatus, notifyContentChange, readKey, setIndexNowEnabled, submitUrlsManually,
} from "./indexnow-service";
import { bingStatus, connectBing, disconnectBing, listBingPerformance, pullBing } from "./bing-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NOTIFY_MAX_ITEMS = 200;

function strict(raw: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  const o = raw === undefined || raw === null ? {} : raw;
  if (typeof o !== "object" || Array.isArray(o)) throw new BadRequestException("the request body must be a JSON object");
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new BadRequestException(`unknown body key "${k}" (allowed: ${allowed.join(", ") || "none"})`);
  for (const k of required) if ((o as Record<string, unknown>)[k] === undefined) throw new BadRequestException(`${k} is required`);
  return o as Record<string, unknown>;
}

/** The notify body's items, validated field by field. Exported for the tests. */
export function parseNotifyItems(raw: unknown): ChangedItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > NOTIFY_MAX_ITEMS) throw new BadRequestException(`items must be an array of 1..${NOTIFY_MAX_ITEMS} entries`);
  return raw.map((it, i) => {
    const o = strict(it, ["slug", "locale", "defaultLocale", "routePattern", "localized", "version"], ["slug", "locale", "defaultLocale"]);
    const str = (k: string, max: number) => {
      const v = o[k];
      if (typeof v !== "string" || v === "" || v.length > max) throw new BadRequestException(`items[${i}].${k} must be a non-empty string of at most ${max} characters`);
      return v;
    };
    if (o.routePattern !== undefined && o.routePattern !== null && (typeof o.routePattern !== "string" || o.routePattern.length > 200)) throw new BadRequestException(`items[${i}].routePattern must be a string of at most 200 characters`);
    if (o.localized !== undefined && typeof o.localized !== "boolean") throw new BadRequestException(`items[${i}].localized must be a boolean`);
    if (o.version !== undefined && o.version !== null && (typeof o.version !== "number" || !Number.isInteger(o.version) || o.version < 1)) throw new BadRequestException(`items[${i}].version must be a positive integer`);
    return {
      slug: str("slug", 200), locale: str("locale", 35), defaultLocale: str("defaultLocale", 35), routePattern: o.routePattern ?? undefined,
      ...(o.localized !== undefined ? { localized: o.localized as boolean } : {}), version: (o.version as number | null | undefined) ?? null,
    };
  });
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchIndexNowController {
  private async gate(req: FastifyRequest, tenantId: string, propertyId: string, action: "read" | "update"): Promise<void> {
    if (!UUID_RE.test(propertyId)) throw new BadRequestException("propertyId must be a valid id");
    await authorize(req.principal, { kind: "resource_search_property", id: propertyId, tenantId, module: "search" }, action);
  }

  // ── IndexNow ───────────────────────────────────────────────────────────────────────────────────

  @Get("properties/:propertyId/indexnow")
  async status(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string) {
    await this.gate(req, tenantId, propertyId, "read");
    return getStatus(tenantId, propertyId);
  }

  @Get("properties/:propertyId/indexnow/key")
  async key(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string) {
    await this.gate(req, tenantId, propertyId, "read");
    return readKey(tenantId, propertyId);
  }

  @Post("properties/:propertyId/indexnow/key")
  @HttpCode(200)
  async generate(
    @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("tenantId") tenantId: string,
    @Param("propertyId") propertyId: string, @Body() body: unknown,
  ) {
    await this.gate(req, tenantId, propertyId, "update");
    const b = strict(body, ["rotate"]);
    if (b.rotate !== undefined && typeof b.rotate !== "boolean") throw new BadRequestException("rotate must be a boolean");
    const r = await generateKey(tenantId, propertyId, { rotate: b.rotate === true });
    if (r.created) reply.status(201);
    if (r.created || r.rotated) await writeActivity(tenantId, req.principal.userId ?? null, r.rotated ? "indexnow_key_rotated" : "indexnow_key_generated", "search_property", propertyId, {});
    return { created: r.created, rotated: r.rotated, ...r.info };
  }

  @Patch("properties/:propertyId/indexnow")
  @HttpCode(200)
  async setEnabled(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Body() body: unknown) {
    await this.gate(req, tenantId, propertyId, "update");
    const b = strict(body, ["enabled"], ["enabled"]);
    if (typeof b.enabled !== "boolean") throw new BadRequestException("enabled must be a boolean");
    const r = await setIndexNowEnabled(tenantId, propertyId, b.enabled);
    await writeActivity(tenantId, req.principal.userId ?? null, b.enabled ? "indexnow_enabled" : "indexnow_disabled", "search_property", propertyId, {});
    return { propertyId, ...r };
  }

  @Post("properties/:propertyId/indexnow/submit")
  @HttpCode(200)
  async submit(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Body() body: unknown) {
    await this.gate(req, tenantId, propertyId, "update");
    const b = strict(body, ["urls"], ["urls"]);
    const r = await submitUrlsManually(tenantId, propertyId, b.urls, req.principal.userId ?? null);
    await writeActivity(tenantId, req.principal.userId ?? null, "indexnow_manual_submit", "search_property", propertyId, { engine: r.engine, accepted: r.accepted, duplicates: r.duplicates });
    return r;
  }

  @Post("properties/:propertyId/indexnow/notify")
  @HttpCode(200)
  async notify(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Body() body: unknown) {
    await this.gate(req, tenantId, propertyId, "update");
    const b = strict(body, ["transition", "ref", "items"], ["transition", "items"]);
    if (b.transition !== "publish" && b.transition !== "unpublish") throw new BadRequestException("transition must be publish or unpublish");
    if (b.ref !== undefined && b.ref !== null && (typeof b.ref !== "string" || b.ref.length > 80)) throw new BadRequestException("ref must be a string of at most 80 characters");
    const items = parseNotifyItems(b.items);
    // No ref: the UTC hour is the event's name, so a retried call within the hour is a duplicate, and a later one is a new fact.
    const ref = (b.ref as string | null | undefined) ?? `t${new Date().toISOString().slice(0, 13)}`;
    const r = await notifyContentChange(tenantId, { propertyId, transition: b.transition, ref, items });
    await writeActivity(tenantId, req.principal.userId ?? null, "indexnow_notify", "search_property", propertyId, { transition: b.transition, status: r.status, urls: r.urls, skipped: r.skipped.length });
    return r;
  }

  // ── Bing Webmaster ─────────────────────────────────────────────────────────────────────────────

  @Get("properties/:propertyId/bing")
  async bing(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string) {
    await this.gate(req, tenantId, propertyId, "read");
    return bingStatus(tenantId, propertyId);
  }

  @Post("properties/:propertyId/bing")
  @HttpCode(200)
  async connect(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Body() body: unknown) {
    await this.gate(req, tenantId, propertyId, "update");
    const b = strict(body, ["apiKey"], ["apiKey"]);
    const r = await connectBing(tenantId, propertyId, b.apiKey, req.principal.userId ?? null);
    await writeActivity(tenantId, req.principal.userId ?? null, "bing_connected", "search_property", propertyId, { connectionId: r.connectionId, mode: r.mode });
    return { propertyId, ...r };
  }

  @Delete("properties/:propertyId/bing")
  @HttpCode(200)
  async disconnect(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string) {
    await this.gate(req, tenantId, propertyId, "update");
    const r = await disconnectBing(tenantId, propertyId);
    if (r.disconnected) await writeActivity(tenantId, req.principal.userId ?? null, "bing_disconnected", "search_property", propertyId, { revoked: r.revoked });
    return { propertyId, ...r };
  }

  @Post("properties/:propertyId/bing/pull")
  @HttpCode(200)
  async pull(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Body() body: unknown) {
    await this.gate(req, tenantId, propertyId, "update");
    const b = strict(body, ["days"]);
    const r = await pullBing(tenantId, propertyId, b.days);
    await writeActivity(tenantId, req.principal.userId ?? null, "bing_pull", "search_property", propertyId, { mode: r.mode, fetched: r.fetched, written: r.written });
    return r;
  }

  @Get("properties/:propertyId/bing/performance")
  async performance(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Query("kind") kind?: string, @Query("from") from?: string, @Query("to") to?: string, @Query("limit") limit?: string,
  ) {
    await this.gate(req, tenantId, propertyId, "read");
    let n: number | undefined;
    if (limit !== undefined) {
      n = Number(limit);
      if (!/^\d+$/.test(limit) || !Number.isInteger(n) || n < 1 || n > 500) throw new BadRequestException("limit must be an integer from 1 to 500");
    }
    return listBingPerformance(tenantId, propertyId, { kind, from, to, limit: n });
  }

  @Get("properties/:propertyId/bing/performance/:kind/:from/:to")
  async performanceRange(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Param("kind") kind: string, @Param("from") from: string, @Param("to") to: string,
  ) {
    await this.gate(req, tenantId, propertyId, "read");
    return listBingPerformance(tenantId, propertyId, { kind: kind === "all" ? undefined : kind, from, to });
  }
}
