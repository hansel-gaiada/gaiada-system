// WSK-38 — the ONLY file in this module that talks to storage/**, exactly the seam
// storage/storage.types.ts's own header describes callers should use ("the one seam every caller
// ... is allowed to depend on"). Deliberately does NOT go through media/media.service.ts: that
// service's constructor also pulls in ClamAvService + QuotaService (upload-time concerns this
// module never exercises — privacy/** only ever READS or DELETES an already-scanned, already-
// quota-accounted object), which would drag ClamAV/quota config into every privacy test for no
// reason. Direct STORAGE_ADAPTER + media_assets.bucket_key decoding (bucket-key-codec.ts, imported
// read-only — see media/dto.ts's own header on why bucket_key needs decoding at all) is the
// smaller, honest dependency.
import { Inject, Injectable, Logger } from "@nestjs/common";
import { STORAGE_ADAPTER } from "../storage/storage.tokens";
import type { StorageAdapter } from "../storage/storage.types";
import { storageConfig, PRIVATE_BUCKETS } from "../storage/storage.config";
import { decodeBucketKey } from "../media/bucket-key-codec";
import type { MediaAssetLookupRow } from "./privacy.repository";

export type ExportedAttachment = {
  mediaAssetId: string;
  mime: string;
  sizeBytes: number;
  contentBase64: string | null;
  /** Set when the object could not be fetched (already deleted by a prior erase/purge, or a
   *  storage-layer error) — export degrades PER-ATTACHMENT rather than failing the whole bundle. */
  unavailableReason: string | null;
};

@Injectable()
export class PrivacyAttachmentsService {
  private readonly logger = new Logger(PrivacyAttachmentsService.name);

  constructor(@Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter) {}

  /** Attachments live in the PRIVATE `uploads` bucket only (design charter / WSK-07) — any other
   *  bucket on a media_assets row here would be a data-model surprise worth refusing loudly rather
   *  than silently fetching/deleting from the wrong place. */
  private decodePrivate(row: MediaAssetLookupRow): { bucket: string; objectKey: string } {
    const decoded = decodeBucketKey(row.bucket_key);
    if (!decoded || !PRIVATE_BUCKETS.has(decoded.bucket)) {
      throw new Error(`media_assets ${row.id}: bucket_key '${row.bucket_key}' does not decode to a PRIVATE bucket`);
    }
    return { bucket: storageConfig.bucketName(decoded.bucket), objectKey: decoded.objectKey };
  }

  async fetchForExport(row: MediaAssetLookupRow): Promise<ExportedAttachment> {
    try {
      const { bucket, objectKey } = this.decodePrivate(row);
      const result = await this.storage.getObject(bucket, objectKey);
      return {
        mediaAssetId: row.id,
        mime: row.mime,
        sizeBytes: Number(row.size_bytes),
        contentBase64: result.body.toString("base64"),
        unavailableReason: null,
      };
    } catch (err) {
      this.logger.warn(`export: attachment ${row.id} unavailable: ${String(err)}`);
      return {
        mediaAssetId: row.id,
        mime: row.mime,
        sizeBytes: Number(row.size_bytes),
        contentBase64: null,
        unavailableReason: "object could not be retrieved (already removed or a storage error)",
      };
    }
  }

  /**
   * Deletes the underlying object. Called BEFORE the DB transaction that scrubs `submissions` and
   * removes the `media_assets` row (privacy.service.ts's `erase()`) — the opposite ordering from
   * media.service.ts's own upload path ("store then record"), and deliberately so: an erasure's
   * worst failure mode is a live copy of a person's file with NO db row pointing at it (nobody
   * would ever know to delete it), which is worse than an orphaned db row pointing at an
   * already-gone object (that fails loud and cleanly on next access). So storage delete happens
   * first, and a failure here MUST abort the whole erase before any row is touched — see
   * privacy.service.ts.
   */
  async deleteForErase(row: MediaAssetLookupRow): Promise<void> {
    const { bucket, objectKey } = this.decodePrivate(row);
    await this.storage.deleteObject(bucket, objectKey);
  }
}
