// WSK-07 — the media route surface. Four concerns kept in four route shapes:
//   - upload:    authenticated, write-scoped (reuses WSK-05's ApiKeyAuthGuard/ScopeGuard)
//   - token upload (WSK-43a): PUBLIC, the single-use upload token in the path is the credential
//                (POST|OPTIONS upload/:token; media-upload.service.ts is the whole security story)
//   - serving:   PUBLIC, cookieless, media/video buckets ONLY, long Cache-Control + cache tags
//   - presigned: authenticated, read-scoped, uploads (PRIVATE) bucket ONLY
//   - transform: PUBLIC, imgproxy-signed redirect, media/video buckets ONLY
import { BadRequestException, Body, Controller, Get, Headers, HttpCode, NotFoundException, Options, Param, Post, Query, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { MediaService } from "./media.service";
import { MediaUploadService, cleanOriginalFilename } from "./media-upload.service";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { ImgproxyService } from "./imgproxy.service";
import { ApiKeyAuthGuard } from "../auth/api-key-auth.guard";
import { ScopeGuard } from "../auth/scope.guard";
import { RequireScope } from "../auth/scope.decorator";
import { PublicTenantGuard } from "./public-tenant.guard";
import { CLIENT_UPLOADABLE_BUCKETS, type BucketName } from "../storage/storage.config";
import { buildCacheTags, CACHE_TAG_HEADER, LONG_CACHE_CONTROL } from "./cache-tags";
import type { WebdeskRequest } from "../auth/webdesk-request";
import type { UploadMediaBody } from "./dto";

function assertBucketParam(bucket: string): BucketName {
  if (bucket === "media" || bucket === "video" || bucket === "uploads" || bucket === "artifacts") {
    return bucket;
  }
  throw new BadRequestException(`unknown bucket '${bucket}'`);
}

@Controller("v1/t/:tenantSlug/media")
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly imgproxy: ImgproxyService,
    private readonly uploads: MediaUploadService,
    private readonly tenants: TenantLookupService,
  ) {}

  /**
   * The one answer of the token upload route to every invalid-token cause (unknown, malformed, expired, spent,
   * another tenant's token, an unknown or archived tenant slug): a bare 404, the same body as an unknown
   * tenant on any public media route. `Connection: close` ends a sender still streaming a body nobody will read.
   */
  private tokenNotFound(reply: FastifyReply): NotFoundException {
    reply.header("connection", "close");
    return new NotFoundException();
  }

  private async activeTenantId(slug: string): Promise<string | null> {
    const tenant = await this.tenants.bySlug(slug);
    return tenant && tenant.status === "active" ? tenant.id : null;
  }

  /** CORS preflight of the token upload route: answers only for a token that could still be redeemed. */
  @Options("upload/:token")
  @HttpCode(204)
  async uploadPreflight(
    @Param("tenantSlug") tenantSlug: string,
    @Param("token") token: string,
    @Headers("origin") origin: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const tenantId = await this.activeTenantId(tenantSlug);
    const hit = tenantId ? await this.uploads.preflight(tenantId, token, origin ?? null) : null;
    if (!hit) throw this.tokenNotFound(reply);
    reply.header("cache-control", "no-store");
    reply.header("vary", "Origin");
    if (hit.allowOrigin) {
      reply.header("access-control-allow-origin", hit.allowOrigin);
      reply.header("access-control-allow-methods", "POST, OPTIONS");
      reply.header("access-control-allow-headers", "content-type");
      reply.header("access-control-max-age", "600");
    }
    return undefined;
  }

  /**
   * `POST /v1/t/:tenantSlug/media/upload/:token?filename=<name>`: the body is the file, its Content-Type the
   * file's type. No api key: the token (minted by the `media.uploadToken` control command) is the credential
   * and uploads exactly once. 201 with the asset; see media-upload.service.ts.
   */
  @Post("upload/:token")
  async uploadWithToken(
    @Req() req: WebdeskRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("token") token: string,
    @Query("filename") filename: unknown,
    @Headers("origin") origin: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const tenantId = await this.activeTenantId(tenantSlug);
    if (!tenantId) throw this.tokenNotFound(reply);
    const declared = req.headers["content-length"];
    const contentLength = typeof declared === "string" && /^\d{1,15}$/.test(declared) ? Number(declared) : null;
    try {
      const asset = await this.uploads.redeem({
        tenantId,
        tenantSlug,
        token,
        origin: origin ?? null,
        contentType: req.headers["content-type"],
        contentLength,
        filename: cleanOriginalFilename(filename),
        body: req.raw,
        onAuthorized: (allowOrigin) => {
          // From here the token is proven: the answer may carry CORS, and is never cached.
          reply.header("cache-control", "no-store");
          reply.header("vary", "Origin");
          if (allowOrigin) reply.header("access-control-allow-origin", allowOrigin);
        },
      });
      return asset;
    } catch (err) {
      // Whatever went wrong, the body may be unread (or too big to be worth reading): end the connection after
      // the answer instead of draining it.
      reply.header("connection", "close");
      throw err;
    }
  }

  @Post(":bucket")
  @RequireScope("write")
  @UseGuards(ApiKeyAuthGuard, ScopeGuard)
  async upload(@Req() req: WebdeskRequest, @Param("bucket") bucketParam: string, @Body() body: UploadMediaBody) {
    if (!req.webdesk) throw new UnauthorizedException();
    const bucket = assertBucketParam(bucketParam);
    if (!CLIENT_UPLOADABLE_BUCKETS.has(bucket)) {
      throw new BadRequestException(`bucket '${bucket}' does not accept client uploads`);
    }

    const payload = body ?? {};
    if (!payload.filename || !payload.contentType || !payload.contentBase64) {
      throw new BadRequestException("filename, contentType and contentBase64 are required");
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(payload.contentBase64, "base64");
    } catch {
      throw new BadRequestException("contentBase64 is not valid base64");
    }

    const result = await this.media.upload(
      req.webdesk,
      bucket,
      { filename: payload.filename, contentType: payload.contentType, buffer },
      `apiKey:${req.webdesk.apiKeyId}`,
    );
    return result;
  }

  @Get(":assetId/presigned")
  @RequireScope("read")
  @UseGuards(ApiKeyAuthGuard, ScopeGuard)
  async presigned(@Req() req: WebdeskRequest, @Param("assetId") assetId: string) {
    if (!req.webdesk) throw new UnauthorizedException();
    const asset = await this.media.getPrivateAssetForPresign(req.webdesk, assetId);
    if (!asset) throw new NotFoundException();
    const url = await this.media.presignPrivate(asset);
    return { url, expiresInSeconds: 300 };
  }

  @Get(":assetId/transform")
  @UseGuards(PublicTenantGuard)
  async transform(
    @Req() req: WebdeskRequest & { webdeskTenantId?: string },
    @Param("assetId") assetId: string,
    @Query("w") width: string | undefined,
    @Query("h") height: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const tenantId = req.webdeskTenantId;
    if (!tenantId) throw new UnauthorizedException();
    const asset = await this.media.getPublicAsset(tenantId, assetId);
    if (!asset) throw new NotFoundException();

    const sourceUrl = await this.media.presignForTransform(asset);
    if (!this.imgproxy.isConfigured) {
      // imgproxy is not wired into this ticket's compose stack yet (media.config.ts's header) —
      // fail loud with a clear reason rather than silently falling back to the un-transformed
      // original, so the gap stays visible instead of masquerading as "it works".
      throw new NotFoundException("imgproxy is not configured on this deployment");
    }
    const targetUrl = this.imgproxy.buildSignedUrl(sourceUrl, {
      width: width ? Number(width) : undefined,
      height: height ? Number(height) : undefined,
    });

    reply.header("Cache-Control", LONG_CACHE_CONTROL);
    reply.header(
      CACHE_TAG_HEADER,
      buildCacheTags({ tenantSlug: (req.params as Record<string, string> | undefined)?.tenantSlug ?? "", assetId }).join(","),
    );
    reply.status(302);
    reply.header("Location", targetUrl);
    return { redirectedTo: targetUrl };
  }

  @Get(":assetId")
  @UseGuards(PublicTenantGuard)
  async serve(
    @Req() req: WebdeskRequest & { webdeskTenantId?: string },
    @Param("assetId") assetId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const tenantId = req.webdeskTenantId;
    if (!tenantId) throw new UnauthorizedException();

    // See media.service.ts's header: this lookup is scoped to `tenantId` (resolved from the
    // ROUTE's slug, never from the asset id) via RLS. A tenant-B asset id requested under
    // tenant-A's slug returns null here — 404, indistinguishable from "does not exist".
    const asset = await this.media.getPublicAsset(tenantId, assetId);
    if (!asset) throw new NotFoundException();

    const { body, contentType } = await this.media.fetchBytes(asset);

    // §11a AC: every public asset response carries a long Cache-Control + the cache tags, so a
    // CDN hit never reaches the origin.
    reply.header("Cache-Control", LONG_CACHE_CONTROL);
    reply.header(
      CACHE_TAG_HEADER,
      buildCacheTags({ tenantSlug: (req.params as Record<string, string> | undefined)?.tenantSlug ?? "", assetId }).join(","),
    );
    reply.header("Content-Type", contentType ?? asset.mime);
    // No Set-Cookie anywhere on this path (design §11: "served cookieless") — this handler never
    // touches cookies at all, which is what makes that true rather than merely intended.
    return body;
  }
}
