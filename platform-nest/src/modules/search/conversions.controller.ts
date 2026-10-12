// M5-P2 — ad-platform conversion uploads: the BFF routes (and the MCP tools bound to them, conversions-mcp-tools.ts).
//   GET  /api/:tenantId/modules/search/properties/:propertyId/conversion-targets
//   POST /api/:tenantId/modules/search/properties/:propertyId/conversion-targets          (idempotent upsert)
//   GET  /api/:tenantId/modules/search/properties/:propertyId/conversion-uploads[?leadId=&status=&limit=]
//   GET  /api/:tenantId/modules/search/leads/:leadId/conversion-uploads                   (the pipeline card's "Ad platform uploads")
// Cerbos: the EXISTING `resource_search_property` kind (read for the three reads, update for the config write). No new kind, no
// policy change. Rows are reached through withTenants([tenantId], {modules:['search']}), so another company's property id is 404
// and a principal outside the tenant is 403.
// Impact: setting a target is LOW. It sends nothing by itself: every upload still needs its own WS4 approval, decided by a human
// who holds `update` on the property (automation-approvals.controller.ts). The uploads themselves are not an endpoint at all:
// they are planned by the `agency.lead.stage_changed` handler and executed in-band at decide(). Nothing here returns an identifier.
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, Req, UseGuards, HttpCode, ConflictException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  isPlatform, SUPPORTED_PLATFORMS, type ConversionPlatform, type UploadStatus,
} from "./conversions";
import { isMetaEventName } from "./conversions-meta";
import { isLinkedInConversionRef } from "./conversions-linkedin";
import {
  listConversionTargets, listConversionUploads, upsertConversionTarget,
  type ConversionTargetDto, type ConversionUploadDto, type UpsertTargetInput,
} from "./conversions.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const STAGE_RE = /^[a-z][a-z_]{1,31}$/;
const GOOGLE_ACTION_RE = /^(customers\/\d+\/conversionActions\/\d+|\d{1,20})$/;
/** What `conversionAction` must be, per platform: a Google Ads conversion action, a Meta event name (P3), a LinkedIn conversion rule (P4). */
function conversionActionValid(platform: ConversionPlatform, v: string): boolean {
  switch (platform) {
    case "google_ads": return GOOGLE_ACTION_RE.test(v);
    case "meta_capi": return isMetaEventName(v);
    case "linkedin_capi": return isLinkedInConversionRef(v);
  }
}
const CONVERSION_ACTION_HINT: Record<ConversionPlatform, string> = {
  google_ads: "a Google Ads conversion action id or its customers/{id}/conversionActions/{id} resource name",
  meta_capi: "a Meta event name (letters, digits and underscores, starting with a letter, at most 50), for example Lead",
  linkedin_capi: "a LinkedIn conversion rule id or its urn:lla:llaPartnerConversion:{id} URN",
};
const STATUSES: readonly UploadStatus[] = ["pending_approval", "executing", "simulated", "uploaded", "failed", "rejected", "skipped"];

/** A typed 400: HttpErrorFilter forwards `reason`. */
function refuse(reason: string, message: string): BadRequestException {
  return new BadRequestException({ message, reason });
}

