// WSK-07 — the media route surface. Three concerns kept in three route shapes:
//   - upload:    authenticated, write-scoped (reuses WSK-05's ApiKeyAuthGuard/ScopeGuard)
//   - serving:   PUBLIC, cookieless, media/video buckets ONLY, long Cache-Control + cache tags
//   - presigned: authenticated, read-scoped, uploads (PRIVATE) bucket ONLY
//   - transform: PUBLIC, imgproxy-signed redirect, media/video buckets ONLY
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { MediaService } from "./media.service";
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
  constructor(private readonly media: MediaService, private readonly imgproxy: ImgproxyService) {}

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
