// WSK M3 T1 (D1) — schema.apply refuses a reserved collection key (a collection keyed `media`,
// `forms`, `search` or `sitemap.xml` would be unreachable on /v1: another route owns the segment).
// The refusal has no side effect: no collections row, no audit row (the composition-violation
// refusal in the same method behaves the same). The list itself is proven complete in
// test/delivery/reserved-collection-keys.spec.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, buildContentApp, createContentFixture, type ContentFixture } from "./content-test-kit";
import { RESERVED_COLLECTION_KEYS } from "../src/delivery/reserved-collection-keys";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const COMPOSITION = { fields: [{ name: "title", primitive: "text" }] };

describe("M3 T1 D1 — schema.apply refuses reserved collection keys", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;

  beforeAll(async () => {
    app = await buildContentApp();
    fx = await createContentFixture("reserved");
  });

  afterAll(async () => {
    await app?.close();
  });

  const apply = (key: string) =>
    app.inject({
      method: "POST",
      url: `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/collections/${encodeURIComponent(key)}/schema/apply`,
      headers: {
        "x-webdesk-control-principal": "erp-webdesk-control",
        "x-webdesk-control-scopes": "webdesk:operate",
        "idempotency-key": `schema-${randomUUID()}`,
      },
      payload: { schema: COMPOSITION },
    });

  const counts = () =>
    asTenant(fx.tenantId, async (c) => ({
      collections: (await c.query(`SELECT count(*)::int AS n FROM collections WHERE site_id = $1`, [fx.siteId])).rows[0].n as number,
      audits: (await c.query(`SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id = $1 AND action LIKE 'control.schema.apply%'`, [fx.tenantId]))
        .rows[0].n as number,
    }));

  it("refuses every reserved key (any case) with 422 collection-key-reserved, storing and auditing nothing", async () => {
    const before = await counts();
    const keys = [...RESERVED_COLLECTION_KEYS, "Media", "FORMS", "Search", "SITEMAP.XML"];
    for (const key of keys) {
      const res = await apply(key);
      expect(res.statusCode, key).toBe(422);
      expect(res.json().type, key).toBe(`${PROBLEM}collection-key-reserved`);
      expect(res.json().reservedKeys, key).toEqual([...RESERVED_COLLECTION_KEYS]);
    }
    expect(await counts()).toEqual(before);
  });

  it("a key that merely contains a reserved word is still allowed", async () => {
    const before = await counts();
    const res = await apply("media-gallery");
    expect(res.statusCode).toBe(201);
    const after = await counts();
    expect(after.collections).toBe(before.collections + 1);
    expect(after.audits).toBe(before.audits + 1);
  });
});
