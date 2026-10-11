// WSK-43a — shared helpers for test/media-upload-token.spec.ts, media-library-commands.spec.ts and
// media-purge.spec.ts (not a spec itself: vitest only collects *.spec.ts). Builds on content-test-kit.ts
// (real Postgres, the real AppModule, the real Layer-3/4 PDP, dev-mode Layer 1/2/2e header stubs) and talks to
// the real RustFS the gate provides, through the same S3 client the api uses (root credentials for ground
// truth: the api's own key cannot list versions of the artifacts bucket and we want an independent witness).
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { HeadObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "../src/storage/s3-storage.adapter";
import { asTenant, hdr, type ContentFixture, type HeaderOpts } from "./content-test-kit";

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export const PROBLEM = "https://webdesk.gaiada.online/errors/";

// ------------------------------------------------------------------------------------------------
// Control-plane requests
// ------------------------------------------------------------------------------------------------
export const mediaBase = (fx: ContentFixture): string => `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/media`;

export function mintUploadToken(app: NestFastifyApplication, fx: ContentFixture, body: Record<string, unknown> = { bucket: "media" }, opts: HeaderOpts = {}) {
  return app.inject({ method: "POST", url: `${mediaBase(fx)}/upload-token`, headers: hdr(opts), payload: body });
}

export function updateMedia(app: NestFastifyApplication, fx: ContentFixture, assetId: string, body: Record<string, unknown>, opts: HeaderOpts = {}) {
  return app.inject({ method: "PATCH", url: `${mediaBase(fx)}/${assetId}`, headers: hdr(opts), payload: body });
}

export function deleteMedia(app: NestFastifyApplication, fx: ContentFixture, assetId: string, opts: HeaderOpts = {}) {
  return app.inject({ method: "DELETE", url: `${mediaBase(fx)}/${assetId}`, headers: hdr(opts) });
}

export function mediaUsage(app: NestFastifyApplication, fx: ContentFixture, assetId: string, opts: HeaderOpts = {}) {
  return app.inject({ method: "GET", url: `${mediaBase(fx)}/${assetId}/usage`, headers: hdr({ ...opts, editorial: null, idem: null }) });
}

export function listMedia(app: NestFastifyApplication, fx: ContentFixture, qs = "", opts: HeaderOpts = {}) {
  return app.inject({ method: "GET", url: `${mediaBase(fx)}${qs ? `?${qs}` : ""}`, headers: hdr({ ...opts, editorial: null, idem: null }) });
}

export interface MintedUpload {
  tokenId: string;
  token: string;
  uploadPath: string;
  expiresAt: string;
  bucket: string;
  maxBytes: number;
  allowedMimes: string[];
  replayed: boolean;
}

/** Mints (asserting 201) and returns the token. */
export async function mintOk(app: NestFastifyApplication, fx: ContentFixture, body: Record<string, unknown> = { bucket: "media" }): Promise<MintedUpload> {
  const res = await mintUploadToken(app, fx, body);
  if (res.statusCode !== 201) throw new Error(`mintOk: ${res.statusCode} ${res.body}`);
  return res.json<MintedUpload>();
}

// ------------------------------------------------------------------------------------------------
// The public upload route
// ------------------------------------------------------------------------------------------------
export interface UploadOpts {
  contentType?: string | null;
  filename?: string;
  origin?: string;
  extraHeaders?: Record<string, string>;
}

export function uploadFile(app: NestFastifyApplication, slug: string, token: string, body: Buffer | Readable | string, opts: UploadOpts = {}) {
  const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "image/png";
  if (opts.origin) headers.origin = opts.origin;
  const qs = opts.filename ? `?filename=${encodeURIComponent(opts.filename)}` : "";
  return app.inject({ method: "POST", url: `/v1/t/${slug}/media/upload/${token}${qs}`, headers, payload: body as never });
}

export function preflight(app: NestFastifyApplication, slug: string, token: string, origin?: string) {
  return app.inject({
    method: "OPTIONS",
    url: `/v1/t/${slug}/media/upload/${token}`,
    headers: { ...(origin ? { origin } : {}), "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
}

// ------------------------------------------------------------------------------------------------
// Fixtures: bytes
// ------------------------------------------------------------------------------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG header (signature + IHDR for width x height), padded with zeros to `total` bytes. The scanner accepts it (the WSK-07 suites do the same). */
export function buildPng(width = 640, height = 480, total = 256): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // RGBA
  const head = Buffer.concat([PNG_SIG, ihdr]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, total - head.length), 0x61)]);
}

