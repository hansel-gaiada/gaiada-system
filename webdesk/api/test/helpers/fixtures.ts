// WSK-05 test fixtures. Provisioning a tenant/site/environment/collection is WSK-03's own DDL
// scope, not something this ticket's service writes — so fixtures go in directly over a raw pg
// client, connected as webdesk_migrator (NOBYPASSRLS, same as production), setting the same GUCs
// the real control plane would (platform_ctx for the tenant row, tenant_ctx for everything that
// belongs to one). Every fixture uses a fresh random slug/keys per call so test files never
// collide, and nothing here is cleaned up afterward — the whole database is a throwaway container
// torn down after the run.
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const MIGRATOR_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk";

export type FixtureTenant = {
  tenantId: string;
  slug: string;
  siteId: string;
  stagingEnvId: string;
  productionEnvId: string;
  collectionId: string;
  collectionKey: string;
};

export async function createFixtureTenant(label: string): Promise<FixtureTenant> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    const slug = `wsk05-${label}-${randomUUID().slice(0, 8)}`;
    const tenantId = randomUUID();
    const siteId = randomUUID();
    const stagingEnvId = randomUUID();
    const productionEnvId = randomUUID();
    const collectionId = randomUUID();
    const collectionKey = "case-study";

    await client.query("BEGIN");
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
    await client.query(
      `INSERT INTO tenants (id, slug, company_ref, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, slug, randomUUID()],
    );
    await client.query("SET LOCAL webdesk.platform_ctx = ''");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    await client.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', $3)`, [
      siteId,
      tenantId,
      `${label} site`,
    ]);
    await client.query(
      `INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'staging', 'active')`,
      [stagingEnvId, siteId, tenantId],
    );
    await client.query(
      `INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'production', 'active')`,
      [productionEnvId, siteId, tenantId],
    );
    await client.query(`INSERT INTO collections (id, tenant_id, site_id, key) VALUES ($1, $2, $3, $4)`, [
      collectionId,
      tenantId,
      siteId,
      collectionKey,
    ]);
    await client.query("COMMIT");

    return { tenantId, slug, siteId, stagingEnvId, productionEnvId, collectionId, collectionKey };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/** Seed one content item directly (bypassing the api's own create path) for read-path tests. */
export async function seedContentItem(
  tenant: FixtureTenant,
  opts: { slug: string; locale?: string; publishState?: "draft" | "published" | "scheduled" | "unpublished" },
): Promise<string> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    const id = randomUUID();
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await client.query(
      `INSERT INTO content_items (id, tenant_id, site_id, collection_id, locale, slug, blocks, publish_state)
       VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7)`,
      [id, tenant.tenantId, tenant.siteId, tenant.collectionId, opts.locale ?? "en-US", opts.slug, opts.publishState ?? "draft"],
    );
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/** Raw dump helper for the plaintext-never-at-rest proof — reads EVERY column, superuser-free. */
export async function dumpApiKeysTable(): Promise<Record<string, unknown>[]> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
    // api_keys has no platform-level SELECT bypass in its policy (unlike tenants/audit_entries) —
    // it is single-mode tenant_id = tenant_ctx. Proving "no plaintext anywhere in the table"
    // for real therefore means walking every tenant that exists, not a single privileged query;
    // see dumpAllApiKeyRowsAcrossTenants below, which this file's callers should prefer. Kept
    // here as a thin building block only.
    const { rows } = await client.query(`SELECT * FROM api_keys`);
    await client.query("COMMIT");
    return rows;
  } finally {
    await client.end();
  }
}

/** The real dump-grep proof: every api_keys row, for every tenant that exists, in one pass. */
export async function dumpAllApiKeyRowsAcrossTenants(): Promise<Record<string, unknown>[]> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    const { rows: tenantRows } = await withPlatform(client, () => client.query(`SELECT id FROM tenants`));
    const all: Record<string, unknown>[] = [];
    for (const t of tenantRows) {
      await client.query("BEGIN");
      await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [t.id]);
      const { rows } = await client.query(`SELECT * FROM api_keys`);
      all.push(...rows);
      await client.query("COMMIT");
    }
    return all;
  } finally {
    await client.end();
  }
}

async function withPlatform<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
  const result = await fn();
  await client.query("COMMIT");
  return result;
}
