// WSK-05 — the AsyncLocalStorage side of the tenant-GUC mechanism, generalized from the WSK-00
// spike (webdesk/spike-rls/src/tenant-pool.mjs + webdesk/spike-rls/payload/src/tenant-pg.mjs) for
// this plain NestJS/pg service (no Next.js module graph, no Payload/Drizzle in between).
//
// Anchored on globalThis on purpose, per the ticket brief and per FINDINGS.md's P10 lesson: even
// though this process has none of Next.js's module-graph duplication, pinning the ALS instance to
// a well-known global key means a future bundler/loader change (or this file being required twice
// under two different module ids, e.g. one via `dist/` and one via `ts-node`) can never silently
// fork the store into two disconnected copies the way it did for Payload's admin SSR path.
import { AsyncLocalStorage } from "node:async_hooks";

const GLOBAL_KEY = "__webdesk_tenant_context_als__";

type TenantStore = {
  tenantId: string | null;
  platformCtx: boolean;
};

function getGlobalStore(): AsyncLocalStorage<TenantStore> {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: AsyncLocalStorage<TenantStore> };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new AsyncLocalStorage<TenantStore>();
  }
  return g[GLOBAL_KEY]!;
}

export const tenantContextStore = getGlobalStore();

/** Read the tenant id active for the current async context, or null if none. */
export function currentTenantId(): string | null {
  return tenantContextStore.getStore()?.tenantId ?? null;
}

/** True only inside a deliberately-entered platform-level (no single tenant) operation. */
export function isPlatformCtx(): boolean {
  return tenantContextStore.getStore()?.platformCtx ?? false;
}

/**
 * Run `fn` with `tenantId` active for its entire async subtree (including anything it awaits).
 * Prefer this over `enterTenantContext` whenever the whole unit of work is a single callback you
 * control (mint/rotate/revoke transactions, background jobs) — `run()` is self-scoping and cannot
 * leak into whatever runs after it returns, which `enterWith` cannot guarantee on its own.
 */
export function runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContextStore.run({ tenantId, platformCtx: false }, fn);
}

/**
 * Run `fn` under the platform-level GUC (webdesk.platform_ctx) instead of a tenant id — the one
 * legitimate case for a cross-tenant lookup: resolving a tenant slug into an id before any tenant
 * context exists yet (0001_platform_core.sql's own comment: "the api resolves the tenant from the
 * request host/path before it ever sees the key"). Never set from anything tenant-supplied.
 */
export function runAsPlatform<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContextStore.run({ tenantId: null, platformCtx: true }, fn);
}

/**
 * Edge-of-request variant for NestJS guards: a Nest `CanActivate` cannot wrap "the rest of the
 * pipeline" in a callback (Nest itself owns that continuation), so guards use `enterWith`, which
 * Node documents as persisting "through any following asynchronous calls" in the SAME logical
 * async chain — which every downstream guard/interceptor/handler for this request is, because
 * Nest's Fastify adapter awaits them in one continuous chain rooted at this request's dispatch.
 * Every call site that uses this MUST be the last thing the guard does before returning `true`.
 */
export function enterTenantContext(tenantId: string): void {
  tenantContextStore.enterWith({ tenantId, platformCtx: false });
}
