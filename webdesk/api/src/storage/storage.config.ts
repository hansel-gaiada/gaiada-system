// WSK-07 — storage config. Every field is a GETTER (same reasoning as ../config.ts: env vars must
// read live, not be snapshotted at module-import time, or a test process that sets
// process.env.* after this module has already been imported transitively loses the race).
//
// FLAGGED GAP — reported in the ticket output, not fixed here (this ticket owns media/** and
// storage/** only, not .env.example): there is no dedicated non-root MinIO credential for the api
// service. `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in .env.example are the MinIO cluster's own
// bootstrap admin credential (same shape as Postgres's `POSTGRES_SUPERUSER`), not a
// least-privilege service credential. This file prefers dedicated `STORAGE_ACCESS_KEY_ID` /
// `STORAGE_SECRET_ACCESS_KEY` vars if present and falls back to the MinIO root credential only for
// dev — the same "requireInProd"-shaped honesty ../config.ts already uses elsewhere, applied here
// too so a forgotten dedicated credential fails loud in production instead of silently running the
// api as MinIO's root user.
function requireInProd(name: string, devFallback: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[webdesk:api] ${name} is not set — refusing to boot in production.`);
  }
  return devFallback;
}

export type BucketName = "media" | "video" | "uploads" | "artifacts";

/** media/video are the two CDN-fronted public buckets (§11a). */
export const PUBLIC_BUCKETS: ReadonlySet<BucketName> = new Set(["media", "video"]);
/** uploads is the one PRIVATE bucket — form attachments, presigned-GET only, never public. */
export const PRIVATE_BUCKETS: ReadonlySet<BucketName> = new Set(["uploads"]);
/** artifacts is platform-internal (SDK tarballs, content dumps, backups) — no client upload route. */
export const PLATFORM_BUCKETS: ReadonlySet<BucketName> = new Set(["artifacts"]);

/** Buckets a tenant-scoped client is ever allowed to upload into via `POST /v1/t/:slug/media/:bucket`. */
export const CLIENT_UPLOADABLE_BUCKETS: ReadonlySet<BucketName> = new Set(["media", "video", "uploads"]);

export const storageConfig = {
  get endpoint(): string {
    return process.env.STORAGE_ENDPOINT || process.env.MINIO_ENDPOINT || "";
  },
  get region(): string {
    // MinIO ignores the region value but the S3 SDK requires one to be set; S3/R2 need a real one
    // at swap time — config-only, per the abstraction requirement.
    return process.env.STORAGE_REGION || "us-east-1";
  },
  get forcePathStyle(): boolean {
    // MinIO (and most self-hosted S3-API providers) require path-style addressing
    // (`endpoint/bucket/key`, not `bucket.endpoint/key`) since they are not on a wildcard DNS
    // domain. AWS S3 defaults to virtual-hosted style but also accepts path-style, and R2 accepts
    // it too — so leaving this "true" as the default is broadly compatible, and it is exactly the
    // one flag the design calls a "config only" swap knob.
    return (process.env.STORAGE_FORCE_PATH_STYLE ?? "true") !== "false";
  },
  get accessKeyId(): string {
    return requireInProd("STORAGE_ACCESS_KEY_ID", process.env.MINIO_ROOT_USER || "webdesk_minio");
  },
  get secretAccessKey(): string {
    return requireInProd("STORAGE_SECRET_ACCESS_KEY", process.env.MINIO_ROOT_PASSWORD || "changeme_minio_password");
  },

  bucketName(bucket: BucketName): string {
    switch (bucket) {
      case "media":
        return process.env.MINIO_BUCKET_MEDIA || "media";
      case "video":
        return process.env.MINIO_BUCKET_VIDEO || "video";
      case "uploads":
        return process.env.MINIO_BUCKET_UPLOADS || "uploads";
      case "artifacts":
        return process.env.MINIO_BUCKET_ARTIFACTS || "artifacts";
    }
  },

  /** Hard cap on a single upload, §07 AC "oversize ... refused". */
  get maxUploadSizeBytes(): number {
    return Number(process.env.WEBDESK_MEDIA_MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024); // 8 MiB default
  },

  /**
   * §11a: "Per-tenant storage quotas (§15) are the enforcement." §15 does not exist yet in the
   * design doc at the time of this ticket (flagged in the report) — this is a pragmatic default,
   * config-overridable, enforced in `media/quota.service.ts` against `sum(media_assets.size_bytes)`
   * rather than a dedicated ledger column (no migration is in this ticket's scope).
   */
  get tenantStorageQuotaBytes(): number {
    return Number(process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES ?? 5 * 1024 * 1024 * 1024); // 5 GiB default
  },

  get presignedGetTtlSeconds(): number {
    return Number(process.env.WEBDESK_MEDIA_PRESIGN_TTL_SECONDS ?? 300); // 5 minutes
  },

  /**
   * Public base URL a *browser or imgproxy* would use to reach media objects directly — distinct
   * from `endpoint`, which is the api's own (often container-internal) address for the SDK client.
   * Only used by ImgproxyService to build a source URL; unset in dev (imgproxy is not wired into
   * this ticket's compose stack — see the ticket report).
   */
  get publicObjectBaseUrl(): string {
    return process.env.STORAGE_PUBLIC_BASE_URL || process.env.MINIO_ENDPOINT || "";
  },
};
