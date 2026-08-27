// WSK-15 — the ONLY file in this directory that talks to Postgres. Resolves a tenant slug into
// its composition (`collections.schema` jsonb, per WSK-06/§04) under the same
// `webdesk.platform_ctx` / `webdesk.tenant_ctx` GUC mechanism every other Zone B service uses
// (0001_platform_core.sql's own fail-closed design) — a plain `pg.Pool` + explicit
// `SET LOCAL`/`set_config` inside one transaction, deliberately NOT the NestJS `TenantAwarePool`/
// AsyncLocalStorage machinery (`../../db/tenant-pool.ts`): that mechanism exists to make tenant
// context survive an ASYNC, CONCURRENT, per-HTTP-request call graph inside a long-lived server
// process. This is a short-lived, single-tenant, single-threaded CLI script — a plain transaction
// is the correct-sized tool, not a missing reuse of the server-side one.
import pg from "pg";
import type { TenantComposition } from "../../../../payload/vocabulary/composition.ts";

export interface FetchedTenantComposition {
  tenantId: string;
  tenantSlug: string;
  defaultLocale: string;
  locales: string[];
  /** Excludes the fixed `redirect` collection — see `openapi-builder.mts`'s header on why. */
  composition: TenantComposition;
}

/** The one fixed collection this pipeline never exposes as page content (redirects.ts's own
 *  header: "a redirect is never page content and never flows through the block vocabulary"). */
const EXCLUDED_COLLECTION_KEYS = new Set(["redirect"]);

export async function fetchTenantComposition(pool: pg.Pool, tenantSlug: string): Promise<FetchedTenantComposition | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let tenant: { id: string; default_locale: string; locales: string[] } | undefined;
    try {
      await client.query(`SELECT set_config('webdesk.platform_ctx', 'true', true)`);
      const { rows } = await client.query<{ id: string; default_locale: string; locales: string[] }>(
        `SELECT id, default_locale, locales FROM tenants WHERE slug = $1 AND status = 'active'`,
        [tenantSlug],
      );
      tenant = rows[0];
    } finally {
      // Cleared before the tenant-scoped read below runs, in the SAME transaction — mirrors
      // db.service.ts's `withPlatformCtx`'s own "never left active beyond this one lookup" rule.
      await client.query(`SELECT set_config('webdesk.platform_ctx', '', true)`);
    }
    if (!tenant) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(`SELECT set_config('webdesk.tenant_ctx', $1, true)`, [tenant.id]);
    const { rows: collectionRows } = await client.query<{ key: string; schema: unknown }>(
      // ORDER BY key: deterministic iteration order downstream (openapi-builder.mts/content-contract-md.mts
      // both consume Object.keys(composition) — this is what makes that order reproducible run to
      // run, which the double-run gate depends on).
      `SELECT key, schema FROM collections WHERE tenant_id = $1 ORDER BY key`,
      [tenant.id],
    );
    await client.query("COMMIT");

    const composition: TenantComposition = {};
    for (const row of collectionRows) {
      if (EXCLUDED_COLLECTION_KEYS.has(row.key)) continue;
      composition[row.key] = (row.schema ?? {}) as TenantComposition[string];
    }

    return { tenantId: tenant.id, tenantSlug, defaultLocale: tenant.default_locale, locales: tenant.locales, composition };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
