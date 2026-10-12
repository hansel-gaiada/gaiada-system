// M6-P4b0 -- the block library as the fifth artifact against REAL services: Postgres (the composition read) and RustFS
// (the artifacts bucket). SERVICE-BACKED: runs on the Linux gate's containers, same env names and defaults as
// codegen-storage-and-contract-read.spec.ts. Drives generateTenantContract (the function the live worker calls)
// with WEBDESK_BLOCKS_ARTIFACT_DIR pointing at a temp directory that stands in for /app/artifacts/blocks.
//
// The artifacts bucket is object-locked (GOVERNANCE), so objects this spec writes cannot be cleaned up: every run
// uses a fresh random library version (`0.0.0-live.<rand>`) so reruns never collide with earlier ones.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55500/webdesk";
process.env.MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55500/webdesk";
process.env.STORAGE_ENDPOINT = process.env.STORAGE_ENDPOINT || "http://localhost:55501";
process.env.STORAGE_ACCESS_KEY_ID = process.env.STORAGE_ACCESS_KEY_ID || "webdesk_api";
process.env.STORAGE_SECRET_ACCESS_KEY = process.env.STORAGE_SECRET_ACCESS_KEY || "changeme_api_secret_key";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { generateTenantContract } from "../src/codegen/generator/generate-tenant.mts";
import { createGeneratorStorageAdapter, readLatestPointer } from "../src/codegen/generator/storage-io.mts";
import { BlockLibraryHashConflictError, blockLibraryChecksumKey, blockLibraryObjectKey } from "../src/codegen/generator/block-library.mts";
import { S3StorageAdapter } from "../src/storage/s3-storage.adapter";
import { storageConfig } from "../src/storage/storage.config";
import { ContractReadService } from "../src/codegen/contract-read.service";

const migratorPool = new pg.Pool({ connectionString: process.env.MIGRATE_DATABASE_URL });
const appPool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
const BUCKET = () => storageConfig.bucketName("artifacts");
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

async function seedTenant(slug: string): Promise<void> {
  const client = await migratorPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('webdesk.platform_ctx', 'true', true)`);
    const { rows } = await client.query(
      `INSERT INTO tenants (slug, company_ref, default_locale, locales) VALUES ($1, gen_random_uuid(), 'id-ID', ARRAY['id-ID','en-US']) RETURNING id`,
      [slug],
    );
    const id = rows[0].id;
    await client.query("COMMIT");
    await client.query("BEGIN");
    await client.query(`SELECT set_config('webdesk.tenant_ctx', $1, true)`, [id]);
    const { rows: siteRows } = await client.query(`INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [id, slug]);
    await client.query(`INSERT INTO collections (tenant_id, site_id, key, schema) VALUES ($1, $2, 'article', $3)`, [
      id,
      siteRows[0].id,
      JSON.stringify({ blocks: ["richText", "hero"] }),
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** A directory laid out like the image's /app/artifacts/blocks. */
function bakeDir(version: string, bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "blocks-live-"));
  const filename = `gaiada-webdesk-blocks-${version}.tgz`;
  writeFileSync(join(dir, filename), bytes);
  writeFileSync(join(dir, "SHA256SUMS"), `${sha(bytes)}  ${filename}\n`);
  return dir;
}

/** The generator's own adapter, with every put recorded. */
function countingStorage() {
  const storage = createGeneratorStorageAdapter();
  const puts: string[] = [];
  const realPut = storage.putObject.bind(storage);
  storage.putObject = async (bucket: string, key: string, body: Buffer, contentType: string) => {
    puts.push(key);
    return realPut(bucket, key, body, contentType);
  };
  return { storage, puts };
}

