// WSK-07 — the media subsystem's orchestration: validate -> quota-check -> scan -> store -> record.
// Every DB read/write goes through `db.withTenant`, same discipline as content.service.ts (WSK-05)
// — the tenant GUC is what makes the corrected AC ("the API refuses to serve tenant A a file under
// tenant B's prefix") actually true: `getPublicAsset`/`getPrivateAssetForPresign` run their lookup
// UNDER the resolved tenant's context, so a row belonging to a different tenant is invisible to
// the query (RLS), not merely filtered after the fact.
import { BadRequestException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { AuditService } from "../audit/audit.service";
import { STORAGE_ADAPTER } from "../storage/storage.tokens";
import type { StorageAdapter } from "../storage/storage.types";
import { CLIENT_UPLOADABLE_BUCKETS, PRIVATE_BUCKETS, PUBLIC_BUCKETS, storageConfig, type BucketName } from "../storage/storage.config";
import { ClamAvService } from "./clamav.service";
import { QuotaService } from "./quota.service";
import { mediaConfig } from "./media.config";
import { buildObjectKey } from "./key-prefix";
import { decodeBucketKey, encodeBucketKey } from "./bucket-key-codec";
import { isMimeAllowedForBucket, sniffMime } from "./mime-allowlist";
import type { ResolvedApiKey } from "../api-keys/api-keys.service";
import type { MediaAssetRow, UploadMediaResult } from "./dto";

export type ResolvedAsset = {
  id: string;
  tenantId: string;
  bucket: BucketName;
  objectKey: string;
  mime: string;
  sizeBytes: number;
  scanStatus: string;
};

@Injectable()
export class MediaService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly clamAv: ClamAvService,
    private readonly quota: QuotaService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  async upload(
    auth: ResolvedApiKey,
    bucket: BucketName,
    input: { filename: string; contentType: string; buffer: Buffer },
    actor: string,
  ): Promise<UploadMediaResult> {
    if (!CLIENT_UPLOADABLE_BUCKETS.has(bucket)) {
      throw new BadRequestException(`bucket '${bucket}' does not accept client uploads`);
    }

    // 1. Size cap — cheapest check first, refuses before any I/O.
    if (input.buffer.length === 0) {
      throw new BadRequestException("empty upload");
    }
    if (input.buffer.length > storageConfig.maxUploadSizeBytes) {
      throw new BadRequestException(
        `upload exceeds the ${storageConfig.maxUploadSizeBytes}-byte limit (${input.buffer.length} bytes)`,
      );
    }

    // 2. Declared-type allowlist.
    if (!isMimeAllowedForBucket(bucket, input.contentType)) {
      throw new BadRequestException(`content-type '${input.contentType}' is not allowed for bucket '${bucket}'`);
    }

    // 3. Magic-byte sniff must agree with the declared type — never trust the header alone.
    const sniffed = sniffMime(input.buffer);
    if (sniffed !== input.contentType) {
      throw new BadRequestException(
        `declared content-type '${input.contentType}' does not match the file's actual signature (${sniffed ?? "unrecognized"})`,
      );
    }

    // 4. Per-tenant storage quota (§11a).
    if (await this.quota.wouldExceedQuota(auth.tenantId, input.buffer.length)) {
      throw new ForbiddenException("tenant storage quota exceeded");
    }

    // 5. ClamAV scan — FAIL CLOSED. A scanner that cannot be reached must refuse the upload, never
    //    silently accept it (see clamav.service.ts's header).
    let scanResult;
    try {
      scanResult = await this.clamAv.scanBuffer(input.buffer, {
        host: mediaConfig.clamAvHost,
        port: mediaConfig.clamAvPort,
        timeoutMs: mediaConfig.clamAvTimeoutMs,
      });
    } catch (err) {
      throw new ServiceUnavailableException(`malware scan unavailable — upload refused: ${String(err)}`);
    }

    if (scanResult.infected) {
      // Refused AND logged — the ticket's own AC wording. Logged via the audit trail (design
      // §11: "immutable audit_entries on every command"), args carry the signature but never the
      // file bytes.
      await this.db.withTenant(auth.tenantId, (db) =>
        db.transaction((client) =>
          this.audit.record(client, {
            tenantId: auth.tenantId,
            actor,
            action: "webdesk.media.uploadRefused",
            args: { bucket, filename: input.filename, reason: "clamav-hit", signature: scanResult.signature },
          }),
        ),
      );
      throw new ForbiddenException(`upload refused: malware scan matched '${scanResult.signature}'`);
    }

    // 6. Store, then record — object write happens BEFORE the DB row so a crash between the two
    //    leaves an orphaned object (cheap to garbage-collect later) rather than a DB row pointing
    //    at nothing.
    const objectKey = buildObjectKey(auth.tenantId, auth.siteId, input.filename);
    const bucketName = storageConfig.bucketName(bucket);
    await this.storage.putObject(bucketName, objectKey, input.buffer, input.contentType);

    const storedBucketKey = encodeBucketKey(bucket, objectKey);
    const row = await this.db.withTenant(auth.tenantId, (db) =>
      db.transaction(async (client) => {
        const { rows } = await client.query<MediaAssetRow>(
          `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, scan_status)
           VALUES ($1, $2, $3, $4, $5, 'clean')
           RETURNING id, tenant_id, site_id, bucket_key, mime, size_bytes, scan_status, created_at`,
          [auth.tenantId, auth.siteId, storedBucketKey, input.contentType, input.buffer.length],
        );
        await this.audit.record(client, {
          tenantId: auth.tenantId,
          actor,
          action: "webdesk.media.upload",
          args: { bucket, mediaAssetId: rows[0].id, sizeBytes: input.buffer.length },
        });
        return rows[0];
      }),
    );

    return {
      id: row.id,
      bucket,
      bucketKey: objectKey,
      mime: row.mime,
      sizeBytes: Number(row.size_bytes),
      scanStatus: row.scan_status,
      createdAt: row.created_at,
    };
  }

  /**
   * Public serving path lookup — no API key. `tenantId` here MUST already come from a tenant
   * resolved by SLUG (see media.controller.ts's PublicTenantGuard), never from anything the
   * caller could set directly, or this stops being an isolation boundary.
   *
   * THE CORRECTED AC, made concrete: this query runs `db.withTenant(tenantId, ...)`, which sets
   * `webdesk.tenant_ctx` to the CALLER'S resolved tenant. `media_assets`' FORCE RLS policy
   * (`tenant_id = webdesk_tenant_ctx()`) then makes a row belonging to a DIFFERENT tenant simply
   * not exist for this query — `rows[0]` is undefined, not "found but denied". Requesting tenant
   * A's slug with tenant B's real asset id therefore 404s exactly like a nonexistent id would;
   * the two are indistinguishable from the outside, which is the correct failure shape (no
   * existence oracle).
   */
  async getPublicAsset(tenantId: string, assetId: string): Promise<ResolvedAsset | null> {
    const row = await this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<MediaAssetRow>(
        `SELECT id, tenant_id, site_id, bucket_key, mime, size_bytes, scan_status
           FROM media_assets WHERE id = $1`,
        [assetId],
      );
      return rows[0] ?? null;
    });
    if (!row) return null;
    if (row.scan_status !== "clean") return null; // never serve anything not proven clean

    const decoded = decodeBucketKey(row.bucket_key);
    if (!decoded || !PUBLIC_BUCKETS.has(decoded.bucket)) return null; // uploads/artifacts never served here

    return {
      id: row.id,
      tenantId: row.tenant_id,
      bucket: decoded.bucket,
      objectKey: decoded.objectKey,
      mime: row.mime,
      sizeBytes: Number(row.size_bytes),
      scanStatus: row.scan_status,
    };
  }

  /** Authenticated presigned-GET path for the PRIVATE `uploads` bucket only. Same RLS reasoning as above. */
  async getPrivateAssetForPresign(auth: ResolvedApiKey, assetId: string): Promise<ResolvedAsset | null> {
    const row = await this.db.withTenant(auth.tenantId, async (db) => {
      const { rows } = await db.query<MediaAssetRow>(
        `SELECT id, tenant_id, site_id, bucket_key, mime, size_bytes, scan_status
           FROM media_assets WHERE id = $1 AND site_id = $2`,
        [assetId, auth.siteId],
      );
      return rows[0] ?? null;
    });
    if (!row) return null;

    const decoded = decodeBucketKey(row.bucket_key);
    if (!decoded || !PRIVATE_BUCKETS.has(decoded.bucket)) return null;

    return {
      id: row.id,
      tenantId: row.tenant_id,
      bucket: decoded.bucket,
      objectKey: decoded.objectKey,
      mime: row.mime,
      sizeBytes: Number(row.size_bytes),
      scanStatus: row.scan_status,
    };
  }

  async fetchBytes(asset: ResolvedAsset): Promise<{ body: Buffer; contentType?: string }> {
    const bucketName = storageConfig.bucketName(asset.bucket);
    const result = await this.storage.getObject(bucketName, asset.objectKey);
    return { body: result.body, contentType: result.contentType ?? asset.mime };
  }

  async presignPrivate(asset: ResolvedAsset): Promise<string> {
    const bucketName = storageConfig.bucketName(asset.bucket);
    return this.storage.presignGetObject(bucketName, asset.objectKey, storageConfig.presignedGetTtlSeconds);
  }

  /** Public source URL an external service (imgproxy) can fetch FROM — presigned so it works
   *  regardless of whether the bucket itself carries a public-read policy. */
  async presignForTransform(asset: ResolvedAsset): Promise<string> {
    const bucketName = storageConfig.bucketName(asset.bucket);
    return this.storage.presignGetObject(bucketName, asset.objectKey, storageConfig.presignedGetTtlSeconds);
  }
}
