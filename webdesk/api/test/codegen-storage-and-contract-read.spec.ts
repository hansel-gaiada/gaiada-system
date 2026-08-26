// WSK-15 — live integration: real Postgres (composition read) + real MinIO (artifact store),
// exercising `run-codegen`'s own building blocks directly (fetch -> build -> publish) and then
// `ContractReadService` (the NestJS-facing read side) against what was actually published.
// Every env var below is the REAL name the app code reads (`APP_DATABASE_URL`, `MIGRATE_DATABASE_URL`,
// `STORAGE_*`) — no WSK15_-prefixed shadow variable, per this ticket's own instruction and the
// project's own accumulated lesson (README's "Test-harness env naming is fragmenting" note).
// See ../README.md's WSK-15 section for the exact container/port runbook this defaults against.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55500/webdesk";
process.env.MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55500/webdesk";
process.env.STORAGE_ENDPOINT = process.env.STORAGE_ENDPOINT || "http://localhost:55501";
process.env.STORAGE_ACCESS_KEY_ID = process.env.STORAGE_ACCESS_KEY_ID || "webdesk_minio";
process.env.STORAGE_SECRET_ACCESS_KEY = process.env.STORAGE_SECRET_ACCESS_KEY || "changeme_minio_password";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { fetchTenantComposition } from "../src/codegen/generator/fetch-composition.mts";
import { buildContractArtifacts } from "../src/codegen/generator/build-artifacts.mts";
import { createGeneratorStorageAdapter, readLatestPointer, publishArtifacts } from "../src/codegen/generator/storage-io.mts";
// This spec file only ever runs under vitest/Vite (never `tsx`), which DOES split commonjs named
// exports out normally — see cjs-interop.mts's header for why the generator source itself cannot
// assume that and uses the helper instead.
import { S3StorageAdapter } from "../src/storage/s3-storage.adapter";
import { storageConfig } from "../src/storage/storage.config";
import { artifactKey } from "../src/codegen/artifact-keys";
import { ContractReadService } from "../src/codegen/contract-read.service";

const migratorPool = new pg.Pool({ connectionString: process.env.MIGRATE_DATABASE_URL });
const appPool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
let tenantSlug: string;
let tenantId: string;

