// WSK-05 — the revoked-key probe: a key that worked a moment ago must die on the VERY NEXT
// request after revoke, with no cache window. This is why api-keys.service.ts#resolve() re-reads
// api_keys on every single call instead of memoizing anything.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTestApp, stopTestApp } from "./helpers/app";
import { createFixtureTenant, seedContentItem, type FixtureTenant } from "./helpers/fixtures";

describe("WSK-05 revoked-key probe", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;

  beforeAll(async () => {
    app = await startTestApp();
    tenant = await createFixtureTenant("revoke");
    await seedContentItem(tenant, { slug: "still-here", publishState: "published" });
  });

  afterAll(async () => {
    await stopTestApp(app);
  });

  it("dies immediately: works, gets revoked, then refuses on the NEXT call with no delay", async () => {
    const mintRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys`,
      payload: { envId: tenant.stagingEnvId, scope: "read", actor: "test-suite" },
    });
    expect(mintRes.statusCode).toBe(201);
    const minted = mintRes.json<{ id: string; key: string }>();

    const before = await app.inject({
      method: "GET",
      url: `/v1/t/${tenant.slug}/content`,
      headers: { authorization: `Bearer ${minted.key}` },
    });
    expect(before.statusCode).toBe(200);

    const revokeRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys/${minted.id}/revoke`,
      payload: { actor: "test-suite" },
    });
    expect(revokeRes.statusCode).toBe(201);

    // No sleep, no cache-bust header, no retry loop — the very next call, immediately.
    const after = await app.inject({
      method: "GET",
      url: `/v1/t/${tenant.slug}/content`,
      headers: { authorization: `Bearer ${minted.key}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("revoking an already-revoked key refuses (no un-revoke via double-call, no 2xx)", async () => {
    const mintRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys`,
      payload: { envId: tenant.stagingEnvId, scope: "read", actor: "test-suite" },
    });
    const minted = mintRes.json<{ id: string }>();

    const first = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys/${minted.id}/revoke`,
      payload: { actor: "test-suite" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys/${minted.id}/revoke`,
      payload: { actor: "test-suite" },
    });
    expect(second.statusCode).toBe(404);
  });

  it("a revoked key cannot be rotated back to life", async () => {
    const mintRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys`,
      payload: { envId: tenant.stagingEnvId, scope: "read", actor: "test-suite" },
    });
    const minted = mintRes.json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys/${minted.id}/revoke`,
      payload: { actor: "test-suite" },
    });

    const rotateRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys/${minted.id}/rotate`,
      payload: { actor: "test-suite" },
    });
    expect(rotateRes.statusCode).toBe(404);
  });
});
