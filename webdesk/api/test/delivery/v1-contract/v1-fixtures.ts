// WSK-48a (tests port) — the /v1 envelope-contract fixtures, ported from
// webdesk/payload/test/v1-fixtures.mjs so the contract and the differential live in this package
// and survive WSK-48b deleting Payload. Same SQL, same GUCs, same defaults: a raw pg client
// connected as webdesk_migrator (NOBYPASSRLS), platform_ctx for the tenant row, tenant_ctx for
// everything that belongs to one. Fresh random slugs/ids per call; nothing is cleaned up — the
// database is a throwaway container.
//
// `createRedirect` is the one addition: the original suite seeded redirects through the OLD
// router's own write helper (payload/collections/redirects.ts). The api has no redirect write path
// (its delivery/redirects.ts is sitemap only), so the same two statements run here as fixtures.
// The rows are identical; only the connecting role differs (migrator here, app there), and RLS
// scopes both to the same tenant.
import { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";

export type V1Tenant = {
  tenantId: string;
  slug: string;
  siteId: string;
  stagingEnvId: string;
  productionEnvId: string;
  defaultLocale: string;
  locales: string[];
};

export type PublishState = "draft" | "scheduled" | "published" | "unpublished";

export function migratorUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) throw new Error("MIGRATE_DATABASE_URL not set");
  return url;
}

function hashApiKey(plaintext: string, pepper: string): string {
  return createHash("sha256").update(plaintext + pepper, "utf8").digest("hex");
}

async function inTenant<T>(tenant: V1Tenant, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: migratorUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

export async function createFixtureTenant(opts: { label: string; defaultLocale?: string; locales?: string[] }): Promise<V1Tenant> {
  const client = new Client({ connectionString: migratorUrl() });
  await client.connect();
  try {
    const slug = `wsk06-${opts.label}-${randomUUID().slice(0, 8)}`;
    const tenantId = randomUUID();
    const siteId = randomUUID();
    const stagingEnvId = randomUUID();
    const productionEnvId = randomUUID();
    const defaultLocale = opts.defaultLocale ?? "id-ID";
    const locales = opts.locales ?? [defaultLocale];

    await client.query("BEGIN");
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
    await client.query(
      `INSERT INTO tenants (id, slug, company_ref, status, default_locale, locales)
       VALUES ($1, $2, $3, 'active', $4, $5)`,
      [tenantId, slug, randomUUID(), defaultLocale, locales],
    );
    await client.query("SET LOCAL webdesk.platform_ctx = ''");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    await client.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', $3)`, [
      siteId,
      tenantId,
      `${opts.label} site`,
    ]);
    await client.query(
      `INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'staging', 'active')`,
      [stagingEnvId, siteId, tenantId],
    );
    await client.query(
      `INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'production', 'active')`,
      [productionEnvId, siteId, tenantId],
    );
    await client.query("COMMIT");

    return { tenantId, slug, siteId, stagingEnvId, productionEnvId, defaultLocale, locales };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

export async function createFixtureCollection(tenant: V1Tenant, key: string): Promise<string> {
  return inTenant(tenant, async (c) => {
    const collectionId = randomUUID();
    await c.query(`INSERT INTO collections (id, tenant_id, site_id, key) VALUES ($1, $2, $3, $4)`, [
      collectionId,
      tenant.tenantId,
      tenant.siteId,
      key,
    ]);
    return collectionId;
  });
}

export async function seedContentItem(
  tenant: V1Tenant,
  opts: {
    collectionId: string;
    locale: string;
    slug: string;
    publishState?: PublishState;
    publishAt?: string | null;
    unpublishAt?: string | null;
    blocks?: unknown[];
    seo?: Record<string, unknown>;
    localizationGroupId?: string;
    createdAt?: string;
  },
): Promise<{ id: string; localizationGroupId: string }> {
  return inTenant(tenant, async (c) => {
    const id = randomUUID();
    const groupId = opts.localizationGroupId ?? randomUUID();
    await c.query(
      `INSERT INTO content_items
         (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id, blocks, seo,
          publish_state, publish_at, unpublish_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13, now()))`,
      [
        id,
        tenant.tenantId,
        tenant.siteId,
        opts.collectionId,
        opts.locale,
        opts.slug,
        groupId,
        JSON.stringify(opts.blocks ?? [{ type: "hero", props: { heading: `hello ${opts.slug}` } }]),
        JSON.stringify(opts.seo ?? { title: opts.slug }),
        opts.publishState ?? "published",
        opts.publishAt ?? null,
        opts.unpublishAt ?? null,
        opts.createdAt ?? null,
      ],
    );
    return { id, localizationGroupId: groupId };
  });
}

export async function mintFixtureApiKey(tenant: V1Tenant, envName: "staging" | "production", scope: "read" | "write"): Promise<string> {
  const pepper = process.env.API_KEY_PEPPER;
  if (!pepper) throw new Error("API_KEY_PEPPER not set");
  const plaintext = `wdsk_test_${randomUUID().replace(/-/g, "")}`;
  const envId = envName === "staging" ? tenant.stagingEnvId : tenant.productionEnvId;
  await inTenant(tenant, (c) =>
    c.query(`INSERT INTO api_keys (env_id, tenant_id, key_hash, scope) VALUES ($1,$2,$3,$4)`, [
      envId,
      tenant.tenantId,
      hashApiKey(plaintext, pepper),
      scope,
    ]),
  );
  return plaintext;
}

export async function setEnvironmentDomain(tenant: V1Tenant, envName: "staging" | "production", domain: string): Promise<void> {
  const envId = envName === "staging" ? tenant.stagingEnvId : tenant.productionEnvId;
  await inTenant(tenant, (c) => c.query(`UPDATE environments SET domain = $1 WHERE id = $2`, [domain, envId]));
}

/**
 * payload/collections/redirects.ts#createRedirect + #ensureRedirectCollection, as fixture SQL.
 * Same collection key, same composition-as-data schema, same row shape, same upsert. Redirects
 * live in the tenant's default locale (they are not localized in v1).
 */
export async function createRedirect(
  tenant: V1Tenant,
  r: { fromPath: string; toPath: string; status: 301 | 302 | 307 | 308; active: boolean },
): Promise<void> {
  await inTenant(tenant, async (c) => {
    const { rows } = await c.query(`SELECT id FROM collections WHERE site_id = $1 AND key = $2`, [tenant.siteId, "redirect"]);
    let collectionId: string = rows[0]?.id;
    if (!collectionId) {
      const schema = {
        fields: [
          { name: "toPath", primitive: "text", required: true },
          { name: "status", primitive: "select", options: ["301", "302", "307", "308"] },
          { name: "active", primitive: "select", options: ["true", "false"] },
        ],
      };
      const { rows: created } = await c.query(
        `INSERT INTO collections (tenant_id, site_id, key, schema) VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.tenantId, tenant.siteId, "redirect", JSON.stringify(schema)],
      );
      collectionId = created[0].id;
    }
    await c.query(
      `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, blocks, seo, publish_state)
       VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6, 'published')
       ON CONFLICT (collection_id, locale, slug) DO UPDATE SET seo = EXCLUDED.seo`,
      [
        tenant.tenantId,
        tenant.siteId,
        collectionId,
        tenant.defaultLocale,
        r.fromPath,
        JSON.stringify({ redirect: { toPath: r.toPath, status: String(r.status), active: String(r.active) } }),
      ],
    );
  });
}
