// WSK-48a — the delivery module at the HTTP edge: the adapter's byte-level promises, the router's own
// error shapes surviving the framework, and coexistence with the other routes that share the /v1
// prefix. Driven over real HTTP (Fastify `app.inject`) against real Postgres under real RLS.
//
// The byte-level /v1 gates are v1-golden.spec.ts (the api's answers against committed recordings; it
// replaced the old-Payload-router differential in WSK-48b) and envelope-contract.spec.ts (the frozen
// envelope contract; both ported from the deleted webdesk/payload/test/; see webdesk/api/README.md). This file pins the properties that must keep holding inside the api itself.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { startTestApp, stopTestApp } from "../helpers/app";
import { createFixtureTenant, seedContentItem, type FixtureTenant } from "../helpers/fixtures";
import { TenantQuotaService } from "../../src/rate-limit/tenant-quota.service";

const MIGRATOR_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk";

type MintedKey = { id: string; key: string };

async function mint(app: NestFastifyApplication, t: FixtureTenant, envId: string, scope: "read" | "write") {
  const res = await app.inject({
    method: "POST",
    url: `/internal/tenants/${t.slug}/api-keys`,
    payload: { envId, scope, actor: "wsk48a-test" },
  });
  expect(res.statusCode).toBe(201);
  return res.json<MintedKey>();
}

async function addCollection(t: FixtureTenant, key: string): Promise<string> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    const id = randomUUID();
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [t.tenantId]);
    await client.query(`INSERT INTO collections (id, tenant_id, site_id, key) VALUES ($1,$2,$3,$4)`, [
      id,
      t.tenantId,
      t.siteId,
      key,
    ]);
    await client.query("COMMIT");
    return id;
  } finally {
    await client.end();
  }
}

const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

