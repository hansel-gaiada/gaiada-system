import type { BucketName } from "../storage/storage.config";

export type UploadMediaBody = {
  filename?: string;
  contentType?: string;
  /** Base64-encoded file bytes. See media.controller.ts's header for why this ticket accepts
   *  base64-JSON rather than multipart/streaming (app.ts/main.ts bootstrap is out of this ticket's
   *  owned scope, and that is where a streaming multipart plugin would need to be registered). */
  contentBase64?: string;
};

export type UploadMediaResult = {
  id: string;
  bucket: BucketName;
  bucketKey: string;
  mime: string;
  sizeBytes: number;
  scanStatus: string;
  createdAt: string;
};

export type MediaAssetRow = {
  id: string;
  tenant_id: string;
  site_id: string;
  bucket_key: string;
  mime: string;
  size_bytes: string; // bigint comes back as string from pg
  scan_status: string;
  created_at: string;
  // The library columns (migration 0014). Present on rows read with MEDIA_ASSET_COLUMNS.
  title?: string | null;
  alt?: Record<string, string>;
  tags?: string[];
  original_filename?: string | null;
  width?: number | null;
  height?: number | null;
  updated_at?: string;
  created_by?: string | null;
  // M5-W1q (migration 0020): the review state and who judged it. Present on rows read with MEDIA_ASSET_COLUMNS.
  review_state?: "accepted" | "quarantined" | "rejected";
  reviewed_by?: string | null;
  reviewed_at?: string | null;
};
