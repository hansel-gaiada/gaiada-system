// WSK-07 — the S3-API adapter interface (design §11a / WSK-D23): everything in `media/**` talks
// to THIS interface only, never to a concrete SDK client type. The design's requirement is that
// swapping the storage endpoint (self-hosted MinIO today -> R2/S3/NAS later) is "config only" —
// that is only true if no caller ever imports an SDK-specific type or method name. The abstraction
// test (`test/media-storage-abstraction.spec.ts`) greps for that leak and also drives this
// interface against two differently-configured adapter instances to prove config alone changes
// the target.
//
// Deliberately generic S3-API vocabulary (bucket/key/putObject/presign...), not
// Minio-flavoured vocabulary (no "minioClient", no admin/policy verbs beyond what any S3-API
// provider exposes) — R2 and AWS S3 both speak this same surface.

export type PutObjectResult = { etag?: string };

export type GetObjectResult = {
  body: Buffer;
  contentType?: string;
  contentLength?: number;
};

export type HeadObjectResult = {
  contentType?: string;
  contentLength?: number;
} | null;

export type EnsureBucketOptions = {
  /** Enable bucket versioning (§11a: "versioning + object lock where MinIO supports it"). */
  versioning?: boolean;
  /**
   * Enable object-lock (WORM) on the bucket. Only takes effect if the underlying provider
   * supports enabling object lock AT bucket-creation time (S3/MinIO both require this — it
   * cannot be turned on for a bucket that already exists without it). A provider that does not
   * support object lock at all (some S3-compatible providers) must no-op here rather than throw
   * — "where MinIO supports it" is explicitly conditional in the design.
   */
  objectLock?: boolean;
};

/**
 * The one seam every caller in `media/**` is allowed to depend on. No method here is
 * MinIO-specific; a second implementation (e.g. backed by a different SDK) only has to satisfy
 * this shape to be a legal drop-in.
 */
export interface StorageAdapter {
  readonly providerName: string;

  putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<PutObjectResult>;
  getObject(bucket: string, key: string): Promise<GetObjectResult>;
  headObject(bucket: string, key: string): Promise<HeadObjectResult>;
  deleteObject(bucket: string, key: string): Promise<void>;

  /** A short-lived, time-limited GET URL — the only access mode `uploads` (PRIVATE) ever gets. */
  presignGetObject(bucket: string, key: string, expiresInSeconds: number): Promise<string>;

  /** Idempotent: safe to call on every boot. */
  ensureBucket(bucket: string, options?: EnsureBucketOptions): Promise<void>;
}
