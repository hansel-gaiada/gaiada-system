// WSK-43a — the media library's write routes, Zone B control plane:
//
//   POST   /control/v1/tenants/:tenantSlug/sites/:siteId/media/upload-token    media.uploadToken
//   PATCH  /control/v1/tenants/:tenantSlug/sites/:siteId/media/:assetId        media.update
//   DELETE /control/v1/tenants/:tenantSlug/sites/:siteId/media/:assetId        media.delete
//
// All three are MEDIUM / webdesk:operate editorial commands, gated exactly like the content writes (WSK-41):
// ControlAuthGuard (L1 mTLS + L2 token) -> CommandAuthorizationGuard (L3 scope) -> EditorialAssertionGuard
// (L2e) -> the handler, which validates (shape here, state in the service). Guards run before the handler,
// so a refused caller is refused whatever its body; validation can never pre-empt authorisation.
//
// The mint answers 201 { tokenId, token, uploadPath, expiresAt, bucket, maxBytes, allowedMimes }. The token is
// the only copy: see media-commands.service.ts. The public route that honours it is
// POST /v1/t/:tenantSlug/media/upload/:token (media/media.controller.ts); THESE routes are not reachable
// through the public proxy (/control/* is served only on the internal mTLS vhost, WSK-63a).
import { Body, Controller, Delete, Headers, HttpCode, Param, Patch, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { EditorialAssertionGuard } from "../auth/editorial-assertion.guard";
import { requireEditorialPrincipal, type EditorialRequest } from "../auth/editorial-principal";
import { Command } from "../command.decorator";
import { ControlProblemFilter, problems } from "./content-problem";
import { isPlainObject } from "./content-projection";
import {
  MAX_ALT_CHARS,
  MAX_TITLE_CHARS,
  MediaCommandsService,
  normaliseTags,
  type MediaCommandContext,
  type UpdateMediaInput,
} from "./media-commands.service";

/** The command hash merges route params and body; a body carrying one of these would make it ambiguous (design §3.2). */
const RESERVED_BODY_KEYS = ["tenantSlug", "siteId", "assetId"] as const;
const MINT_KEYS = ["bucket", "maxBytes", "mime"] as const;
const UPDATE_KEYS = ["title", "alt", "tags"] as const;

function body(raw: unknown, allowed: readonly string[], optional: boolean): Record<string, unknown> {
  const b: unknown = optional && (raw === undefined || raw === null) ? {} : raw;
  if (!isPlainObject(b)) throw problems.invalidRequest("the request body must be a JSON object");
  for (const k of RESERVED_BODY_KEYS) {
    if (k in b) throw problems.invalidRequest(`the body may not contain "${k}": it is a route parameter`);
  }
  for (const k of Object.keys(b)) {
    if (!allowed.includes(k)) throw problems.invalidRequest(`unknown body key "${k}" (allowed: ${allowed.join(", ")})`);
  }
  return b;
}

function updateInput(raw: unknown): UpdateMediaInput {
  const b = body(raw, UPDATE_KEYS, false);
  const out: UpdateMediaInput = {};
  if ("title" in b) {
    const t = b.title;
    if (t === null) out.title = null;
    else if (typeof t === "string") {
      const trimmed = t.trim();
      if (Array.from(trimmed).length > MAX_TITLE_CHARS) throw problems.invalidRequest(`title may be at most ${MAX_TITLE_CHARS} characters`);
      out.title = trimmed === "" ? null : trimmed; // "" clears, like null
    } else throw problems.invalidRequest("title must be a string, or null to clear it");
  }
  if ("alt" in b) {
    if (!isPlainObject(b.alt)) throw problems.invalidRequest("alt must be an object of locale -> text (the complete map; {} clears it)");
    const alt: Record<string, string> = {};
    for (const [locale, text] of Object.entries(b.alt)) {
      if (typeof text !== "string") throw problems.invalidRequest(`alt.${locale} must be a string`);
      const trimmed = text.trim();
      if (Array.from(trimmed).length > MAX_ALT_CHARS) throw problems.invalidRequest(`alt.${locale} may be at most ${MAX_ALT_CHARS} characters`);
      if (trimmed !== "") alt[locale] = trimmed; // an empty text is no text: the key is dropped
    }
    out.alt = alt;
  }
  if ("tags" in b) {
    if (!Array.isArray(b.tags)) throw problems.invalidRequest("tags must be an array of strings (the complete list; [] clears it)");
    out.tags = normaliseTags(b.tags);
  }
  if (Object.keys(out).length === 0) throw problems.invalidRequest(`the body must carry at least one of: ${UPDATE_KEYS.join(", ")}`);
  return out;
}

function idempotencyKey(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 200) {
    throw problems.invalidRequest("the Idempotency-Key header is required (8..200 chars) on every media write");
  }
  return raw;
}

@Controller("control/v1/tenants/:tenantSlug/sites/:siteId/media")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard, EditorialAssertionGuard)
@UseFilters(ControlProblemFilter)
export class MediaCommandsController {
  constructor(private readonly media: MediaCommandsService) {}

  private async context(req: EditorialRequest, tenantSlug: string, siteId: string, idempotencyKeyRaw: string | undefined): Promise<MediaCommandContext> {
    const principal = requireEditorialPrincipal(req);
    const key = idempotencyKey(idempotencyKeyRaw);
    const { tenant } = await this.media.resolveTenantSite(tenantSlug, siteId);
    return { tenant, siteId, principal, idempotencyKey: key };
  }

  @Post("upload-token")
  @Command("media.uploadToken")
  async mint(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const b = body(raw, MINT_KEYS, false);
    const { input, requested } = this.media.resolveMintInput({ bucket: b.bucket, maxBytes: b.maxBytes, mime: b.mime });
    const ctx = await this.context(req, tenantSlug, siteId, idem);
    return this.media.mintUploadToken(ctx, input, requested);
  }

  @Patch(":assetId")
  @HttpCode(200)
  @Command("media.update")
  async update(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("assetId") assetId: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const input = updateInput(raw);
    const ctx = await this.context(req, tenantSlug, siteId, idem);
    return this.media.update(ctx, assetId, input);
  }

  @Delete(":assetId")
  @HttpCode(200)
  @Command("media.delete")
  async remove(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("assetId") assetId: string,
    @Headers("idempotency-key") idem: string | undefined,
  ) {
    const ctx = await this.context(req, tenantSlug, siteId, idem);
    return this.media.delete(ctx, assetId);
  }
}
