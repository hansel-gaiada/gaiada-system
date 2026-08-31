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
};
