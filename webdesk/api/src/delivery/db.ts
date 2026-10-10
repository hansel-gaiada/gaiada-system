// WSK-48a — the one seam between the moved /v1 read code and the api's own tenant pool.
//
// The Payload-hosted copy ran a SECOND tenant-aware pool (collections/db.ts on src/tenant-pg.mjs).
// In the api there is exactly one: DbService (src/db/), whose TenantAwarePool stamps/scrubs
// `webdesk.tenant_ctx` on every checkout from the AsyncLocalStorage context `withTenant` opens.
// `DeliveryDb` is the shape content-read.ts / redirects.ts need — "give me ONE checked-out client
// with the tenant GUC stamped for the whole callback" (the read code issues several dependent
// queries per request, e.g. collection lookup -> item fetch -> localization siblings) — expressed as
// a view over DbService so those files stay free of Nest.
import type { PoolClient } from "pg";
import type { DbService } from "../db/db.service";

export interface DeliveryDb {
  /** Every query issued through `client` inside `fn` carries webdesk.tenant_ctx = tenantId. */
  withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

export function deliveryDbFrom(db: DbService): DeliveryDb {
  return {
    withTenant: (tenantId, fn) =>
      db.withTenant(tenantId, async (d) => {
        // pool.connect() inside the ALS context db.withTenant just opened: TenantAwarePool stamps the
        // tenant GUC on checkout and scrubs it on release (same shape DbService.transaction uses).
        const client = await d.pool.connect();
        try {
          return await fn(client);
        } finally {
          client.release();
        }
      }),
  };
}
