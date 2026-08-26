// WSK-07 — §11a AC: "every public asset response must carry a long Cache-Control plus the §05
// cache tags so a CDN hit never reaches the origin ... a media path that bypasses the CDN is a
// defect." This test drives the REAL serving route and asserts the headers on the actual HTTP
// response, not on a mocked handler.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildMediaTestApp, stopMediaTestApp } from "./media-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";

describe("WSK-07 — public media responses carry mandatory CDN cache headers", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let assetId: string;

  beforeAll(async () => {
    app = await buildMediaTestApp();
    tenant = await createFixtureTenant("cache-hdrs");

    const mintRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys`,
      payload: { envId: tenant.stagingEnvId, scope: "write", actor: "wsk07-test" },
    });
    const { key } = mintRes.json<{ key: string }>();

    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const buffer = Buffer.concat([PNG_MAGIC, Buffer.from("cache header fixture bytes")]);
    const uploadRes = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/media/media`,
      headers: { authorization: `Bearer ${key}` },
      payload: { filename: "cache-test.png", contentType: "image/png", contentBase64: buffer.toString("base64") },
    });
    expect(uploadRes.statusCode).toBe(201);
    assetId = uploadRes.json<{ id: string }>().id;
  }, 30_000);

  afterAll(async () => {
    await stopMediaTestApp(app);
  });

  it("GET on the serving route returns a long, immutable Cache-Control", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/t/${tenant.slug}/media/${assetId}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  }, 20_000);

  it("GET on the serving route carries the §05-shaped cache tags (Cache-Tag header)", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/t/${tenant.slug}/media/${assetId}` });
    const tagHeader = String(res.headers["cache-tag"]);
    expect(tagHeader).toContain(`t:${tenant.slug}`);
    expect(tagHeader).toContain(`m:${tenant.slug}:${assetId}`);
  }, 20_000);

  it("the response carries no Set-Cookie — cookieless per design §11", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/t/${tenant.slug}/media/${assetId}` });
    expect(res.headers["set-cookie"]).toBeUndefined();
  }, 20_000);
});
