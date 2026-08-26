// webdesk/payload/collections/db.ts
//
// WSK-06 — a dedicated tenant-aware pg pool for the /v1 content-read path. This is a SECOND
// consumer of the mechanism WSK-00/WSK-02 proved (src/tenant-pg.mjs's TenantAwarePool +
// src/tenant-pool.mjs's globalThis-anchored AsyncLocalStorage), imported here read-only — this
// file does not fork or reimplement that mechanism. It is not the same pool object as Payload's
// own postgresAdapter pool: @payloadcms/db-postgres never exposes its internal drizzle pool as a
// stable public API, so a second, independently-sized pool against the SAME Zone B database
// (same tenantAwarePg.Pool subclass, same tenantStore) is the supported shape here, exactly the
// way the NestJS `api` service (webdesk/api/src/db/*) also runs its own independent pool against
// this database rather than sharing Payload's.
import type { Pool, PoolClient } from 'pg'
// @ts-expect-error - plain .mjs, no types authored for this project's tenancy files (WSK-02)
import { tenantAwarePg, tenantStore } from '../src/tenant-pg.mjs'

const GUC_PLATFORM = 'webdesk.platform_ctx'

let pool: Pool | null = null

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URI
    if (!connectionString) {
      throw new Error('[webdesk-v1] DATABASE_URI is not set — the /v1 content-read pool refuses to boot')
    }
    pool = new tenantAwarePg.Pool({
      connectionString,
      max: Number(process.env.WEBDESK_V1_POOL_MAX || 5),
    })
  }
  return pool as Pool
}

/**
 * Every query issued inside `fn` carries `webdesk.tenant_ctx = tenantId` for its whole checkout
 * (fail-closed: TenantAwarePool stamps '' when the ALS store is empty, which every FORCE-RLS
 * policy in this database treats as "match nothing" — see 0001_platform_core.sql's own comment
 * on `webdesk_tenant_ctx()`).
 */
export async function withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return tenantStore.run(tenantId, async () => {
    const client = await getPool().connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  })
}

/**
 * The one legitimate cross-tenant path (0001_platform_core.sql's own comment, mirrored from the
 * api service's `DbService.withPlatformCtx`): resolving a tenant SLUG into an id before any
 * tenant context exists yet. `webdesk.platform_ctx` is set explicitly on the checked-out client
 * for exactly the duration of `fn`, then cleared before release — never left active beyond this
 * one lookup, and never derived from anything tenant-supplied.
 */
export async function withPlatformCtx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return tenantStore.run(null, async () => {
    const client = await getPool().connect()
    try {
      await client.query(`select set_config('${GUC_PLATFORM}', 'true', false)`)
      return await fn(client)
    } finally {
      await client.query(`select set_config('${GUC_PLATFORM}', '', false)`).catch(() => {})
      client.release()
    }
  })
}

/** For tests/tooling that need a clean shutdown (mirrors DbService.onModuleDestroy's shape). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
