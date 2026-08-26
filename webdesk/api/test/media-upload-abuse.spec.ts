// WSK-07 — "oversize/wrong-type refused" (ticket AC), plus the declared-vs-sniffed mismatch case
// (a request that LIES about its content-type) and the artifacts-bucket-has-no-client-route case.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildMediaTestApp, stopMediaTestApp } from "./media-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("WSK-07 — upload abuse battery", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let writeKey: string;

  beforeAll(async () => {
    app = await buildMediaTestApp();
    tenant = await createFixtureTenant("abuse");
    const mintRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys`,
      payload: { envId: tenant.stagingEnvId, scope: "write", actor: "wsk07-test" },
    });
    writeKey = mintRes.json<{ key: string }>().key;
  }, 30_000);

  afterAll(async () => {
    await stopMediaTestApp(app);
  });

  it("refuses an oversize upload (over WEBDESK_MEDIA_MAX_UPLOAD_BYTES) with 400", async () => {
    const cap = Number(process.env.WEBDESK_MEDIA_MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024);
    const oversized = Buffer.concat([PNG_MAGIC, Buffer.alloc(cap)]); // > cap once the header is added
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/media/media`,
      headers: { authorization: `Bearer ${writeKey}` },
      payload: { filename: "huge.png", contentType: "image/png", contentBase64: oversized.toString("base64") },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json<{ message?: string }>().message)).toMatch(/exceeds/i);
  }, 20_000);

  it("refuses a content-type not on the bucket's allowlist (e.g. text/html into media)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/media/media`,
      headers: { authorization: `Bearer ${writeKey}` },
      payload: {
        filename: "script.html",
        contentType: "text/html",
        contentBase64: Buffer.from("<script>alert(1)</script>").toString("base64"),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json<{ message?: string }>().message)).toMatch(/not allowed/i);
  }, 20_000);

  it("refuses when the declared content-type does not match the file's actual magic bytes", async () => {
    // Declares image/png but the bytes are really a JPEG — the classic MIME-spoofing attempt.
    const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("fake jpeg body")]);
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/media/media`,
      headers: { authorization: `Bearer ${writeKey}` },
      payload: { filename: "spoofed.png", contentType: "image/png", contentBase64: jpegBytes.toString("base64") },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json<{ message?: string }>().message)).toMatch(/does not match/i);
  }, 20_000);

  it("refuses an upload to the artifacts bucket — no client-facing upload route for it", async () => {
    const buffer = Buffer.concat([PNG_MAGIC, Buffer.from("irrelevant")]);
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/media/artifacts`,
      headers: { authorization: `Bearer ${writeKey}` },
      payload: { filename: "x.png", contentType: "image/png", contentBase64: buffer.toString("base64") },
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it("refuses an upload to an unknown bucket name", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/media/not-a-real-bucket`,
      headers: { authorization: `Bearer ${writeKey}` },
      payload: { filename: "x.png", contentType: "image/png", contentBase64: "AA==" },
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it("refuses an unauthenticated upload (no bearer key) with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/media/media`,
      payload: { filename: "x.png", contentType: "image/png", contentBase64: "AA==" },
    });
    expect(res.statusCode).toBe(401);
  }, 20_000);
});
