// WSK-37 — the HTTP-layer registration surface: DTO validation, the registration-time SSRF
// pre-flight, the plaintext-never-at-rest proof (same "dump-grep" methodology as WSK-05's own
// plaintext-dump-grep.spec.ts), and a cross-tenant RLS probe at the runtime role
// (webdesk_app, NOBYPASSRLS) — the same methodology forms-cross-tenant.spec.ts and WSK-04's own
// suite use.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.APP_DATABASE_URL =
  process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55510/webdesk";
process.env.MIGRATE_DATABASE_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55510/webdesk";
process.env.TENANT_WEBHOOK_SECRET_PEPPER =
  process.env.TENANT_WEBHOOK_SECRET_PEPPER || "wsk37-test-pepper-never-used-outside-this-suite";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:55511";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { startTenantWebhooksTestApp, stopTenantWebhooksTestApp } from "./tenant-webhooks-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { TenantWebhookDispatcherService } from "../src/tenant-webhooks/tenant-webhook-dispatcher.service";

const MIGRATOR_URL = process.env.MIGRATE_DATABASE_URL!;

async function dumpAllTenantWebhookRowsAcrossTenants(): Promise<Record<string, unknown>[]> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
    const { rows: tenantRows } = await client.query(`SELECT id FROM tenants`);
    await client.query("COMMIT");

    const all: Record<string, unknown>[] = [];
    for (const t of tenantRows) {
      await client.query("BEGIN");
      await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [t.id]);
      const { rows } = await client.query(`SELECT * FROM tenant_webhooks`);
      all.push(...rows);
      await client.query("COMMIT");
    }
    return all;
  } finally {
    await client.end();
  }
}

/** Cross-tenant probe as the RUNTIME role (APP_DATABASE_URL, webdesk_app, NOBYPASSRLS) — no
 *  migrator/superuser bypass anywhere in this query. */
async function probeCrossTenantWebhookRead(wrongTenantId: string): Promise<Record<string, unknown>[]> {
  const client = new Client({ connectionString: process.env.APP_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [wrongTenantId]);
    const { rows } = await client.query(`SELECT * FROM tenant_webhooks`);
    await client.query("COMMIT");
    return rows;
  } finally {
    await client.end();
  }
}

describe("WSK-37 — registration HTTP surface + plaintext-never-at-rest + RLS cross-tenant probe", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  const mintedPlaintexts: string[] = [];

  beforeAll(async () => {
    app = await startTenantWebhooksTestApp();
    tenant = await createFixtureTenant("wsk37-registration");
  }, 30_000);

  afterAll(async () => {
    await app.get(TenantWebhookDispatcherService).onModuleDestroy();
    await stopTenantWebhooksTestApp(app);
  });

  it("REJECTS a plain http:// target at registration (400, DTO layer)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks`,
      payload: { targetUrl: "http://example.test/webhook" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("REJECTS a private-range target at registration (400, the SERVICE's SSRF pre-flight, not just the DTO's scheme check)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks`,
      payload: { targetUrl: "https://10.0.0.5/webhook" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message?: string }>().message).toMatch(/targetUrl refused/);
  });

  it("REJECTS the cloud-metadata address at registration", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks`,
      payload: { targetUrl: "https://169.254.169.254/latest/meta-data/" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("REJECTS an unsupported event kind", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks`,
      payload: { targetUrl: "https://8.8.8.8/webhook", eventKinds: ["deploy.done"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("REGISTERS a webhook against a public-looking target, returns the plaintext secret ONCE, and the list endpoint never echoes it back", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks`,
      payload: { targetUrl: "https://8.8.8.8/webhook", description: "registration proof" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; secret: string; targetUrl: string }>();
    expect(body.secret).toMatch(/^whsec_/);
    mintedPlaintexts.push(body.secret);

    const listRes = await app.inject({ method: "GET", url: `/internal/tenants/${tenant.slug}/webhooks` });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json<Record<string, unknown>[]>();
    const dump = JSON.stringify(listed);
    expect(dump.includes(body.secret)).toBe(false);
    expect(dump).not.toContain("secret_ciphertext"); // the field is stripped from the public shape entirely
  });

  it("ROTATE returns a NEW plaintext secret that also never appears anywhere at rest", async () => {
    const registerRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks`,
      payload: { targetUrl: "https://8.8.4.4/webhook", description: "rotate proof" },
    });
    const { id, secret: originalSecret } = registerRes.json<{ id: string; secret: string }>();
    mintedPlaintexts.push(originalSecret);

    const rotateRes = await app.inject({ method: "POST", url: `/internal/tenants/${tenant.slug}/webhooks/${id}/rotate` });
    expect(rotateRes.statusCode).toBe(201);
    const { secret: newSecret } = rotateRes.json<{ secret: string }>();
    expect(newSecret).not.toBe(originalSecret);
    mintedPlaintexts.push(newSecret);
  });

  it("no plaintext secret (original or post-rotate) appears anywhere in tenant_webhooks, for any tenant, on any column", async () => {
    expect(mintedPlaintexts.length).toBeGreaterThanOrEqual(3);
    const allRows = await dumpAllTenantWebhookRowsAcrossTenants();
    expect(allRows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(allRows);
    for (const plaintext of mintedPlaintexts) {
      expect(dump.includes(plaintext)).toBe(false);
    }
  });

  it("cross-tenant RLS probe (webdesk_app runtime role, NOBYPASSRLS): a webhook row is invisible under a different tenant's context", async () => {
    const otherTenant = await createFixtureTenant("wsk37-registration-xtenant");
    const registerRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks`,
      payload: { targetUrl: "https://1.1.1.1/webhook", description: "rls probe" },
    });
    expect(registerRes.statusCode).toBe(201);

    const crossRows = await probeCrossTenantWebhookRead(otherTenant.tenantId);
    // Zero rows, not an error, not "found but redacted" — the row simply does not exist from the
    // other tenant's vantage, at the RUNTIME role, with FORCE RLS and no BYPASSRLS anywhere.
    expect(crossRows).toHaveLength(0);

    // And visible under its OWN tenant, same role, same table, proving this is isolation, not
    // a broken table.
    const ownRows = await probeCrossTenantWebhookRead(tenant.tenantId);
    expect(ownRows.length).toBeGreaterThan(0);
  });

  it("a webhookId that belongs to a different tenant 404s through the public API (no cross-tenant existence oracle)", async () => {
    const tenantB = await createFixtureTenant("wsk37-registration-404");
    const registerRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks`,
      payload: { targetUrl: "https://9.9.9.9/webhook" },
    });
    const { id } = registerRes.json<{ id: string }>();

    const crossRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenantB.slug}/webhooks/${id}/rotate`,
    });
    expect(crossRes.statusCode).toBe(404);
  });
});
