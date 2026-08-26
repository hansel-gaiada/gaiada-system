// WSK-05 — thin DB access wrapper. Every tenant-scoped query in this service goes through
// `withTenant`/`withPlatformCtx`, never a bare `pool.query()` with no context — the GUC mechanism
// only protects a query that actually runs while a context is active.
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { PoolClient, QueryResultRow } from "pg";
import { createTenantAwarePool, TenantAwarePool } from "./tenant-pool";
import { runAsPlatform, runWithTenant } from "./tenant-context";

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: TenantAwarePool;

  constructor(connectionString: string, max = 10) {
    this.pool = createTenantAwarePool({ connectionString, max });
  }

  /** Plain query, run under whatever tenant context (if any) is currently active. */
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return this.pool.query<T>(text, params);
  }

  /** Run `fn` with `webdesk.tenant_ctx` = tenantId for every query `fn` issues. */
  withTenant<T>(tenantId: string, fn: (db: DbService) => Promise<T>): Promise<T> {
    return runWithTenant(tenantId, () => fn(this));
  }

  /**
   * A single connection, explicitly checked out, with `webdesk.platform_ctx` stamped for the
   * duration — the one legitimate cross-tenant path (0001_platform_core.sql's own comment):
   * resolving a tenant slug into an id before any tenant context exists, or a platform-level
   * audit row. Runs OUTSIDE the ALS mechanism deliberately (this is a short, self-contained
   * operation the caller fully controls, not something that needs to propagate through an
   * arbitrary downstream call chain), matching the migration test's own
   * `SET LOCAL webdesk.platform_ctx` usage pattern.
   */
  async withPlatformCtx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runAsPlatform(async () => {
      const client = await this.pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    });
  }

  /** A transaction under an already-active tenant context (BEGIN/COMMIT/ROLLBACK). */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
