// WSK-07 — the media subsystem's orchestration: validate -> quota-check -> scan -> store -> record.
// Every DB read/write goes through `db.withTenant`, same discipline as content.service.ts (WSK-05)
// — the tenant GUC is what makes the corrected AC ("the API refuses to serve tenant A a file under
// tenant B's prefix") actually true: `getPublicAsset`/`getPrivateAssetForPresign` run their lookup
// UNDER the resolved tenant's context, so a row belonging to a different tenant is invisible to
// the query (RLS), not merely filtered after the fact.
import { BadRequestException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { uploadRefusal } from "./upload-problem";
import type { PoolClient } from "pg";
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

/** A scan hit. Not an HttpException on purpose: the token route's transaction must roll back on it, THEN the refusal is audited. */
export class InfectedUploadError extends Error {
  constructor(readonly signature: string) {
    super(`malware scan matched '${signature}'`);
    this.name = "InfectedUploadError";
  }

  toForbidden(): ForbiddenException {
    return uploadRefusal(new ForbiddenException(`upload refused: malware scan matched '${this.signature}'`), "upload-infected");
  }
}

export type StoredObject = { objectKey: string; storedBucketKey: string };

/** The columns of a media_assets row every read here returns (the library facts included). */
export const MEDIA_ASSET_COLUMNS =
  "id, tenant_id, site_id, bucket_key, mime, size_bytes, scan_status, created_at, title, alt, tags, original_filename, width, height, updated_at, created_by";

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

  /**
   * The API-key upload (`POST /v1/t/:slug/media/:bucket`, base64 JSON): the original WSK-07 path. A thin
   * wrapper: screen -> store -> record, in the transaction it opens itself.
   */
  async upload(
    auth: ResolvedApiKey,
    bucket: BucketName,
    input: { filename: string; contentType: string; buffer: Buffer },
    actor: string,
  ): Promise<UploadMediaResult> {
    if (!CLIENT_UPLOADABLE_BUCKETS.has(bucket)) {
      throw new BadRequestException(`bucket '${bucket}' does not accept client uploads`);
    }
    try {
      await this.screen(auth.tenantId, bucket, input, {});
    } catch (err) {
      if (err instanceof InfectedUploadError) {
        await this.refuseInfected(auth.tenantId, actor, bucket, input.filename, err.signature);
        throw err.toForbidden();
      }
      throw err;
    }

    const stored = await this.storeObject(auth.tenantId, auth.siteId, bucket, input);
    const row = await this.db.withTenant(auth.tenantId, (db) =>
      db.transaction((client) => this.recordAsset(client, { tenantId: auth.tenantId, siteId: auth.siteId, bucket, input, stored, actor })),
    );

    return {
      id: row.id,
      bucket,
      bucketKey: stored.objectKey,
      mime: row.mime,
      sizeBytes: Number(row.size_bytes),
      scanStatus: row.scan_status,
      createdAt: row.created_at,
    };
  }

  /**
   * The upload pipeline's checks, in order, up to and including the malware scan: every way an upload can
   * be refused BEFORE a byte is stored. Shared by the API-key route and the token route (WSK-43a: one
   * pipeline, never a second). It holds no database connection across the scan (the quota read is one
   * short query). `policy.maxBytes` / `policy.allowedMimes` narrow what the service-wide cap and the bucket allowlist
   * already allow (an upload token's own limits); they can never widen it.
   * Throws InfectedUploadError for a scan hit; the caller records the refusal (refuseInfected) and answers 403.
   */
  async screen(
    tenantId: string,
    bucket: BucketName,
    input: { filename: string; contentType: string; buffer: Buffer },
    policy: { maxBytes?: number; allowedMimes?: readonly string[] },
  ): Promise<{ sniffed: string }> {
    // 1. Size cap — cheapest check first, refuses before any I/O.
    if (input.buffer.length === 0) {
      throw uploadRefusal(new BadRequestException("empty upload"), "upload-empty");
    }
    const cap = Math.min(storageConfig.maxUploadSizeBytes, policy.maxBytes ?? Number.POSITIVE_INFINITY);
    if (input.buffer.length > cap) {
      throw uploadRefusal(new BadRequestException(`upload exceeds the ${cap}-byte limit (${input.buffer.length} bytes)`), "upload-too-large");
    }

    // 2. Declared-type allowlist (the bucket's, narrowed by the token's set when there is one).
    if (!isMimeAllowedForBucket(bucket, input.contentType) || (policy.allowedMimes && !policy.allowedMimes.includes(input.contentType))) {
      throw uploadRefusal(new BadRequestException(`content-type '${input.contentType}' is not allowed for bucket '${bucket}'`), "upload-type-not-allowed");
    }

    // 3. Magic-byte sniff must agree with the declared type — never trust the header alone.
    const sniffed = sniffMime(input.buffer);
    if (sniffed !== input.contentType) {
      throw uploadRefusal(
        new BadRequestException(`declared content-type '${input.contentType}' does not match the file's actual signature (${sniffed ?? "unrecognized"})`),
        "upload-type-mismatch",
      );
    }

    // 4. Per-tenant storage quota (§11a), counted in bytes storage still holds (quota.service.ts).
    if (await this.quota.wouldExceedQuota(tenantId, input.buffer.length)) {
      throw uploadRefusal(new ForbiddenException("tenant storage quota exceeded"), "upload-quota-exceeded");
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
      throw uploadRefusal(new ServiceUnavailableException(`malware scan unavailable — upload refused: ${String(err)}`), "upload-scan-unavailable");
    }
    if (scanResult.infected) throw new InfectedUploadError(scanResult.signature);
    return { sniffed };
  }

  /**
   * "Refused AND logged" (the ticket's own AC wording): a scan hit is written to the audit trail (design §11:
   * "immutable audit_entries on every command"); args carry the signature but never the file bytes. Its own
   * short transaction, so it commits whatever happens to the caller's.
   */
  async refuseInfected(tenantId: string, actor: string, bucket: BucketName, filename: string, signature: string): Promise<void> {
    await this.db.withTenant(tenantId, (db) =>
      db.transaction((client) =>
        this.audit.record(client, {
          tenantId,
          actor,
          action: "webdesk.media.uploadRefused",
          args: { bucket, filename, reason: "clamav-hit", signature },
        }),
      ),
    );
  }

  /**
   * Store the object. The object write happens BEFORE the DB row so a crash between the two leaves an
   * orphaned object (cheap to garbage-collect later) rather than a DB row pointing at nothing.
   */
  async storeObject(
    tenantId: string,
    siteId: string,
    bucket: BucketName,
    input: { filename: string; contentType: string; buffer: Buffer },
  ): Promise<StoredObject> {
    const objectKey = buildObjectKey(tenantId, siteId, input.filename);
    await this.storage.putObject(storageConfig.bucketName(bucket), objectKey, input.buffer, input.contentType);
    return { objectKey, storedBucketKey: encodeBucketKey(bucket, objectKey) };
  }

  /** Best-effort cleanup of an object whose row never committed (a plain delete: on a locked bucket it adds a marker only). */
  async discardObject(bucket: BucketName, objectKey: string): Promise<void> {
    await this.storage.deleteObject(storageConfig.bucketName(bucket), objectKey).catch(() => undefined);
  }

  /**
   * A soft-deleted row for an object that was stored but whose real row could not be written (the token route's
   * insert failed). The object has been deleted, but on a locked bucket that only adds a marker: this row, with
   * `purge_after` = now + the bucket retention, is what lets `media-purge` free the locked version later (and
   * keeps the quota honest until then). Best effort: the caller logs if it fails too.
   */
  async recordTombstone(p: {
    tenantId: string;
    siteId: string;
    bucket: BucketName;
    input: { filename: string; contentType: string; buffer: Buffer };
    stored: StoredObject;
    actor: string;
  }): Promise<void> {
    const days = storageConfig.objectLockRetentionDays;
    await this.db.withTenant(p.tenantId, (db) =>
      db.query(
        `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, scan_status, created_by, deleted_at, purge_after)
         VALUES ($1, $2, $3, $4, $5, 'clean', $6, now(), now() + ($7::integer * interval '1 day'))`,
        [p.tenantId, p.siteId, p.stored.storedBucketKey, p.input.contentType, p.input.buffer.length, p.actor, days],
      ),
    );
  }

  /** The asset row and its audit row, on the caller's transaction. */
  async recordAsset(
    client: PoolClient,
    p: {
      tenantId: string;
      siteId: string;
      bucket: BucketName;
      input: { filename: string; contentType: string; buffer: Buffer };
      stored: StoredObject;
      actor: string;
      /** Library facts (WSK-43a); omitted by the API-key route. */
      facts?: { originalFilename: string | null; width: number | null; height: number | null };
      /** Extra audit args (the token route names its token id). */
      auditExtra?: Record<string, unknown>;
    },
  ): Promise<MediaAssetRow> {
    const { rows } = await client.query<MediaAssetRow>(
      `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, scan_status, original_filename, width, height, created_by)
       VALUES ($1, $2, $3, $4, $5, 'clean', $6, $7, $8, $9)
       RETURNING ${MEDIA_ASSET_COLUMNS}`,
      [
        p.tenantId,
        p.siteId,
        p.stored.storedBucketKey,
        p.input.contentType,
        p.input.buffer.length,
        p.facts?.originalFilename ?? null,
        p.facts?.width ?? null,
        p.facts?.height ?? null,
        p.actor,
      ],
    );
    await this.audit.record(client, {
      tenantId: p.tenantId,
      actor: p.actor,
      action: "webdesk.media.upload",
      args: { bucket: p.bucket, mediaAssetId: rows[0].id, sizeBytes: p.input.buffer.length, ...(p.auditExtra ?? {}) },
    });
    return rows[0];
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
           FROM media_assets WHERE id = $1 AND deleted_at IS NULL`,
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
           FROM media_assets WHERE id = $1 AND site_id = $2 AND deleted_at IS NULL`,
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
