// WSK-52 (WSK-D42) — RustFS replaces MinIO. Live integration against a real RustFS that
// webdesk/scripts/storage-bootstrap.mjs has already provisioned (CI `webdesk-api` job runs it before
// the suite). Proves, through the S3 API only (RustFS ships no `mc`):
//   * the service key is mandatory — no fallback to the storage ROOT credential;
//   * every presigning client sets requestChecksumCalculation: "WHEN_REQUIRED" (the default SDK client
//     bakes a placeholder x-amz-checksum-crc32 into presigned PUT URLs — the control below);
//   * presigned PUT + GET round-trip;
//   * the bootstrap is idempotent (second run: changes=0);
//   * versioning is ON and a GOVERNANCE-locked version cannot be deleted (negative control: the
//     same delete on an UNLOCKED bucket succeeds), overwrite keeps the locked version intact;
//   * the service key cannot PutBucketPolicy / CreateBucket / change versioning;
//   * anonymous read works only on the prefix a public-read policy grants.
// Locked objects cannot be cleaned up for LOCK_DAYS — every key is unique per run, nothing relies on
// a clean bucket.
import { describe, expect, it, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3StorageAdapter, createS3Client } from "../src/storage/s3-storage.adapter";
import { storageConfig } from "../src/storage/storage.config";

const ENDPOINT = process.env.STORAGE_ENDPOINT || "http://127.0.0.1:9000";
const SVC_KEY = process.env.STORAGE_ACCESS_KEY_ID || "webdesk_api";
const SVC_SECRET = process.env.STORAGE_SECRET_ACCESS_KEY || "changeme_api_secret_key";
const ROOT_KEY = process.env.RUSTFS_ROOT_USER || "webdesk_root";
const ROOT_SECRET = process.env.RUSTFS_ROOT_PASSWORD || "changeme_root_password";
const ARTIFACTS = process.env.STORAGE_BUCKET_ARTIFACTS || "artifacts";
const MEDIA = process.env.STORAGE_BUCKET_MEDIA || "media";
const BOOTSTRAP = join(__dirname, "..", "..", "scripts", "storage-bootstrap.mjs");
const tag = randomUUID().slice(0, 8);

const svcCfg = { endpoint: ENDPOINT, region: "us-east-1", forcePathStyle: true, accessKeyId: SVC_KEY, secretAccessKey: SVC_SECRET };
const svc = createS3Client(svcCfg);
const root = createS3Client({ ...svcCfg, accessKeyId: ROOT_KEY, secretAccessKey: ROOT_SECRET });

function runBootstrap(extraEnv: Record<string, string> = {}, drop: string[] = []): string {
  const env: Record<string, string | undefined> = {
    ...process.env,
    STORAGE_ENDPOINT: ENDPOINT,
    RUSTFS_ROOT_USER: ROOT_KEY,
    RUSTFS_ROOT_PASSWORD: ROOT_SECRET,
    STORAGE_ACCESS_KEY_ID: SVC_KEY,
    STORAGE_SECRET_ACCESS_KEY: SVC_SECRET,
    ...extraEnv,
  };
  for (const d of drop) delete env[d];
  return execFileSync(process.execPath, [BOOTSTRAP], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
}
const changesOf = (out: string) => Number(/STORAGE_BOOTSTRAP changes=(\d+)/.exec(out)?.[1] ?? NaN);

async function denied(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    return `${err.name}/${err.$metadata?.httpStatusCode}`;
  }
  return "NOT_DENIED";
}

