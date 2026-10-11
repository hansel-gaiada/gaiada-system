// WSK-46 (owner ruling WSK-D52) — the draft-preview token routes, Zone B control plane:
//
//   POST   /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/preview-token                content.previewToken
//   DELETE /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/preview-tokens/:tokenId      content.previewTokenRevoke
//
// Both are MEDIUM / webdesk:operate editorial commands, gated exactly like the content writes (WSK-41):
// ControlAuthGuard (L1 mTLS + L2 token) -> CommandAuthorizationGuard (L3 scope) -> EditorialAssertionGuard
// (L2e) -> the handler, which validates (shape here, state in the service). Guards run before the handler,
// so a refused caller is refused whatever its body; validation can never pre-empt authorisation.
//
// The mint answers { tokenId, token, expiresAt, version, previewPath } with 201. The token is the only
// copy: see preview-token-commands.service.ts. The public route that honours it is
// GET /v1/t/:tenantSlug/preview/:token (delivery/router.ts), served on the public /v1 path; THESE routes are
// not reachable through the public proxy (/control/* is served only on the internal mTLS vhost, WSK-63a).
import { Body, Controller, Delete, Headers, HttpCode, Param, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { EditorialAssertionGuard } from "../auth/editorial-assertion.guard";
import { requireEditorialPrincipal, type EditorialRequest } from "../auth/editorial-principal";
import { Command } from "../command.decorator";
import { PREVIEW_TTL_DEFAULT_SECONDS, PREVIEW_TTL_MAX_SECONDS } from "../../delivery/preview-token";
import { ControlProblemFilter, problems } from "./content-problem";
import { isPlainObject } from "./content-projection";
import { PreviewTokenCommandsService, type PreviewCommandContext } from "./preview-token-commands.service";

/** The command hash merges route params and body; a body carrying one of these would make it ambiguous (design §3.2). */
const RESERVED_BODY_KEYS = ["tenantSlug", "siteId", "itemId", "tokenId"] as const;
const BODY_KEYS = ["version", "ttlSeconds"] as const;

interface MintBody {
  /** The version to pin; undefined = the head. */
  version?: number;
  /** As the caller sent it (null = omitted): what the idempotency request hash covers. */
  requestedVersion: number | null;
  /** The effective lifetime: 1..PREVIEW_TTL_MAX_SECONDS. */
  ttlSeconds: number;
  requestedTtl: number | null;
}

function mintBody(raw: unknown): MintBody {
  // An absent body is the same as {} (both fields are optional).
  const b: unknown = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(b)) throw problems.invalidRequest("the request body must be a JSON object");
  for (const k of RESERVED_BODY_KEYS) {
    if (k in b) throw problems.invalidRequest(`the body may not contain "${k}": it is a route parameter`);
  }
  for (const k of Object.keys(b)) {
    if (!(BODY_KEYS as readonly string[]).includes(k)) throw problems.invalidRequest(`unknown body key "${k}" (allowed: ${BODY_KEYS.join(", ")})`);
  }

  let version: number | undefined;
  if (b.version !== undefined && b.version !== null) {
    if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1 || b.version > 2_147_483_647) {
      throw problems.invalidRequest("version must be an integer >= 1 (omit it for the item's head version)");
    }
    version = b.version;
  }

  // ttlSeconds: omitted, null, "" or 0 mean the default (one hour); anything above the cap is capped
  // (one day); a negative, fractional or non-numeric value is refused rather than guessed at.
  const t = b.ttlSeconds;
  let ttlSeconds = PREVIEW_TTL_DEFAULT_SECONDS;
  let requestedTtl: number | null = null;
  if (t !== undefined && t !== null && t !== "" && t !== 0) {
    if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) {
      throw problems.invalidRequest(
        `ttlSeconds must be a positive integer number of seconds (default ${PREVIEW_TTL_DEFAULT_SECONDS}, max ${PREVIEW_TTL_MAX_SECONDS})`,
      );
    }
    requestedTtl = t;
    ttlSeconds = Math.min(t, PREVIEW_TTL_MAX_SECONDS);
  }
  return { version, requestedVersion: version ?? null, ttlSeconds, requestedTtl };
}

function idempotencyKey(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 200) {
    throw problems.invalidRequest("the Idempotency-Key header is required (8..200 chars) on every content write");
  }
  return raw;
}

@Controller("control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard, EditorialAssertionGuard)
@UseFilters(ControlProblemFilter)
export class PreviewTokenCommandsController {
  constructor(private readonly previews: PreviewTokenCommandsService) {}

  private async context(req: EditorialRequest, tenantSlug: string, siteId: string, idempotencyKeyRaw: string | undefined): Promise<PreviewCommandContext> {
    const principal = requireEditorialPrincipal(req);
    const key = idempotencyKey(idempotencyKeyRaw);
    const { tenant } = await this.previews.resolveTenantSite(tenantSlug, siteId);
    return { tenant, siteId, principal, idempotencyKey: key };
  }

  @Post("preview-token")
  @Command("content.previewToken")
  async mint(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("itemId") itemId: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const b = mintBody(raw);
    const ctx = await this.context(req, tenantSlug, siteId, idem);
    return this.previews.mint(ctx, itemId, { version: b.version, ttlSeconds: b.ttlSeconds }, { version: b.requestedVersion, ttlSeconds: b.requestedTtl });
  }

  @Delete("preview-tokens/:tokenId")
  @HttpCode(200)
  @Command("content.previewTokenRevoke")
  async revoke(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("itemId") itemId: string,
    @Param("tokenId") tokenId: string,
    @Headers("idempotency-key") idem: string | undefined,
  ) {
    const ctx = await this.context(req, tenantSlug, siteId, idem);
    return this.previews.revoke(ctx, itemId, tokenId);
  }
}
