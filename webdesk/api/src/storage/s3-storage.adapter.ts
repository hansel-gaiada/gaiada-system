// WSK-07 — the ONE concrete `StorageAdapter` implementation. Built on the OFFICIAL AWS SDK v3 S3
// client — not a MinIO-branded SDK — precisely because that client speaks the generic S3 API that
// MinIO, Cloudflare R2, and AWS S3 all implement; the only thing that changes between them is the
// constructor config (`endpoint`, `region`, `forcePathStyle`, credentials), which is exactly what
// `storage.config.ts` centralizes. That is the whole "config only" swap the design (§11a/WSK-D23)
// requires, made mechanically true rather than aspirational: nothing below branches on which
// provider it is talking to.
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  EnsureBucketOptions,
  GetObjectResult,
  HeadObjectResult,
  PutObjectResult,
  StorageAdapter,
} from "./storage.types";

export type S3StorageAdapterConfig = {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
};

export class S3StorageAdapter implements StorageAdapter {
  readonly providerName = "s3-api";
  private readonly client: S3Client;

  constructor(cfg: S3StorageAdapterConfig) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<PutObjectResult> {
    const result = await this.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return { etag: result.ETag };
  }

  async getObject(bucket: string, key: string): Promise<GetObjectResult> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToBuffer(result.Body as NodeJS.ReadableStream);
    return { body, contentType: result.ContentType, contentLength: result.ContentLength };
  }

  async headObject(bucket: string, key: string): Promise<HeadObjectResult> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { contentType: result.ContentType, contentLength: result.ContentLength };
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async presignGetObject(bucket: string, key: string, expiresInSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async ensureBucket(bucket: string, options: EnsureBucketOptions = {}): Promise<void> {
    const exists = await this.bucketExists(bucket);
    if (!exists) {
      await this.client.send(
        new CreateBucketCommand({
          Bucket: bucket,
          // Object lock can ONLY be enabled at creation time (S3-API rule, not MinIO-specific) —
          // this is why `ensureBucket` must decide it up front rather than as a later step.
          ObjectLockEnabledForBucket: options.objectLock === true,
        }),
      );
    }

    if (options.versioning) {
      // Object lock requires versioning to be enabled first — order matters.
      await this.client
        .send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }))
        .catch((err) => {
          // "where MinIO supports it" (§11a wording) — a provider/edition that rejects this call
          // must not take the whole boot down; ensureBucket runs on every start.
          // eslint-disable-next-line no-console
          console.warn(`[webdesk:storage] bucket '${bucket}': versioning enable failed: ${String(err)}`);
        });
    }

    if (options.objectLock && !exists) {
      // Only meaningful for a bucket THIS call just created with ObjectLockEnabledForBucket —
      // enabling it after the fact on a pre-existing bucket is not possible via the S3 API.
      await this.client
        .send(
          new PutObjectLockConfigurationCommand({
            Bucket: bucket,
            ObjectLockConfiguration: {
              ObjectLockEnabled: "Enabled",
              Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: 1 } },
            },
          }),
        )
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(`[webdesk:storage] bucket '${bucket}': object-lock config failed: ${String(err)}`);
        });
    }
  }

  private async bucketExists(bucket: string): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch (err: unknown) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === "string") chunks.push(Buffer.from(chunk, "utf8"));
    else chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
