// WSK-07 — FLAGGED SCHEMA GAP (reported in the ticket output, not fixed here — migrations are out
// of this ticket's owned scope): `media_assets` (0002_content.sql) has exactly one storage
// column, `bucket_key text NOT NULL`, described only as "MinIO object key". It carries NO column
// naming which of the four buckets (media/video/uploads/artifacts) the object lives in — yet the
// S3 API requires the bucket name as a parameter distinct from the object key on every operation
// (put/get/head/delete/presign).
//
// Pragmatic fix used throughout this ticket: `bucket_key` stores `"<bucket>/<objectKey>"` — the
// bucket name as the LITERAL FIRST PATH SEGMENT, encoded and decoded only through this module, so
// there is exactly one place that knows the encoding. A proper `bucket` column is the correct
// long-term fix; recommended as a follow-up DDL note for whoever next touches 0002_content.sql.
import type { BucketName } from "../storage/storage.config";

const KNOWN_BUCKETS: ReadonlySet<string> = new Set<BucketName>(["media", "video", "uploads", "artifacts"]);

export function encodeBucketKey(bucket: BucketName, objectKey: string): string {
  return `${bucket}/${objectKey}`;
}

export function decodeBucketKey(stored: string): { bucket: BucketName; objectKey: string } | null {
  const slash = stored.indexOf("/");
  if (slash <= 0) return null;
  const bucket = stored.slice(0, slash);
  const objectKey = stored.slice(slash + 1);
  if (!KNOWN_BUCKETS.has(bucket) || !objectKey) return null;
  return { bucket: bucket as BucketName, objectKey };
}