describe("WSK-52 — storage config refuses a missing or root service key", () => {
  it("throws when STORAGE_ACCESS_KEY_ID / SECRET are unset (any NODE_ENV) and when the key is the root user", () => {
    const saved = { id: process.env.STORAGE_ACCESS_KEY_ID, sec: process.env.STORAGE_SECRET_ACCESS_KEY, root: process.env.RUSTFS_ROOT_USER };
    try {
      delete process.env.STORAGE_ACCESS_KEY_ID;
      delete process.env.STORAGE_SECRET_ACCESS_KEY;
      expect(() => storageConfig.accessKeyId).toThrow(/STORAGE_ACCESS_KEY_ID is not set/);
      expect(() => storageConfig.secretAccessKey).toThrow(/STORAGE_SECRET_ACCESS_KEY is not set/);
      process.env.STORAGE_ACCESS_KEY_ID = "the-root-user";
      process.env.RUSTFS_ROOT_USER = "the-root-user";
      expect(() => storageConfig.accessKeyId).toThrow(/equals RUSTFS_ROOT_USER/);
    } finally {
      for (const [k, v] of [["STORAGE_ACCESS_KEY_ID", saved.id], ["STORAGE_SECRET_ACCESS_KEY", saved.sec], ["RUSTFS_ROOT_USER", saved.root]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("WSK-52 — presigned URLs against RustFS", () => {
  it("createS3Client sets requestChecksumCalculation WHEN_REQUIRED (would fail if the option were dropped)", async () => {
    expect(await svc.config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
    const defaultClient = new S3Client({ endpoint: ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: SVC_KEY, secretAccessKey: SVC_SECRET } });
    expect(await defaultClient.config.requestChecksumCalculation()).not.toBe("WHEN_REQUIRED");
  });

  it("presigned PUT then presigned GET round-trips; the PUT URL carries no placeholder checksum", async () => {
    const adapter = new S3StorageAdapter(svcCfg);
    const key = `wsk52/presign-${tag}.txt`;
    const putUrl = await adapter.presignPutObject(ARTIFACTS, key, "text/plain", 120);
    expect(putUrl.toLowerCase()).not.toContain("x-amz-checksum");
    const put = await fetch(putUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "presigned body" });
    expect(put.status).toBe(200);
    const getUrl = await adapter.presignGetObject(ARTIFACTS, key, 120);
    const got = await fetch(getUrl);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("presigned body");
  }, 30_000);

  it("CONTROL: an SDK-default client bakes a placeholder x-amz-checksum-crc32 into the presigned PUT URL (what the option removes)", async () => {
    const defaultClient = new S3Client({ endpoint: ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: SVC_KEY, secretAccessKey: SVC_SECRET } });
    const url = await getSignedUrl(defaultClient, new PutObjectCommand({ Bucket: ARTIFACTS, Key: `wsk52/control-${tag}.txt`, ContentType: "text/plain" }), { expiresIn: 120 });
    expect(url.toLowerCase()).toContain("x-amz-checksum-crc32");
    // NOTE (measured 2026-10-10, rustfs/rustfs:1.0.0 + SDK 3.1118.0): RustFS did NOT reject this
    // URL's PUT with 400 BadDigest as the WSK-D42 research recorded — it accepted it (200). The
    // option is kept as the ruled, harmless defence (the param is useless noise and a stricter
    // RustFS build could validate it); this control only proves what the option changes.
  }, 30_000);
});

describe("WSK-52 — bootstrap, versioning, object lock, least privilege", () => {
  const unlockedBucket = `wsk52-unlocked-${tag}`;
  afterAll(async () => {
    // Remove the unlocked control bucket (its versions are deletable by root — that is the point).
    await root.send(new DeleteBucketCommand({ Bucket: unlockedBucket })).catch(() => {});
  });

  it("running the bootstrap again changes nothing", () => {
    const out = runBootstrap();
    expect(changesOf(out)).toBe(0);
  }, 60_000);

  it("versioning is Enabled and a GOVERNANCE-locked version cannot be deleted; overwrite preserves it", async () => {
    const ver = await svc.send(new GetBucketVersioningCommand({ Bucket: ARTIFACTS })).catch(() => null);
    // The service key may not be allowed GetBucketVersioning (least privilege) — fall back to root.
    const status = ver?.Status ?? (await root.send(new GetBucketVersioningCommand({ Bucket: ARTIFACTS }))).Status;
    expect(status).toBe("Enabled");

    const key = `wsk52/locked-${tag}.txt`;
    const v1 = await svc.send(new PutObjectCommand({ Bucket: ARTIFACTS, Key: key, Body: "version one", ContentType: "text/plain" }));
    expect(v1.VersionId).toBeTruthy();
    const head = await svc.send(new HeadObjectCommand({ Bucket: ARTIFACTS, Key: key, VersionId: v1.VersionId }));
    expect(head.ObjectLockMode).toBe("GOVERNANCE");
    expect(head.ObjectLockRetainUntilDate).toBeInstanceOf(Date);

    // The service key is refused outright (policy has no DeleteObjectVersion) ...
    expect(await denied(svc.send(new DeleteObjectCommand({ Bucket: ARTIFACTS, Key: key, VersionId: v1.VersionId })))).toMatch(/AccessDenied|403/);
    // ... and so is ROOT without the governance bypass: the LOCK, not the policy, is the barrier.
    expect(await denied(root.send(new DeleteObjectCommand({ Bucket: ARTIFACTS, Key: key, VersionId: v1.VersionId })))).toMatch(/AccessDenied|403/);

    // Overwrite = a new version; the locked one is untouched and still readable by id.
    const v2 = await svc.send(new PutObjectCommand({ Bucket: ARTIFACTS, Key: key, Body: "version two", ContentType: "text/plain" }));
    expect(v2.VersionId).toBeTruthy();
    expect(v2.VersionId).not.toBe(v1.VersionId);
    // (reading a specific version needs s3:GetObjectVersion, which the api policy does not grant — root reads it)
    expect(await denied(svc.send(new GetObjectCommand({ Bucket: ARTIFACTS, Key: key, VersionId: v1.VersionId })))).toMatch(/AccessDenied|403/);
    const old = await root.send(new GetObjectCommand({ Bucket: ARTIFACTS, Key: key, VersionId: v1.VersionId }));
    expect(await old.Body!.transformToString()).toBe("version one");

    // A plain delete (what the api does) only adds a delete marker; the locked version survives.
    await svc.send(new DeleteObjectCommand({ Bucket: ARTIFACTS, Key: key }));
    const still = await root.send(new GetObjectCommand({ Bucket: ARTIFACTS, Key: key, VersionId: v1.VersionId }));
    expect(await still.Body!.transformToString()).toBe("version one");
  }, 60_000);

  it("NEGATIVE CONTROL: the same root version-delete SUCCEEDS on a versioned bucket that has no lock", async () => {
    await root.send(new CreateBucketCommand({ Bucket: unlockedBucket }));
    await root.send(new PutBucketVersioningCommand({ Bucket: unlockedBucket, VersioningConfiguration: { Status: "Enabled" } }));
    const put = await root.send(new PutObjectCommand({ Bucket: unlockedBucket, Key: "k", Body: "x" }));
    expect(put.VersionId).toBeTruthy();
    await root.send(new DeleteObjectCommand({ Bucket: unlockedBucket, Key: "k", VersionId: put.VersionId }));
    await expect(root.send(new GetObjectCommand({ Bucket: unlockedBucket, Key: "k", VersionId: put.VersionId }))).rejects.toBeTruthy();
  }, 30_000);

  it("the service key is refused PutBucketPolicy, CreateBucket and PutBucketVersioning", async () => {
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: ["*"] }, Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${ARTIFACTS}/*`] }] });
    expect(await denied(svc.send(new PutBucketPolicyCommand({ Bucket: ARTIFACTS, Policy: policy })))).toMatch(/AccessDenied|403/);
    expect(await denied(svc.send(new CreateBucketCommand({ Bucket: `wsk52-svc-${tag}` })))).toMatch(/AccessDenied|403/);
    expect(await denied(svc.send(new PutBucketVersioningCommand({ Bucket: ARTIFACTS, VersioningConfiguration: { Status: "Suspended" } })))).toMatch(/AccessDenied|403/);
  }, 30_000);

  it("anonymous read works only on the prefix a public-read policy grants, and is removed when the policy is", async () => {
    const pubPrefix = `t/wsk52-public-${tag}`;
    const privKey = `t/wsk52-private-${tag}/o.txt`;
    const pubKey = `${pubPrefix}/o.txt`;
    await svc.send(new PutObjectCommand({ Bucket: MEDIA, Key: pubKey, Body: "public", ContentType: "text/plain" }));
    await svc.send(new PutObjectCommand({ Bucket: MEDIA, Key: privKey, Body: "private", ContentType: "text/plain" }));
    const anon = (k: string) => fetch(`${ENDPOINT}/${MEDIA}/${k}`).then((r) => r.status);

    expect(await anon(pubKey)).toBe(403); // no policy yet
    try {
      const out = runBootstrap({ WEBDESK_STORAGE_PUBLIC_READ: `${MEDIA}:${pubPrefix}` });
      expect(changesOf(out)).toBeGreaterThanOrEqual(1);
      expect(await anon(pubKey)).toBe(200);
      expect(await anon(privKey)).toBe(403);
      // idempotent with the policy in place
      expect(changesOf(runBootstrap({ WEBDESK_STORAGE_PUBLIC_READ: `${MEDIA}:${pubPrefix}` }))).toBe(0);
    } finally {
      runBootstrap({}, ["WEBDESK_STORAGE_PUBLIC_READ"]); // restore: no public read
    }
    expect(await anon(pubKey)).toBe(403);
  }, 90_000);
});
