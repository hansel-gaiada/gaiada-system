// WSK-43a — how a media_assets row is shown to a caller, in ONE place: the public upload route's response and
// the control plane's media.list answer both use it, so they cannot drift.
//
// The canonical URL of a library asset is WebDesk's own media route, `/v1/t/<tenantSlug>/media/<assetId>`
// (a path, no host: the caller knows which WebDesk it asked). That is what the editor writes into a media
// field, and what the in-use scan (control/content/media-usage.ts) looks for inside item content.
import { decodeBucketKey } from "./bucket-key-codec";
import type { MediaAssetRow } from "./dto";

/** `/v1/t/<slug>/media/<assetId>`: the canonical URL of a library asset (D53: the build step resolves it). */
export function canonicalAssetPath(tenantSlug: string, assetId: string): string {
  return `/v1/t/${tenantSlug}/media/${assetId}`;
}

export interface LibraryAsset {
  assetId: string;
  /** Canonical URL path (see canonicalAssetPath). */
  url: string;
  bucket: string | null;
  bucketKey: string;
  mime: string;
  sizeBytes: number;
  scanStatus: string;
  title: string | null;
  /** locale -> alt text; `{}` when none. */
  alt: Record<string, string>;
  tags: string[];
  originalFilename: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (d: Date | string): string => new Date(d).toISOString();

/** A row read with MEDIA_ASSET_COLUMNS, as the caller sees it. */
export function toLibraryAsset(row: MediaAssetRow, tenantSlug: string): LibraryAsset {
  return {
    assetId: row.id,
    url: canonicalAssetPath(tenantSlug, row.id),
    bucket: decodeBucketKey(row.bucket_key)?.bucket ?? null,
    bucketKey: row.bucket_key,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    scanStatus: row.scan_status,
    title: row.title ?? null,
    alt: row.alt ?? {},
    tags: row.tags ?? [],
    originalFilename: row.original_filename ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at),
  };
}