describe("WSK-48a delivery — /v1 at the HTTP edge", () => {
  let app: NestFastifyApplication;
  let t: FixtureTenant;
  let readKey: MintedKey; // production
  let stagingRead: MintedKey;
  let stagingWrite: MintedKey;

  beforeAll(async () => {
    app = await startTestApp();
    t = await createFixtureTenant("delivery");
    readKey = await mint(app, t, t.productionEnvId, "read");
    stagingRead = await mint(app, t, t.stagingEnvId, "read");
    stagingWrite = await mint(app, t, t.stagingEnvId, "write");
    await seedContentItem(t, { slug: "live", locale: "en-US", publishState: "published" });
    await seedContentItem(t, { slug: "wip", locale: "en-US", publishState: "draft" });
  });

  afterAll(async () => {
    await stopTestApp(app);
  });

  describe("content-type / headers are exactly the contract's, with no framework suffix", () => {
    it("list + item: `application/json` (NO charset), Cache-Tag present", async () => {
      const list = await app.inject({ method: "GET", url: `/v1/t/${t.slug}/case-study?locale=en-US`, headers: bearer(readKey.key) });
      expect(list.statusCode).toBe(200);
      expect(list.headers["content-type"]).toBe("application/json");
      expect(list.headers["cache-tag"]).toBe(`t:${t.slug},c:${t.slug}:case-study`);
      expect(list.json<{ items: { slug: string }[] }>().items.map((i) => i.slug)).toEqual(["live"]);

      const item = await app.inject({ method: "GET", url: `/v1/t/${t.slug}/case-study/live?locale=en-US`, headers: bearer(readKey.key) });
      expect(item.statusCode).toBe(200);
      expect(item.headers["content-type"]).toBe("application/json");
      expect(item.headers["cache-tag"]).toMatch(new RegExp(`^t:${t.slug},c:${t.slug}:case-study,i:${t.slug}:[0-9a-f-]{36}$`));
      expect(Number(item.headers["content-length"])).toBe(Buffer.byteLength(item.body, "utf8"));
    });

    it("sitemap.xml: `application/xml` (NO charset)", async () => {
      const res = await app.inject({ method: "GET", url: `/v1/t/${t.slug}/sitemap.xml?locale=en-US`, headers: bearer(readKey.key) });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/xml");
      expect(res.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset')).toBe(true);
      expect(res.body).toContain("/case-study/live");
      expect(res.body).not.toContain("/case-study/wip");
    });

    it("errors are `application/problem+json` (NO charset) in the frozen RFC 9457 shape, echoing x-request-id", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/t/${t.slug}/case-study/does-not-exist?locale=en-US`,
        headers: { ...bearer(readKey.key), "x-request-id": "req-wsk48a-1" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toBe("application/problem+json");
      expect(res.json()).toEqual({
        type: "https://webdesk.gaiada.online/errors/item-not-found",
        title: "Item not found",
        status: 404,
        detail: 'No published item "does-not-exist" in "case-study".',
        instance: `/v1/t/${t.slug}/case-study/does-not-exist`,
        requestId: "req-wsk48a-1",
      });
    });
  });

  describe("the router's own error shapes survive the framework (not Nest's / Fastify's)", () => {
    it("unknown tenant and bad key are the SAME 401 body (no slug-existence oracle)", async () => {
      const unknownTenant = await app.inject({
        method: "GET",
        url: `/v1/t/no-such-tenant-wsk48a/case-study`,
        headers: { ...bearer(readKey.key), "x-request-id": "r" },
      });
      const badKey = await app.inject({
        method: "GET",
        url: `/v1/t/${t.slug}/case-study`,
        headers: { ...bearer("wdsk_nope"), "x-request-id": "r" },
      });
      expect(unknownTenant.statusCode).toBe(401);
      expect(badKey.statusCode).toBe(401);
      expect(unknownTenant.headers["content-type"]).toBe("application/problem+json");
      expect(unknownTenant.json<{ type: string; detail: string }>().type).toBe(badKey.json<{ type: string }>().type);
      expect(unknownTenant.json<{ detail: string }>().detail).toBe(badKey.json<{ detail: string }>().detail);
    });

    it("missing key on a known tenant: 401 missing-api-key; unknown tenant WITHOUT a key stays 401 invalid-credentials", async () => {
      const known = await app.inject({ method: "GET", url: `/v1/t/${t.slug}/case-study` });
      expect(known.statusCode).toBe(401);
      expect(known.json<{ type: string }>().type).toMatch(/missing-api-key$/);
      const unknown = await app.inject({ method: "GET", url: `/v1/t/no-such-tenant-wsk48a/case-study` });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json<{ type: string }>().type).toMatch(/invalid-credentials$/);
    });

    it("a path under /v1 that is not /v1/t/:slug/... is the router's 404 problem, not Nest's `Cannot GET`", async () => {
      for (const url of ["/v1/", "/v1/nonsense", "/v1/t", "/v1/t/", "/v2/t/x/y"]) {
        const res = await app.inject({ method: "GET", url });
        if (url.startsWith("/v2")) {
          // outside the /v1 wildcard entirely: Nest's own 404, never the delivery route
          expect(res.statusCode).toBe(404);
          continue;
        }
        expect(res.statusCode, url).toBe(404);
        expect(res.headers["content-type"], url).toBe("application/problem+json");
        expect(res.json<{ type: string }>().type, url).toMatch(/errors\/not-found$/);
      }
    });

    it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
      "%s -> the router's own 405 problem+json (not Fastify's)",
      async (method) => {
        const res = await app.inject({ method, url: `/v1/t/${t.slug}/case-study`, headers: bearer(readKey.key) });
        expect(res.statusCode).toBe(405);
        expect(res.headers["content-type"]).toBe("application/problem+json");
        expect(res.json<{ type: string }>().type).toMatch(/method-not-allowed$/);
      },
    );

    it("a POST that CARRIES a body still reaches the router's 405 — valid JSON, malformed JSON and an exotic content-type", async () => {
      const cases: Array<{ headers: Record<string, string>; payload: string }> = [
        { headers: { "content-type": "application/json" }, payload: '{"a":1}' },
        { headers: { "content-type": "application/json" }, payload: "{not json" }, // Fastify would 400 this itself
        { headers: { "content-type": "application/x-wsk48a-unsupported" }, payload: "xyz" }, // Fastify would 415
        { headers: { "content-type": "text/plain" }, payload: "hello" },
      ];
      for (const c of cases) {
        const res = await app.inject({
          method: "POST",
          url: `/v1/t/${t.slug}/case-study`,
          headers: { ...c.headers, ...bearer(readKey.key) },
          payload: c.payload,
        });
        expect(res.statusCode, c.headers["content-type"] + " " + c.payload).toBe(405);
        expect(res.headers["content-type"]).toBe("application/problem+json");
      }
    });

    it("HEAD -> 405 with the problem content-type and no body", async () => {
      const res = await app.inject({ method: "HEAD", url: `/v1/t/${t.slug}/case-study`, headers: bearer(readKey.key) });
      expect(res.statusCode).toBe(405);
      expect(res.headers["content-type"]).toBe("application/problem+json");
      expect(res.body).toBe("");
    });

    it("the parser reset is ENCAPSULATED: malformed JSON on a non-/v1 route still gets Fastify's 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/internal/tenants/${t.slug}/api-keys`,
        headers: { "content-type": "application/json" },
        payload: "{not json",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("environment visibility and tenant wall (production vs staging key, cross-tenant)", () => {
    it("staging key sees the draft; production key does not", async () => {
      const stg = await app.inject({ method: "GET", url: `/v1/t/${t.slug}/case-study?locale=en-US`, headers: bearer(stagingRead.key) });
      const prod = await app.inject({ method: "GET", url: `/v1/t/${t.slug}/case-study?locale=en-US`, headers: bearer(readKey.key) });
      expect(stg.json<{ items: { slug: string }[] }>().items.map((i) => i.slug).sort()).toEqual(["live", "wip"]);
      expect(prod.json<{ items: { slug: string }[] }>().items.map((i) => i.slug)).toEqual(["live"]);
    });

    it("a write-scoped key reads too (write implies read)", async () => {
      const res = await app.inject({ method: "GET", url: `/v1/t/${t.slug}/case-study?locale=en-US`, headers: bearer(stagingWrite.key) });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("coexistence with the other Nest routes under /v1/t/:slug (find-my-way precedence)", () => {
    it("a collection keyed `content` is served by the envelope router (the retired demo route no longer shadows it)", async () => {
      const collectionId = await addCollection(t, "content");
      const client = new Client({ connectionString: MIGRATOR_URL });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [t.tenantId]);
        await client.query(
          `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, blocks, publish_state)
           VALUES ($1,$2,$3,'en-US','in-content-collection','[]'::jsonb,'published')`,
          [t.tenantId, t.siteId, collectionId],
        );
        await client.query("COMMIT");
      } finally {
        await client.end();
      }
      const res = await app.inject({ method: "GET", url: `/v1/t/${t.slug}/content?locale=en-US`, headers: bearer(readKey.key) });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/json");
      const body = res.json<{ collection: string; items: { slug: string }[]; page: unknown }>();
      expect(body.collection).toBe("content"); // envelope shape, not the demo's { items } only
      expect(body.items.map((i) => i.slug)).toEqual(["in-content-collection"]);

      const post = await app.inject({ method: "POST", url: `/v1/t/${t.slug}/content`, headers: bearer(stagingWrite.key), payload: {} });
      expect(post.statusCode).toBe(405); // the demo POST is gone: the router's read-only 405
      expect(post.headers["content-type"]).toBe("application/problem+json");
    });

    it("media's write route still wins over the wildcard (read key -> ScopeGuard 403, not the router's 405)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/t/${t.slug}/media/media`,
        headers: bearer(readKey.key),
        payload: { filename: "x.png", contentType: "image/png", contentBase64: "AA==" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("`/v1/t/:slug/media` (no asset id) is a collection list for the router; `/media/:id` belongs to the media controller", async () => {
      const list = await app.inject({ method: "GET", url: `/v1/t/${t.slug}/media`, headers: bearer(readKey.key) });
      expect(list.statusCode).toBe(200);
      expect(list.json<{ collection: string }>().collection).toBe("media");
      // Known, documented collision (WSK-48a report): a collection keyed `media` or `forms` cannot be
      // addressed at /:collection/:slug — find-my-way hands that shape to the media/forms controller.
      const asset = await app.inject({ method: "GET", url: `/v1/t/${t.slug}/media/${randomUUID()}` });
      expect(asset.statusCode).toBe(404);
      expect(asset.headers["content-type"]).not.toBe("application/problem+json");
    });
  });

  describe("per-tenant read quota (the api's TenantQuotaService) on /v1", () => {
    it("in-quota responses carry X-RateLimit-* and an otherwise identical body; over-quota is a problem+json 429", async () => {
      const quotaTenant = await createFixtureTenant("delivery-quota");
      const key = await mint(app, quotaTenant, quotaTenant.productionEnvId, "read");
      await seedContentItem(quotaTenant, { slug: "q1", locale: "en-US", publishState: "published" });

      const quota = app.get(TenantQuotaService);
      quota.withLimits(2, 60_000);
      try {
        const url = `/v1/t/${quotaTenant.slug}/case-study?locale=en-US`;
        const a = await app.inject({ method: "GET", url, headers: { ...bearer(key.key), "x-request-id": "q" } });
        const b = await app.inject({ method: "GET", url, headers: { ...bearer(key.key), "x-request-id": "q" } });
        const c = await app.inject({ method: "GET", url, headers: { ...bearer(key.key), "x-request-id": "q" } });
        expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 200, 429]);
        expect(a.headers["x-ratelimit-limit"]).toBe("2");
        expect(a.headers["x-ratelimit-remaining"]).toBe("1");
        expect(b.headers["x-ratelimit-remaining"]).toBe("0");
        expect(a.body).toBe(b.body);
        expect(a.headers["content-type"]).toBe("application/json");

        expect(c.headers["content-type"]).toBe("application/problem+json");
        expect(c.headers["retry-after"]).toMatch(/^\d+$/);
        expect(c.json<{ type: string; status: number }>()).toMatchObject({
          type: "https://webdesk.gaiada.online/errors/rate-limited",
          status: 429,
        });

        // Unauthenticated probes do NOT spend the tenant's budget (the quota runs after auth).
        const probe = await app.inject({ method: "GET", url, headers: bearer("wdsk_nope") });
        expect(probe.statusCode).toBe(401);
      } finally {
        quota.withLimits(1000, 60_000);
      }
    });
  });
});