describe("block library: the fifth artifact, live", () => {
  const version = `0.0.0-live.${randomUUID().slice(0, 8)}`;
  const bytes = Buffer.from(`block library tarball ${version}`);
  const slugA = `p4b0-a-${randomUUID().slice(0, 8)}`;
  const slugB = `p4b0-b-${randomUUID().slice(0, 8)}`;
  const dirs: string[] = [];

  beforeAll(async () => {
    await seedTenant(slugA);
    await seedTenant(slugB);
  });
  afterEach(() => {
    delete process.env.WEBDESK_BLOCKS_ARTIFACT_DIR;
  });
  afterAll(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await migratorPool.end();
    await appPool.end();
  });

  const bake = (v: string, b: Buffer): void => {
    const dir = bakeDir(v, b);
    dirs.push(dir);
    process.env.WEBDESK_BLOCKS_ARTIFACT_DIR = dir;
  };

  it("a codegen run uploads the tarball once, under the shared key, and the pointer and the contract read carry it", async () => {
    bake(version, bytes);
    const { storage, puts } = countingStorage();
    const result = await generateTenantContract(appPool, storage, slugA);
    expect(result).not.toBeNull();

    const key = blockLibraryObjectKey(version);
    expect(puts.filter((k) => k === key)).toHaveLength(1);
    expect(puts).toContain(blockLibraryChecksumKey(version));

    const pointer = (await readLatestPointer(storage, slugA))!;
    expect(pointer.blockLibrary).toEqual({ package: "@gaiada/webdesk-blocks", version, range: `^${version}` });
    expect(pointer.artifactKeys.blockLibrary).toBe(key);
    expect(pointer.blockLibrarySha256).toBe(sha(bytes));
    // Kept out of the hashed manifest.
    expect(pointer.hashes).not.toHaveProperty("blockLibrary");

    const stored = await storage.getObject(BUCKET(), key);
    expect(sha(stored.body)).toBe(sha(bytes));

    const adapter = new S3StorageAdapter({
      endpoint: storageConfig.endpoint,
      region: storageConfig.region,
      forcePathStyle: storageConfig.forcePathStyle,
      accessKeyId: storageConfig.accessKeyId,
      secretAccessKey: storageConfig.secretAccessKey,
    });
    const read = await new ContractReadService(adapter).readLatest(slugA);
    expect(read!.artifacts.blockLibraryUrl).toContain("X-Amz-Signature");
    const res = await fetch(read!.artifacts.blockLibraryUrl!);
    expect(res.status).toBe(200);
    expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(sha(bytes));
  });

  it("is idempotent: a second run, and a run for another tenant, upload nothing new for the same library", async () => {
    bake(version, bytes);
    const { storage, puts } = countingStorage();
    await generateTenantContract(appPool, storage, slugA); // second run, same tenant
    await generateTenantContract(appPool, storage, slugB); // different tenant, same shared object
    expect(puts.filter((k) => k.startsWith("blocks/"))).toEqual([]);
    const a = (await readLatestPointer(storage, slugA))!;
    const b = (await readLatestPointer(storage, slugB))!;
    expect(a.artifactKeys.blockLibrary).toBe(blockLibraryObjectKey(version));
    expect(b.artifactKeys.blockLibrary).toBe(blockLibraryObjectKey(version));
  });

  it("a DIFFERENT tarball under the same version fails the run loudly, never overwrites, and leaves the pointer as it was", async () => {
    const { storage } = countingStorage();
    const before = (await readLatestPointer(storage, slugA))!;
    bake(version, Buffer.from("different bytes, same version"));
    await expect(generateTenantContract(appPool, storage, slugA)).rejects.toBeInstanceOf(BlockLibraryHashConflictError);

    const stored = await storage.getObject(BUCKET(), blockLibraryObjectKey(version));
    expect(sha(stored.body)).toBe(sha(bytes));
    expect((await readLatestPointer(storage, slugA))!.generatedAt).toBe(before.generatedAt);
  });

  it("with no baked tarball the pointer records no block library (nothing is invented) and the read answers null", async () => {
    process.env.WEBDESK_BLOCKS_ARTIFACT_DIR = join(tmpdir(), `no-blocks-${randomUUID()}`);
    const slugC = `p4b0-c-${randomUUID().slice(0, 8)}`;
    await seedTenant(slugC);
    const { storage, puts } = countingStorage();
    await generateTenantContract(appPool, storage, slugC);
    expect(puts.filter((k) => k.startsWith("blocks/"))).toEqual([]);
    const pointer = (await readLatestPointer(storage, slugC))!;
    expect(pointer.artifactKeys.blockLibrary).toBeUndefined();
    expect(pointer.blockLibrarySha256).toBeUndefined();
    const adapter = new S3StorageAdapter({
      endpoint: storageConfig.endpoint,
      region: storageConfig.region,
      forcePathStyle: storageConfig.forcePathStyle,
      accessKeyId: storageConfig.accessKeyId,
      secretAccessKey: storageConfig.secretAccessKey,
    });
    expect((await new ContractReadService(adapter).readLatest(slugC))!.artifacts.blockLibraryUrl).toBeNull();
  });
});
