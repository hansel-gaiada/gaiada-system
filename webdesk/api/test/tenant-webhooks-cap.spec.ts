// M4 (cost doc §3): at most TENANT_WEBHOOK_MAX_ENABLED_PER_TENANT enabled webhooks per tenant. Checked at
// register and at re-enable, under a per-tenant transaction lock, so concurrent registrations cannot overshoot.
// Disabling frees a slot (there is no delete). The config getter reads process.env at call time, so this suite
// sets a small cap for its own tenants and restores it afterwards.
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

const CAP = 2;

async function enabledCount(tenantId: string): Promise<number> {
  // FORCE RLS applies to the table owner too: without the tenant context this would silently count 0
  // (the estate's RLS zero-row trap), so set it the way the registration spec's dump does.
  const client = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM tenant_webhooks WHERE tenant_id = $1 AND enabled = true",
      [tenantId],
    );
    await client.query("COMMIT");
    return Number(rows[0].n);
  } finally {
    await client.end();
  }
}

describe("M4 — enabled tenant webhooks are capped per tenant", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let racer: FixtureTenant;
  const prevCap = process.env.TENANT_WEBHOOK_MAX_ENABLED_PER_TENANT;

  const register = (slug: string, n: number) =>
    app.inject({
      method: "POST",
      url: `/internal/tenants/${slug}/webhooks`,
      payload: { targetUrl: `https://8.8.8.8/webhook-${n}`, description: `cap ${n}` },
    });

  beforeAll(async () => {
    process.env.TENANT_WEBHOOK_MAX_ENABLED_PER_TENANT = String(CAP);
    app = await startTenantWebhooksTestApp();
    tenant = await createFixtureTenant("m4-webhook-cap");
    racer = await createFixtureTenant("m4-webhook-cap-race");
  }, 30_000);

  afterAll(async () => {
    if (prevCap === undefined) delete process.env.TENANT_WEBHOOK_MAX_ENABLED_PER_TENANT;
    else process.env.TENANT_WEBHOOK_MAX_ENABLED_PER_TENANT = prevCap;
    await app.get(TenantWebhookDispatcherService).onModuleDestroy();
    await stopTenantWebhooksTestApp(app);
  });

  it("registers up to the cap, then answers 409 with the reason", async () => {
    expect((await register(tenant.slug, 1)).statusCode).toBe(201);
    expect((await register(tenant.slug, 2)).statusCode).toBe(201);
    const over = await register(tenant.slug, 3);
    expect(over.statusCode).toBe(409);
    expect(over.json<{ message?: string }>().message).toMatch(/limit reached: at most 2 enabled webhooks/);
    expect(await enabledCount(tenant.tenantId)).toBe(CAP);
  });

  it("disabling one frees a slot; re-enabling it while the cap is full is refused", async () => {
    const list = (await app.inject({ method: "GET", url: `/internal/tenants/${tenant.slug}/webhooks` })).json<
      { id: string; enabled: boolean }[]
    >();
    const victim = list.find((w) => w.enabled)!;
    const off = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks/${victim.id}/enabled`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBeLessThan(300);
    expect((await register(tenant.slug, 4)).statusCode).toBe(201); // the freed slot
    const back = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks/${victim.id}/enabled`,
      payload: { enabled: true },
    });
    expect(back.statusCode).toBe(409);
    expect(await enabledCount(tenant.tenantId)).toBe(CAP);
  });

  it("re-enabling an already-enabled webhook at the cap is not counted against itself", async () => {
    const list = (await app.inject({ method: "GET", url: `/internal/tenants/${tenant.slug}/webhooks` })).json<
      { id: string; enabled: boolean }[]
    >();
    const on = list.find((w) => w.enabled)!;
    const again = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/webhooks/${on.id}/enabled`,
      payload: { enabled: true },
    });
    expect(again.statusCode).toBeLessThan(300);
  });

  it("six concurrent registrations against a cap of two: exactly two succeed (the transaction lock)", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => register(racer.slug, n)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(CAP);
    expect(codes.filter((c) => c === 409)).toHaveLength(6 - CAP);
    expect(await enabledCount(racer.tenantId)).toBe(CAP);
  });
});
