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

/** Run `fn` in a transaction authorized for exactly `tenantIds` (the authorized-tenant-set). */
export async function withTenants<T>(
  tenantIds: string[],
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_ids', $1, true)", [tenantIds.join(",")]);
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
