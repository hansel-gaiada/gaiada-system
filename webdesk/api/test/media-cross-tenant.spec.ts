// WSK-07 — THE CORRECTED AC (per the ticket brief and 2026-08-26-webdesk-PROGRESS.md's WSK-07
// row): "the API refuses to serve tenant A a file under tenant B's prefix." NOT "tenant A's
// creds cannot touch tenant B's prefix" (that AC is explicitly wrong per the ticket — no
// per-tenant storage credentials are ever issued; storage credentials stay platform-level,
// inside Zone B, never handed to a tenant or a client site). This suite proves the isolation
// where it actually lives: the API's tenant-scoped (RLS) row lookup in media.service.ts, on
// BOTH the public serving route and the authenticated presigned route.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildMediaTestApp, stopMediaTestApp } from "./media-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";

async function mint(app: NestFastifyApplication, tenantSlug: string, envId: string, scope: "read" | "write") {
  const res = await app.inject({
    method: "POST",
    url: `/internal/tenants/${tenantSlug}/api-keys`,
    payload: { envId, scope, actor: "wsk07-test" },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ key: string }>();
}

async function uploadClean(app: NestFastifyApplication, tenantSlug: string, key: string, bucket: string, filename: string) {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const buffer = Buffer.concat([PNG_MAGIC, Buffer.from("clean cross-tenant fixture bytes")]);
  const res = await app.inject({
    method: "POST",
    url: `/v1/t/${tenantSlug}/media/${bucket}`,
    headers: { authorization: `Bearer ${key}` },
    payload: { filename, contentType: "image/png", contentBase64: buffer.toString("base64") },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; bucket: string; bucketKey: string }>();
}

async function uploadPdfToUploads(app: NestFastifyApplication, tenantSlug: string, key: string, filename: string) {
  const PDF_MAGIC = Buffer.from("%PDF-1.4\n", "ascii");
  const buffer = Buffer.concat([PDF_MAGIC, Buffer.from("clean private fixture bytes")]);
  const res = await app.inject({
    method: "POST",
    url: `/v1/t/${tenantSlug}/media/uploads`,
    headers: { authorization: `Bearer ${key}` },
    payload: { filename, contentType: "application/pdf", contentBase64: buffer.toString("base64") },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>();
}

describe("WSK-07 — cross-tenant refusal lives at the API, not at storage credentials", () => {
  let app: NestFastifyApplication;
  let tenantA: FixtureTenant;
  let tenantB: FixtureTenant;
  let aWriteKey: string;
  let bWriteKey: string;
  let bReadKey: string;
  let assetOwnedByA: { id: string };
  let uploadOwnedByA: { id: string };

  beforeAll(async () => {
    app = await buildMediaTestApp();
    tenantA = await createFixtureTenant("xtenant-a");
    tenantB = await createFixtureTenant("xtenant-b");

    aWriteKey = (await mint(app, tenantA.slug, tenantA.stagingEnvId, "write")).key;
    bWriteKey = (await mint(app, tenantB.slug, tenantB.stagingEnvId, "write")).key;
    bReadKey = (await mint(app, tenantB.slug, tenantB.stagingEnvId, "read")).key;

    assetOwnedByA = await uploadClean(app, tenantA.slug, aWriteKey, "media", "a-owns-this.png");
    uploadOwnedByA = await uploadPdfToUploads(app, tenantA.slug, aWriteKey, "a-owns-this.pdf");
  }, 30_000);

  afterAll(async () => {
    await stopMediaTestApp(app);
  });

  it("sanity: tenant A can read its OWN public asset through its OWN slug", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/t/${tenantA.slug}/media/${assetOwnedByA.id}` });
    expect(res.statusCode).toBe(200);
  }, 20_000);

  it("REFUSES: tenant A's real asset id requested under tenant B's slug — public serving route", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/t/${tenantB.slug}/media/${assetOwnedByA.id}` });
    // 404, not 403 — no existence oracle: this must be indistinguishable from a nonexistent id.
    expect(res.statusCode).toBe(404);
  }, 20_000);

  it("REFUSES: tenant B's own write key cannot fetch tenant A's asset by asset id (same public route, no key even involved)", async () => {
    // The public route takes no key at all — reinforced check that varying the credential does
    // not change the outcome: only the SLUG in the URL determines the tenant context.
    const res = await app.inject({ method: "GET", url: `/v1/t/${tenantB.slug}/media/${assetOwnedByA.id}` });
    expect(res.statusCode).toBe(404);
    void bWriteKey; // present only to document that a key would not have helped either
  }, 20_000);

  it("REFUSES: tenant B's authenticated read key cannot presign tenant A's PRIVATE uploads asset", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantB.slug}/media/${uploadOwnedByA.id}/presigned`,
      headers: { authorization: `Bearer ${bReadKey}` },
    });
    expect(res.statusCode).toBe(404);
  }, 20_000);

  it("sanity: tenant A itself CAN presign its own uploads asset", async () => {
    const aReadKey = (await mint(app, tenantA.slug, tenantA.stagingEnvId, "read")).key;
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantA.slug}/media/${uploadOwnedByA.id}/presigned`,
      headers: { authorization: `Bearer ${aReadKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ url: string }>();
    expect(body.url).toMatch(/^https?:\/\//);
  }, 20_000);

  it("the PRIVATE uploads asset is never reachable via the PUBLIC serving route, even for its own tenant", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/t/${tenantA.slug}/media/${uploadOwnedByA.id}` });
    expect(res.statusCode).toBe(404); // getPublicAsset() filters to PUBLIC_BUCKETS only
  }, 20_000);
});