/** Parse the body of POST conversion-targets. Exported for the unit tests. Returns the input or a typed refusal. */
export function parseTargetBody(body: unknown): { ok: true; input: UpsertTargetInput } | { ok: false; reason: string; message: string } {
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const bad = (reason: string, message: string) => ({ ok: false as const, reason, message });
  if (typeof b.webSiteSlug !== "string" || !SLUG_RE.test(b.webSiteSlug)) return bad("web_site_slug_invalid", "webSiteSlug must be a WebDesk site slug (lower-case letters, digits and dashes)");
  if (!isPlatform(b.platform)) return bad("platform_unknown", "platform must be google_ads, meta_capi or linkedin_capi");
  if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(b.platform)) return bad("platform_unsupported", `platform ${b.platform} has no adapter`);
  if (typeof b.stage !== "string" || !STAGE_RE.test(b.stage)) return bad("stage_unknown", "stage must be a pipeline stage key");
  if (typeof b.conversionKey !== "string" || !KEY_RE.test(b.conversionKey)) return bad("conversion_key_invalid", "conversionKey must be lower-case letters, digits and underscores, starting with a letter (max 64)");
  if (typeof b.conversionAction !== "string" || !conversionActionValid(b.platform, b.conversionAction.trim())) {
    return bad("conversion_action_invalid", `conversionAction for ${b.platform} must be ${CONVERSION_ACTION_HINT[b.platform]}`);
  }
  if (b.sendValue !== undefined && typeof b.sendValue !== "boolean") return bad("send_value_invalid", "sendValue must be true or false");
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return bad("enabled_invalid", "enabled must be true or false");
  return {
    ok: true,
    input: {
      webSiteSlug: b.webSiteSlug, platform: b.platform as ConversionPlatform, stage: b.stage, conversionKey: b.conversionKey,
      conversionAction: b.conversionAction.trim(), sendValue: b.sendValue === true, enabled: b.enabled !== false,
    },
  };
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchConversionsController {
  private async gate(req: FastifyRequest, tenantId: string, propertyId: string, action: "read" | "update"): Promise<void> {
    if (!UUID_RE.test(propertyId)) throw new BadRequestException("propertyId must be a valid id");
    await authorize(req.principal, { kind: "resource_search_property", id: propertyId, tenantId, module: "search" }, action);
  }

  @Get("properties/:propertyId/conversion-targets")
  async targets(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
  ): Promise<{ propertyId: string; targets: ConversionTargetDto[] }> {
    await this.gate(req, tenantId, propertyId, "read");
    const targets = await listConversionTargets(tenantId, propertyId);
    if (!targets) throw new NotFoundException("property not found");
    return { propertyId, targets };
  }

  @Post("properties/:propertyId/conversion-targets")
  @HttpCode(200)
  async setTarget(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Body() body: unknown,
  ): Promise<{ target: ConversionTargetDto; created: boolean }> {
    // Authorize BEFORE validating, so a denial never depends on the body.
    await this.gate(req, tenantId, propertyId, "update");
    const parsed = parseTargetBody(body);
    if (!parsed.ok) throw refuse(parsed.reason, parsed.message);
    const out = await upsertConversionTarget(tenantId, propertyId, parsed.input, req.principal.userId ?? null);
    if (out.outcome === "property_not_found") throw new NotFoundException("property not found");
    if (out.outcome === "stage_unknown") throw refuse("stage_unknown", "no such pipeline stage");
    if (out.outcome === "slug_in_use") {
      throw new ConflictException({ message: "this site, platform and stage already map to another property", reason: "target_owned_by_other_property" });
    }
    await writeActivity(tenantId, req.principal.userId ?? null, out.created ? "created" : "updated", "search_conversion_target", out.target.id, {
      propertyId, platform: out.target.platform, stage: out.target.stage, conversionKey: out.target.conversionKey, enabled: out.target.enabled,
    });
    return { target: out.target, created: out.created };
  }

  @Get("properties/:propertyId/conversion-uploads")
  async propertyUploads(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string,
    @Query("leadId") leadId?: string, @Query("status") status?: string, @Query("limit") limit?: string,
  ): Promise<{ propertyId: string; uploads: ConversionUploadDto[] }> {
    await this.gate(req, tenantId, propertyId, "read");
    if (leadId !== undefined && !UUID_RE.test(leadId)) throw new BadRequestException("leadId must be a valid id");
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw new BadRequestException(`status must be one of ${STATUSES.join(", ")}`);
    const uploads = await listConversionUploads(tenantId, {
      propertyId, leadId, status: status as UploadStatus | undefined, limit: limit ? Number(limit) || undefined : undefined,
    });
    return { propertyId, uploads };
  }

  /** The pipeline card's "Ad platform uploads" slot. Tenant-level read on the search property kind: the rows hold ids only. */
  @Get("leads/:leadId/conversion-uploads")
  async leadUploads(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("leadId") leadId: string,
  ): Promise<{ leadId: string; uploads: ConversionUploadDto[] }> {
    await authorize(req.principal, { kind: "resource_search_property", tenantId, module: "search" }, "read");
    if (!UUID_RE.test(leadId)) throw new BadRequestException("leadId must be a valid id");
    return { leadId, uploads: await listConversionUploads(tenantId, { leadId }) };
  }
}
