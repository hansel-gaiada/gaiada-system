// WSK-07 / WSK-52 — storage config. Every field is a GETTER (same reasoning as ../config.ts: env vars
// must read live, not be snapshotted at module-import time, or a test process that sets
// process.env.* after this module has already been imported transitively loses the race).
//
// WSK-52 (WSK-D42, RustFS replaces MinIO): the api authenticates to object storage with a DEDICATED,
// least-privilege service key (STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY) minted by
// webdesk/scripts/storage-bootstrap.mjs. The old fallback to the storage server's ROOT credential
// (WSK-07's carried gap) is REMOVED: an unset key now throws at boot in EVERY environment, and a
// key that equals the root user is refused too. Root credentials (RUSTFS_ROOT_USER/PASSWORD) are
// used only by the bootstrap script and never reach the api container.
function required(name: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  throw new Error(
    `[webdesk:api] ${name} is not set — refusing to boot. The api needs the dedicated storage service key ` +
      `created by webdesk/scripts/storage-bootstrap.mjs; it never falls back to the storage root credential.`,
  );
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
    return process.env.STORAGE_ENDPOINT || "";
  },
  get region(): string {
    // RustFS ignores the region value but the S3 SDK requires one to be set; S3/R2 need a real one
    // at swap time — config-only, per the abstraction requirement.
    return process.env.STORAGE_REGION || "us-east-1";
  },
  get forcePathStyle(): boolean {
    // RustFS (and most self-hosted S3-API providers) require path-style addressing
    // (`endpoint/bucket/key`, not `bucket.endpoint/key`) since they are not on a wildcard DNS
    // domain. AWS S3 defaults to virtual-hosted style but also accepts path-style, and R2 accepts
    // it too — so leaving this "true" as the default is broadly compatible, and it is exactly the
    // one flag the design calls a "config only" swap knob.
    return (process.env.STORAGE_FORCE_PATH_STYLE ?? "true") !== "false";
  },
  get accessKeyId(): string {
    const key = required("STORAGE_ACCESS_KEY_ID");
    const root = process.env.RUSTFS_ROOT_USER;
    if (root && key === root) {
      throw new Error("[webdesk:api] STORAGE_ACCESS_KEY_ID equals RUSTFS_ROOT_USER — refusing to run the api as storage admin.");
    }
    return key;
  },
  get secretAccessKey(): string {
    return required("STORAGE_SECRET_ACCESS_KEY");
  },

  bucketName(bucket: BucketName): string {
    switch (bucket) {
      case "media":
        return process.env.STORAGE_BUCKET_MEDIA || "media";
      case "video":
        return process.env.STORAGE_BUCKET_VIDEO || "video";
      case "uploads":
        return process.env.STORAGE_BUCKET_UPLOADS || "uploads";
      case "artifacts":
        return process.env.STORAGE_BUCKET_ARTIFACTS || "artifacts";
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
    return process.env.STORAGE_PUBLIC_BASE_URL || process.env.STORAGE_ENDPOINT || "";
  },
};
