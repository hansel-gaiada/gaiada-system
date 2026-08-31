// WSK-05 — the scope matrix: key x tenant x env x scope -> allowed/refused, driven entirely over
// real HTTP (Fastify `app.inject`, no open socket) against real Postgres rows under real RLS.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTestApp, stopTestApp } from "./helpers/app";
import { createFixtureTenant, seedContentItem, type FixtureTenant } from "./helpers/fixtures";

type MintedKey = { id: string; key: string; scope: string; envId: string };

async function mint(app: NestFastifyApplication, tenantSlug: string, envId: string, scope: "read" | "write") {
  const res = await app.inject({
    method: "POST",
    url: `/internal/tenants/${tenantSlug}/api-keys`,
    payload: { envId, scope, actor: "test-suite" },
  });
  expect(res.statusCode).toBe(201);
  return res.json<MintedKey>();
}

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

describe("WSK-05 scope matrix", () => {
  let app: NestFastifyApplication;
  let tenantA: FixtureTenant;
  let tenantB: FixtureTenant;

  let aStagingRead: MintedKey;
  let aStagingWrite: MintedKey;
  let aProductionRead: MintedKey;
  let bStagingRead: MintedKey;

  beforeAll(async () => {
    app = await startTestApp();
    tenantA = await createFixtureTenant("matrix-a");
    tenantB = await createFixtureTenant("matrix-b");

    aStagingRead = await mint(app, tenantA.slug, tenantA.stagingEnvId, "read");
    aStagingWrite = await mint(app, tenantA.slug, tenantA.stagingEnvId, "write");
    aProductionRead = await mint(app, tenantA.slug, tenantA.productionEnvId, "read");
    bStagingRead = await mint(app, tenantB.slug, tenantB.stagingEnvId, "read");

    await seedContentItem(tenantA, { slug: "a-draft", publishState: "draft" });
    await seedContentItem(tenantA, { slug: "a-published", publishState: "published" });
    await seedContentItem(tenantB, { slug: "b-published", publishState: "published" });
  });

  afterAll(async () => {
    await stopTestApp(app);
  });

  it("mint returns the plaintext key exactly once, in the mint response only", () => {
    expect(aStagingRead.key).toMatch(/^wdsk_/);
    expect(aStagingRead.scope).toBe("read");
  });

  it("a staging read key sees BOTH draft and published items for its own tenant/site", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: auth(aStagingRead.key),
    });
    expect(res.statusCode).toBe(200);
    const slugs = res.json<{ items: { slug: string }[] }>().items.map((i) => i.slug);
    expect(slugs.sort()).toEqual(["a-draft", "a-published"]);
  });

  it("a production read key sees ONLY published items — env gates publish visibility", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: auth(aProductionRead.key),
    });
    expect(res.statusCode).toBe(200);
    const slugs = res.json<{ items: { slug: string }[] }>().items.map((i) => i.slug);
    expect(slugs).toEqual(["a-published"]);
  });

  it("a read-scoped key is refused on a write route (403, not 401 — the key IS valid)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: auth(aStagingRead.key),
      payload: { collectionKey: tenantA.collectionKey, locale: "en-US", slug: "should-not-be-created" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a write-scoped key can create content, and write implies read on the same key", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: auth(aStagingWrite.key),
      payload: { collectionKey: tenantA.collectionKey, locale: "en-US", slug: "a-created-by-write-key" },
    });
    expect(createRes.statusCode).toBe(201);

    const readRes = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: auth(aStagingWrite.key),
    });
    expect(readRes.statusCode).toBe(200);
    const slugs = readRes.json<{ items: { slug: string }[] }>().items.map((i) => i.slug);
    expect(slugs).toContain("a-created-by-write-key");
  });

  it("tenant A's key is refused against tenant B's route (cross-tenant key use)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantB.slug}/content`,
      headers: auth(aStagingRead.key),
    });
    expect(res.statusCode).toBe(401);
  });

  it("tenant B's key is refused against tenant A's route (symmetric cross-tenant refusal)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: auth(bStagingRead.key),
    });
    expect(res.statusCode).toBe(401);
  });

  it("tenant B's own key sees only tenant B's content, never leaking A's rows", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantB.slug}/content`,
      headers: auth(bStagingRead.key),
    });
    expect(res.statusCode).toBe(200);
    const slugs = res.json<{ items: { slug: string }[] }>().items.map((i) => i.slug);
    expect(slugs).toEqual(["b-published"]);
  });

  it("rotate replaces the secret — the OLD plaintext key stops working immediately", async () => {
    const rotateRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenantA.slug}/api-keys/${aProductionRead.id}/rotate`,
      payload: { actor: "test-suite" },
    });
    expect(rotateRes.statusCode).toBe(201);
    const rotated = rotateRes.json<MintedKey>();
    expect(rotated.key).not.toBe(aProductionRead.key);

    const withOldKey = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: auth(aProductionRead.key),
    });
    expect(withOldKey.statusCode).toBe(401);

    const withNewKey = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: auth(rotated.key),
    });
    expect(withNewKey.statusCode).toBe(200);
  });
});
