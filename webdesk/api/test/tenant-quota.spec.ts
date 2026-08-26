// WSK-05 amendment — per-tenant read quotas. Forces a tiny limit via `TenantQuotaService`'s
// test-only `withLimits()` (see rate-limit/tenant-quota.service.ts) rather than an env var, so
// this file's expectations cannot race with any other spec file's requests against the same
// process. Proves: (1) the limit is per TENANT, not per key — two different keys for the same
// tenant share one budget; (2) a different tenant's budget is untouched — the noisy-neighbour
// property the ticket actually asks for; (3) the guard only gates the READ route, per the AC's
// "content reads" wording, not the write route.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTestApp, stopTestApp } from "./helpers/app";
import { createFixtureTenant, seedContentItem, type FixtureTenant } from "./helpers/fixtures";
import { TenantQuotaService } from "../src/rate-limit/tenant-quota.service";

describe("WSK-05 per-tenant read quota", () => {
  let app: NestFastifyApplication;
  let tenantA: FixtureTenant;
  let tenantB: FixtureTenant;
  let quota: TenantQuotaService;

  let keyA1: string;
  let keyA2: string;
  let keyB: string;

  beforeAll(async () => {
    app = await startTestApp();
    quota = app.get(TenantQuotaService);
    quota.withLimits(3, 60_000);

    tenantA = await createFixtureTenant("quota-a");
    tenantB = await createFixtureTenant("quota-b");
    await seedContentItem(tenantA, { slug: "a1", publishState: "published" });
    await seedContentItem(tenantB, { slug: "b1", publishState: "published" });

    const mintA1 = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenantA.slug}/api-keys`,
      payload: { envId: tenantA.stagingEnvId, scope: "write", actor: "quota-test" },
    });
    keyA1 = mintA1.json<{ key: string }>().key;

    const mintA2 = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenantA.slug}/api-keys`,
      payload: { envId: tenantA.stagingEnvId, scope: "read", actor: "quota-test" },
    });
    keyA2 = mintA2.json<{ key: string }>().key;

    const mintB = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenantB.slug}/api-keys`,
      payload: { envId: tenantB.stagingEnvId, scope: "read", actor: "quota-test" },
    });
    keyB = mintB.json<{ key: string }>().key;
  });

  afterAll(async () => {
    await stopTestApp(app);
  });

  it("shares ONE budget across different keys for the same tenant, then refuses with 429", async () => {
    const get = (key: string) =>
      app.inject({ method: "GET", url: `/v1/t/${tenantA.slug}/content`, headers: { authorization: `Bearer ${key}` } });

    const r1 = await get(keyA1); // 1/3
    const r2 = await get(keyA2); // 2/3 — a DIFFERENT key, same tenant
    const r3 = await get(keyA1); // 3/3
    const r4 = await get(keyA2); // over budget

    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([200, 200, 200]);
    expect(r4.statusCode).toBe(429);
  });

  it("tenant B's quota is completely untouched by tenant A exhausting its own — the noisy-neighbour property", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantB.slug}/content`,
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("the write route is NOT gated by the read quota (AC scope: content READS)", async () => {
    // Tenant A's read budget is already exhausted from the first test in this file.
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: { authorization: `Bearer ${keyA1}` },
      payload: { collectionKey: tenantA.collectionKey, locale: "en-US", slug: "still-writable-under-read-quota" },
    });
    expect(res.statusCode).toBe(201);
  });
});
