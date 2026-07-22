// DB access. D5 is enforced here: every tenant-scoped query runs inside a transaction
// whose authorized-tenant-SET is set with SET LOCAL semantics (set_config(..., true)),
// so pooled connections can never leak a tenant context between requests.
import { Pool, type PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { config } from "../config";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    if (!config.databaseUrl) throw new Error("DATABASE_URL not set");
    pool = new Pool({ connectionString: config.databaseUrl });
  }
  return pool;
}

/** For tests: point the module at a specific database. */
export function setPool(p: Pool): void {
  pool = p;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}

/** Time-ordered UUID v7 (spec §2: index locality + sync ordering). */
export const newId = (): string => uuidv7();

export interface WithTenantsOptions {
  /** WSD-4 (HR design §2.4 / ORG-3): module keys this request DECLARES it is operating
   *  inside, set as the second GUC `app.scopes` (CSV). Module-owned tables compose their
   *  tenant_isolation policy as `tenant_id = ANY(app_current_tenants()) AND
   *  app_module_allowed('<mod>')` — the third, in-DB wall. Omitted/empty -> the GUC stays
   *  unset -> app_module_allowed() is false for every module -> those tables read/write
   *  ZERO rows even with a correct tenant set (fail-closed by construction). Core (non-
   *  module-owned) tables have no such predicate and are unaffected either way. */
  modules?: string[];
}

/** Run `fn` in a transaction authorized for exactly `tenantIds` (the authorized-tenant-set).
 *  `opts.modules`, when given, additionally declares the request's module scope (see
 *  WithTenantsOptions) — required for any handler touching a module-sliced table (e.g. the
 *  hr_* tables, WSD-3). */
export async function withTenants<T>(
  tenantIds: string[],
  fn: (client: PoolClient) => Promise<T>,
  opts?: WithTenantsOptions,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_ids', $1, true)", [tenantIds.join(",")]);
    if (opts?.modules?.length) {
      await client.query("SELECT set_config('app.scopes', $1, true)", [opts.modules.join(",")]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Global-table access (users, roles, permissions, identity_links): no tenant context. */
export async function withGlobal<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