/** A buffer that is a JPEG by signature (for the declared-vs-sniffed mismatch case). */
export function buildJpeg(total = 128): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(total - 4, 0x62)]);
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** The EICAR test string as the content of a PDF stream: reliably detected by ClamAV (see media-eicar-scan.spec.ts for why a PDF). */
export function buildEicarPdf(): Buffer {
  const stream = Buffer.from(EICAR, "ascii");
  const head = Buffer.from(
    "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n" +
      `4 0 obj\n<< /Length ${stream.length} >>\nstream\n`,
    "ascii",
  );
  return Buffer.concat([head, stream, Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF", "ascii")]);
}

// ------------------------------------------------------------------------------------------------
// Fixtures: the database
// ------------------------------------------------------------------------------------------------
export async function dumpTokens(fx: ContentFixture): Promise<Record<string, unknown>[]> {
  return asTenant(fx.tenantId, async (db) => (await db.query(`SELECT * FROM media_upload_tokens WHERE tenant_id = $1 ORDER BY created_at`, [fx.tenantId])).rows);
}

export async function dumpAssets(fx: ContentFixture): Promise<Record<string, unknown>[]> {
  return asTenant(fx.tenantId, async (db) => (await db.query(`SELECT * FROM media_assets WHERE tenant_id = $1 ORDER BY created_at, id`, [fx.tenantId])).rows);
}

export async function getAsset(fx: ContentFixture, id: string): Promise<Record<string, any> | undefined> {
  return asTenant(fx.tenantId, async (db) => (await db.query(`SELECT * FROM media_assets WHERE id = $1`, [id])).rows[0]);
}

export async function auditRows(fx: ContentFixture, action?: string): Promise<Record<string, any>[]> {
  return asTenant(fx.tenantId, async (db) => {
    const { rows } = await db.query(`SELECT * FROM audit_entries WHERE tenant_id = $1 ${action ? "AND action = $2" : ""} ORDER BY at`, action ? [fx.tenantId, action] : [fx.tenantId]);
    return rows;
  });
}

/** Forces a token past its expiry (the CHECK needs created_at moved too). */
export async function expireUploadToken(fx: ContentFixture, tokenId: string): Promise<void> {
  await asTenant(fx.tenantId, async (db) => {
    await db.query(`UPDATE media_upload_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1`, [tokenId]);
  });
}

export interface SeedAssetOpts {
  mime?: string;
  sizeBytes?: number;
  title?: string | null;
  alt?: Record<string, string>;
  tags?: string[];
  originalFilename?: string | null;
  createdAt?: string;
  bucket?: "media" | "video";
  /** Already soft-deleted: deleted_at / purge_after as SQL interval expressions relative to now(), e.g. { deletedAgo: "3 days", purgeIn: "-1 day" }. */
  deleted?: { deletedAgo: string; purgeAfterAgo: string };
  purged?: boolean;
  /** The object key; defaults to a fresh library-shaped one. */
  objectKey?: string;
}

/** Inserts a media_assets row directly (as the migrator), with no stored object. Returns its id and key. */
export async function seedAsset(fx: ContentFixture, o: SeedAssetOpts = {}): Promise<{ id: string; objectKey: string; bucketKey: string }> {
  const id = randomUUID();
  const objectKey = o.objectKey ?? `t/${fx.tenantId}/${fx.siteId}/${randomUUID()}-seed.png`;
  const bucketKey = `${o.bucket ?? "media"}/${objectKey}`;
  await asTenant(fx.tenantId, async (db) => {
    await db.query(
      `INSERT INTO media_assets (id, tenant_id, site_id, bucket_key, mime, size_bytes, scan_status, title, alt, tags, original_filename, created_at,
                                 deleted_at, purge_after, purged_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'clean', $7, $8::jsonb, $9::text[], $10, COALESCE($11::timestamptz, now()),
               ${o.deleted ? `now() - interval '${o.deleted.deletedAgo}'` : "NULL"},
               ${o.deleted ? `now() - interval '${o.deleted.purgeAfterAgo}'` : "NULL"},
               ${o.purged ? "now()" : "NULL"})`,
      [id, fx.tenantId, fx.siteId, bucketKey, o.mime ?? "image/png", o.sizeBytes ?? 100, o.title ?? null, JSON.stringify(o.alt ?? {}), o.tags ?? [], o.originalFilename ?? null, o.createdAt ?? null],
    );
  });
  return { id, objectKey, bucketKey };
}

export const assetUrl = (fx: ContentFixture, assetId: string): string => `/v1/t/${fx.slug}/media/${assetId}`;

/**
 * Inserts a content item (as the migrator) of the fixture's `service` collection with one version whose blocks
 * (and optionally seo) carry `text` wherever the test wants a reference, bypassing the editor's composition
 * checks: the scan under test looks at stored JSON, not at what the editor allows.
 */
export async function seedItem(
  fx: ContentFixture,
  o: { slug: string; blocks?: unknown; seo?: unknown; headBlocks?: unknown; headSeo?: unknown; state?: "draft" | "published" | "scheduled" | "unpublished"; deleted?: boolean; locale?: string; collection?: string },
): Promise<{ itemId: string }> {
  const itemId = randomUUID();
  const state = o.state ?? "draft";
  await asTenant(fx.tenantId, async (db) => {
    // version 1 = the projection (what is live / was published); version 2 = the head when headBlocks is given
    const head = o.headBlocks !== undefined ? 2 : 1;
    await db.query(
      `INSERT INTO content_items (id, tenant_id, site_id, collection_id, locale, slug, blocks, seo, publish_state, published_version, head_version, publish_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, ${state === "scheduled" ? "now() + interval '1 day'" : "NULL"}, ${o.deleted ? "now()" : "NULL"})`,
      [itemId, fx.tenantId, fx.siteId, fx.collections[o.collection ?? "service"], o.locale ?? "en", o.slug, JSON.stringify(o.blocks ?? []), JSON.stringify(o.seo ?? {}), state, state === "published" ? 1 : null, head],
    );
    await db.query(
      `INSERT INTO content_versions (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by) VALUES ($1, $2, 1, $3::jsonb, $4::jsonb, 'draft', 'seed')`,
      [fx.tenantId, itemId, JSON.stringify(o.blocks ?? []), JSON.stringify(o.seo ?? {})],
    );
    if (head === 2) {
      await db.query(
        `INSERT INTO content_versions (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by) VALUES ($1, $2, 2, $3::jsonb, $4::jsonb, 'draft', 'seed')`,
        [fx.tenantId, itemId, JSON.stringify(o.headBlocks), JSON.stringify(o.headSeo ?? {})],
      );
    }
  });
  return { itemId };
}

/** A block carrying an image URL the way the media primitive stores it. */
export const imageBlock = (url: string) => [{ type: "richText", data: { image: { url, alt: "x" } } }];

// ------------------------------------------------------------------------------------------------
// Object storage ground truth (root credentials: an independent witness of what the api left behind)
// ------------------------------------------------------------------------------------------------
const ENDPOINT = process.env.STORAGE_ENDPOINT || "http://127.0.0.1:9000";
export const MEDIA_BUCKET = process.env.STORAGE_BUCKET_MEDIA || "media";

export const rootS3 = () =>
  createS3Client({
    endpoint: ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    accessKeyId: process.env.RUSTFS_ROOT_USER || "webdesk_root",
    secretAccessKey: process.env.RUSTFS_ROOT_PASSWORD || "changeme_root_password",
  });

/** Every stored version and delete marker of exactly `key`. */
export async function listVersions(bucket: string, key: string): Promise<{ versions: string[]; markers: string[] }> {
  const r = await rootS3().send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
  return {
    versions: (r.Versions ?? []).filter((v) => v.Key === key).map((v) => v.VersionId as string),
    markers: (r.DeleteMarkers ?? []).filter((v) => v.Key === key).map((v) => v.VersionId as string),
  };
}

/** Does the key exist as a live object (HEAD)? */
export async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await rootS3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Every object key under a tenant's prefix, versions included: "nothing was stored for this tenant". */
export async function objectKeysUnderTenant(bucket: string, tenantId: string): Promise<string[]> {
  const r = await rootS3().send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `t/${tenantId}/` }));
  return [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].map((v) => v.Key as string);
}

export async function liveObjectKeysUnderTenant(bucket: string, tenantId: string): Promise<string[]> {
  const r = await rootS3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `t/${tenantId}/` }));
  return (r.Contents ?? []).map((o) => o.Key as string);
}

/**
 * Writes `body` as a new version of `key` through the ROOT client with an explicit GOVERNANCE retention that
 * lapses `retainSeconds` from now. (The api's own writes carry the bucket default, one day: nothing the api
 * wrote can be purged inside a test run, which is exactly why the purge tests need an object whose lock is
 * about to lapse.) Returns the version id.
 */
export async function putLockedForSeconds(bucket: string, key: string, body: string, retainSeconds: number): Promise<string> {
  const r = await rootS3().send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "image/png", ObjectLockMode: "GOVERNANCE", ObjectLockRetainUntilDate: new Date(Date.now() + retainSeconds * 1000) }),
  );
  return r.VersionId as string;
}

/** A plain delete (what the api used to do): adds a delete marker, removes no version. */
export async function plainDelete(bucket: string, key: string): Promise<void> {
  await rootS3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