async function seedTenant(slug: string) {
  // `set_config(..., true)` (SET LOCAL semantics) only survives to the END of the CURRENT
  // transaction — with `pg` running each statement in its own implicit autocommit transaction
  // absent an explicit BEGIN, a `true`-flagged GUC set on one query would already be gone by the
  // very next query. Explicit BEGIN/COMMIT per phase, matching fetch-composition.mts's own
  // pattern, is what makes the `true` (transaction-local) flag actually hold across the GUC-set +
  // the query it is meant to gate.
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
    return id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

describe("codegen — live DB + MinIO integration", () => {
  beforeAll(async () => {
    tenantSlug = `wsk15-live-${randomUUID().slice(0, 8)}`;
    tenantId = await seedTenant(tenantSlug);
  });

  afterAll(async () => {
    await migratorPool.end();
    await appPool.end();
  });

  it("fetchTenantComposition resolves the real tenant + its composition, excluding `redirect`", async () => {
    const fetched = await fetchTenantComposition(appPool, tenantSlug);
    expect(fetched).not.toBeNull();
    expect(fetched!.tenantId).toBe(tenantId);
    expect(fetched!.defaultLocale).toBe("id-ID");
    expect(fetched!.composition.article).toEqual({ blocks: ["richText", "hero"] });
    expect(fetched!.composition.redirect).toBeUndefined();
  });

  it("fetchTenantComposition returns null for an unknown/inactive tenant slug", async () => {
    const fetched = await fetchTenantComposition(appPool, "no-such-tenant-at-all");
    expect(fetched).toBeNull();
  });

  it("run the real pipeline end to end: fetch -> build -> publish -> ContractReadService reads it back", async () => {
    const fetched = await fetchTenantComposition(appPool, tenantSlug);
    const built = await buildContractArtifacts({
      tenantSlug,
      defaultLocale: fetched!.defaultLocale,
      locales: fetched!.locales,
      composition: fetched!.composition,
      previous: null,
    });

    const storage = createGeneratorStorageAdapter();
    const pointer = await publishArtifacts(storage, tenantSlug, built);
    expect(pointer.contractVersion).toBe("1.0.0");
    expect(pointer.contentHash).toBe(built.contentHash);

    const readBack = await readLatestPointer(storage, tenantSlug);
    expect(readBack).toEqual(pointer);

    // The NestJS-facing read side, constructed directly (no Nest DI container needed — see
    // contract-read.service.ts's own constructor: one injected dependency, trivially satisfied here).
    const adapter = new S3StorageAdapter({
      endpoint: process.env.STORAGE_ENDPOINT!,
      region: "us-east-1",
      forcePathStyle: true,
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
    });
    const contractRead = new ContractReadService(adapter);
    const response = await contractRead.readLatest(tenantSlug);

    expect(response).not.toBeNull();
    expect(response!.version).toBe("1.0.0");
    expect(response!.vocabularyVersion).toBe("1.0.0");
    expect(response!.contentHash).toBe(built.contentHash);
    expect(response!.artifacts.sdkPhpUrl).toBeNull();
    expect(response!.artifacts.openapiUrl).toContain("X-Amz-Signature");

    // The presigned URL is a REAL, fetchable link to the REAL bytes just published.
    const fetchedOpenapi = await fetch(response!.artifacts.openapiUrl);
    expect(fetchedOpenapi.status).toBe(200);
    const openapiBody = await fetchedOpenapi.text();
    expect(openapiBody).toBe(built.openapiJson);
  });

  it("ContractReadService.readLatest returns null for a tenant that has never been generated", async () => {
    const storage = createGeneratorStorageAdapter();
    const adapter = new S3StorageAdapter({
      endpoint: process.env.STORAGE_ENDPOINT!,
      region: "us-east-1",
      forcePathStyle: true,
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
    });
    const contractRead = new ContractReadService(adapter);
    const response = await contractRead.readLatest(`never-generated-${randomUUID()}`);
    expect(response).toBeNull();
    void storage;
  });

  it("ContractReadService.readLatest returns null (never throws) when the artifacts bucket itself does not exist — regression for a bug WSK-22's own test run surfaced live", async () => {
    // `storageConfig.bucketName("artifacts")` reads `MINIO_BUCKET_ARTIFACTS` as a live getter —
    // pointing it at a bucket that was NEVER created (skipping `ensureBucket`) reproduces exactly
    // the failure mode WSK-22 observed against a throwaway stack with no artifact store bootstrap:
    // an unrecognized SDK error from `@aws-sdk/middleware-sdk-s3` instead of a clean 404. Before
    // this ticket's fix, `readLatest` propagated that error; it must now return `null`.
    const previous = process.env.MINIO_BUCKET_ARTIFACTS;
    process.env.MINIO_BUCKET_ARTIFACTS = `wsk15-bucket-that-was-never-created-${randomUUID().slice(0, 8)}`;
    try {
      const adapter = new S3StorageAdapter({
        endpoint: process.env.STORAGE_ENDPOINT!,
        region: "us-east-1",
        forcePathStyle: true,
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
      });
      const contractRead = new ContractReadService(adapter);
      await expect(contractRead.readLatest(tenantSlug)).resolves.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.MINIO_BUCKET_ARTIFACTS;
      else process.env.MINIO_BUCKET_ARTIFACTS = previous;
    }
  });

  it("a second generation with an unchanged composition bumps PATCH and re-publishes under a new immutable version prefix", async () => {
    const fetched = await fetchTenantComposition(appPool, tenantSlug);
    const storage = createGeneratorStorageAdapter();
    const previousPointer = await readLatestPointer(storage, tenantSlug);
    const built = await buildContractArtifacts({
      tenantSlug,
      defaultLocale: fetched!.defaultLocale,
      locales: fetched!.locales,
      composition: fetched!.composition,
      previous: { version: previousPointer!.contractVersion, snapshot: previousPointer!.compositionSnapshot as never },
    });
    expect(built.contractVersion).toBe("1.0.1");
    const pointer = await publishArtifacts(storage, tenantSlug, built);
    expect(pointer.artifactKeys.openapiJson).toContain("/1.0.1/");

    // The OLD version's artifacts are still there, byte-identical to what they were minted with
    // (§06: "an existing row with a different hash — determinism breach" — the immutable prefix is
    // what makes a re-fetch of version 1.0.0 always return the SAME bytes even after 1.0.1 exists).
    const oldObj = await storage.getObject(storageConfig.bucketName("artifacts"), artifactKey(tenantSlug, "1.0.0", "openapiJson"));
    expect(oldObj.body.toString("utf8")).not.toContain('"version": "1.0.1"');
    expect(oldObj.body.toString("utf8")).toContain('"version": "1.0.0"');
  });
});
