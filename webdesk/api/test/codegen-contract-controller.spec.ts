// WSK-15 — full NestJS integration for `GET /control/v1/tenants/:slug/contract`: boots the REAL
// `ControlModule` (same pattern as WSK-21's own `control-commands.spec.ts`), drives it through
// the dev-mode control-channel stub (WSK-22 replaces the auth layer, not this ticket's job), and
// proves the endpoint now does what design §06 specifies instead of WSK-21's old blanket 501 —
// including the audit row every command (this one included, per WSK-21's own command list) must
// write.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55500/webdesk";
process.env.MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55500/webdesk";
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "wsk15-test-pepper-never-used-outside-this-suite";
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "1000";
process.env.STORAGE_ENDPOINT = process.env.STORAGE_ENDPOINT || "http://localhost:55501";
process.env.STORAGE_ACCESS_KEY_ID = process.env.STORAGE_ACCESS_KEY_ID || "webdesk_minio";
process.env.STORAGE_SECRET_ACCESS_KEY = process.env.STORAGE_SECRET_ACCESS_KEY || "changeme_minio_password";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ControlModule } from "../src/control/control.module";
import { fetchTenantComposition } from "../src/codegen/generator/fetch-composition.mts";
import { buildContractArtifacts } from "../src/codegen/generator/build-artifacts.mts";
import { createGeneratorStorageAdapter, publishArtifacts } from "../src/codegen/generator/storage-io.mts";
import pg from "pg";

const MIGRATOR_URL = process.env.MIGRATE_DATABASE_URL!;
const appPool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL! });

async function buildControlApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ControlModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  return app;
}

function headers(scopes: string[], subject = "wsk15-contract-test") {
  return { "x-webdesk-control-principal": subject, "x-webdesk-control-scopes": scopes.join(",") };
}

async function seedTenantWithComposition(slug: string) {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('webdesk.platform_ctx', 'true', true)`);
    const { rows } = await client.query(
      `INSERT INTO tenants (slug, company_ref, default_locale, locales) VALUES ($1, gen_random_uuid(), 'id-ID', ARRAY['id-ID']) RETURNING id`,
      [slug],
    );
    const tenantId = rows[0].id;
    await client.query("COMMIT");

    await client.query("BEGIN");
    await client.query(`SELECT set_config('webdesk.tenant_ctx', $1, true)`, [tenantId]);
    const { rows: siteRows } = await client.query(`INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [
      tenantId,
      slug,
    ]);
    await client.query(`INSERT INTO collections (tenant_id, site_id, key, schema) VALUES ($1, $2, 'article', $3)`, [
      tenantId,
      siteRows[0].id,
      JSON.stringify({ blocks: ["richText"] }),
    ]);
    await client.query("COMMIT");
    return tenantId;
  } finally {
    await client.end();
  }
}

/** `audit_entries` rows for a real command (`CommandAuditService.recordTenant`) carry a non-null
 *  `tenant_id` — reading them back needs `webdesk.tenant_ctx`, NOT `webdesk.platform_ctx` (that
 *  GUC only admits the tenant_id-IS-NULL platform-level rows, per 0001's own dual-mode policy —
 *  see control-commands.spec.ts's identically-named-but-differently-scoped helper for the
 *  platform-level case, which this endpoint's command is not). */
async function withTenant<T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

describe("GET /control/v1/tenants/:slug/contract (WSK-15 replacing WSK-21's 501)", () => {
  let app: NestFastifyApplication;
  let generatedSlug: string;
  let generatedTenantId: string;
  let ungeneratedSlug: string;

  beforeAll(async () => {
    app = await buildControlApp();

    generatedSlug = `wsk15-ctrl-gen-${randomUUID().slice(0, 8)}`;
    generatedTenantId = await seedTenantWithComposition(generatedSlug);
    const fetched = await fetchTenantComposition(appPool, generatedSlug);
    const built = await buildContractArtifacts({
      tenantSlug: generatedSlug,
      defaultLocale: fetched!.defaultLocale,
      locales: fetched!.locales,
      composition: fetched!.composition,
      previous: null,
    });
    await publishArtifacts(createGeneratorStorageAdapter(), generatedSlug, built);

    ungeneratedSlug = `wsk15-ctrl-nogen-${randomUUID().slice(0, 8)}`;
    await seedTenantWithComposition(ungeneratedSlug);
  });

  afterAll(async () => {
    await app.close();
    await appPool.end();
  });

  it("serves the design §06 shape for a tenant with a real generated contract", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/control/v1/tenants/${generatedSlug}/contract`,
      headers: headers(["webdesk:read"]),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe("1.0.0");
    expect(body.vocabularyVersion).toBe("1.0.0");
    expect(body.blockLibrary).toEqual({ package: "@gaiada/webdesk-blocks", version: "0.0.0-pending-wsk16", range: "^0.0.0-pending-wsk16" });
    expect(body.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(typeof body.generatedAt).toBe("string");
    expect(body.artifacts.sdkPhpUrl).toBeNull();
    expect(body.artifacts.openapiUrl).toContain(`contracts/${generatedSlug}/1.0.0/openapi.v1.json`);
    expect(body.artifacts.sdkTsUrl).toContain(`contracts/${generatedSlug}/1.0.0/sdk.d.ts`);
    expect(body.artifacts.contractMdUrl).toContain(`contracts/${generatedSlug}/1.0.0/CONTENT-CONTRACT.md`);

    // The pre-signed URL is real and fetchable — proves the endpoint is not just echoing a claim.
    const fetched = await fetch(body.artifacts.openapiUrl);
    expect(fetched.status).toBe(200);
  });

  it("404s with a documented RFC-9457-shaped body (not the old blanket 501) when no contract has been generated yet", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/control/v1/tenants/${ungeneratedSlug}/contract`,
      headers: headers(["webdesk:read"]),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.type).toBe("https://webdesk.gaiada.online/errors/contract-not-generated");
    expect(body.status).toBe(404);
    expect(body.instance).toBe(`/control/v1/tenants/${ungeneratedSlug}/contract`);
  });

  it("404s for an unknown tenant slug (never leaks tenant existence via a different status)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/control/v1/tenants/no-such-tenant-${randomUUID()}/contract`,
      headers: headers(["webdesk:read"]),
    });
    expect(res.statusCode).toBe(404);
  });

  it("403s a principal without the webdesk:read scope (Cerbos-shaped dev-mode policy point still gates this route)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/control/v1/tenants/${generatedSlug}/contract`,
      headers: headers(["webdesk:operate"]), // has SOME scope, just not the one contract.read needs
    });
    expect(res.statusCode).toBe(403);
  });

  it("401s with no control-channel principal at all", async () => {
    const res = await app.inject({ method: "GET", url: `/control/v1/tenants/${generatedSlug}/contract` });
    expect(res.statusCode).toBe(401);
  });

  it("writes exactly one audit row per call, action 'control.contract.read', outcome recorded in args", async () => {
    const before = await withTenant(generatedTenantId, (c) => c.query(`SELECT count(*)::int AS n FROM audit_entries WHERE action = 'control.contract.read'`));
    await app.inject({ method: "GET", url: `/control/v1/tenants/${generatedSlug}/contract`, headers: headers(["webdesk:read"]) });
    const after = await withTenant(generatedTenantId, (c) => c.query(`SELECT count(*)::int AS n FROM audit_entries WHERE action = 'control.contract.read'`));
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });
});
