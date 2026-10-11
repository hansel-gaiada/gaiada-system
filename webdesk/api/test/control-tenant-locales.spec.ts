// WSK-D48 follow-up — `tenant.provision` declares the tenant's locales (optional `defaultLocale` + `locales`).
// Real Postgres + the real AppModule + the real Layer-3/4 PDP (content-test-kit.ts). Proves: a tenant
// provisioned WITH locales takes content in each of them; WITHOUT, the old id-ID default holds (positive
// control); a bad declaration is refused as 400 before the envelope (no key claimed); and the locales are
// part of the hashed body (a replay with the same body replays; the same key with other locales is 409).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asPlatform, asTenant, buildContentApp, createItem, hdr, serviceFields, SERVICE_COMPOSITION, type ContentFixture } from "./content-test-kit";

describe("tenant.provision — locales (WSK-D48 follow-up)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildContentApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  const provision = (payload: Record<string, unknown>, idem?: string) =>
    app.inject({ method: "POST", url: "/control/v1/tenants", headers: hdr({ idem, editorial: null }), payload });
  const freshSlug = () => `wsk-loc-${randomUUID().slice(0, 8)}`;

  /** A site + the `service` collection on a freshly provisioned tenant, shaped like a ContentFixture for createItem. */
  async function siteFor(tenant: { id: string; slug: string }): Promise<ContentFixture> {
    const site = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/sites`,
      headers: hdr({ editorial: null }),
      payload: { kind: "astro", name: "locales site" },
    });
    expect(site.statusCode).toBe(201);
    const siteId = site.json().site.id as string;
    await asTenant(tenant.id, async (c) => {
      await c.query(`INSERT INTO collections (id, tenant_id, site_id, key, schema) VALUES ($1, $2, $3, 'service', $4::jsonb)`, [
        randomUUID(),
        tenant.id,
        siteId,
        JSON.stringify(SERVICE_COMPOSITION),
      ]);
    });
    return { tenantId: tenant.id, slug: tenant.slug, siteId, stagingEnvId: "", productionEnvId: "", collections: {} };
  }

  const storedLocales = (tenantId: string) =>
    asPlatform(async (c) => {
      const { rows } = await c.query(`SELECT default_locale, locales FROM tenants WHERE id = $1`, [tenantId]);
      return rows[0] as { default_locale: string; locales: string[] };
    });

  it("with {defaultLocale:'en', locales:['en','id']}: stored, returned, and a create in en and in id both succeed", async () => {
    const r = await provision({ slug: freshSlug(), companyRef: randomUUID(), defaultLocale: "en", locales: ["en", "id"] });
    expect(r.statusCode).toBe(201);
    const tenant = r.json().tenant;
    expect(tenant).toMatchObject({ default_locale: "en", locales: ["en", "id"] });
    expect(await storedLocales(tenant.id)).toEqual({ default_locale: "en", locales: ["en", "id"] });

    const fx = await siteFor(tenant);
    const en = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.seo", fields: serviceFields() });
    expect(en.statusCode).toBe(201);
    const id = await createItem(app, fx, { collectionKey: "service", locale: "id", slug: "service.seo", fields: serviceFields() });
    expect(id.statusCode).toBe(201);
    // A locale outside the declared set is still refused (the composition check reads what we stored).
    const fr = await createItem(app, fx, { collectionKey: "service", locale: "fr", slug: "service.seo", fields: serviceFields() });
    expect(fr.statusCode).toBe(422);
  });

  it("positive control: without them the old default holds (id-ID only) and an en create is refused 422 /locale", async () => {
    const r = await provision({ slug: freshSlug(), companyRef: randomUUID() });
    expect(r.statusCode).toBe(201);
    const tenant = r.json().tenant;
    expect(await storedLocales(tenant.id)).toEqual({ default_locale: "id-ID", locales: ["id-ID"] });

    const fx = await siteFor(tenant);
    const en = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.seo", fields: serviceFields() });
    expect(en.statusCode).toBe(422);
    expect(JSON.stringify(en.json())).toContain("/locale");
    const ok = await createItem(app, fx, { collectionKey: "service", locale: "id-ID", slug: "service.seo", fields: serviceFields() });
    expect(ok.statusCode).toBe(201);
  });

  describe("a bad declaration is refused 400 and creates no tenant", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["defaultLocale not in locales", { defaultLocale: "fr", locales: ["en", "id"] }],
      ["an invalid locale (empty)", { defaultLocale: "en", locales: ["en", ""] }],
      ["an invalid locale (surrounding whitespace)", { defaultLocale: "en", locales: ["en", " id"] }],
      ["an invalid locale (too long)", { defaultLocale: "en", locales: ["en", "x".repeat(36)] }],
      ["an invalid locale (not a string)", { defaultLocale: "en", locales: ["en", 7] }],
      ["an invalid defaultLocale", { defaultLocale: "", locales: ["en"] }],
      ["duplicate locales", { defaultLocale: "en", locales: ["en", "en"] }],
      ["empty locales", { defaultLocale: "en", locales: [] }],
      ["locales not an array", { defaultLocale: "en", locales: "en" }],
      ["defaultLocale without locales", { defaultLocale: "en" }],
      ["locales without defaultLocale", { locales: ["en"] }],
    ];
    for (const [name, extra] of cases) {
      it(name, async () => {
        const slug = freshSlug();
        const r = await provision({ slug, companyRef: randomUUID(), ...extra });
        expect(r.statusCode).toBe(400);
        const n = await asPlatform(async (c) => (await c.query(`SELECT count(*)::int AS n FROM tenants WHERE slug = $1`, [slug])).rows[0].n as number);
        expect(n).toBe(0);
      });
    }
  });

  it("idempotency: the same body replays; the same key with different locales (or none) is refused 409", async () => {
    const slug = freshSlug();
    const companyRef = randomUUID();
    const idem = `idem-${randomUUID()}`;
    const body = { slug, companyRef, defaultLocale: "en", locales: ["en", "id"] };
    const first = await provision(body, idem);
    const again = await provision(body, idem);
    expect(first.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);
    expect(again.statusCode).toBe(201);
    expect(again.json().replayed).toBe(true);
    expect(again.json().tenant.id).toBe(first.json().tenant.id);

    expect((await provision({ ...body, locales: ["en", "id", "fr"] }, idem)).statusCode).toBe(409);
    expect((await provision({ ...body, defaultLocale: "id" }, idem)).statusCode).toBe(409);
    expect((await provision({ slug, companyRef }, idem)).statusCode).toBe(409);
    expect(await storedLocales(first.json().tenant.id)).toEqual({ default_locale: "en", locales: ["en", "id"] });
  });
});
