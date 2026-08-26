/**
 * WSK-02 — the tenant AsyncLocalStorage instance, anchored on globalThis.
 *
 * Ported from the WSK-00 spike's `spike-rls/src/tenant-pool.mjs`, with ONE deliberate change:
 * this file is what FINDINGS.md's P10 section flagged as needed and explicitly left UNTESTED
 * ("a plausible fix exists — anchor the AsyncLocalStorage instance on globalThis ... but that
 * file is layer 1's, frozen for this ticket, and applying an unproven fix mid-spike is exactly
 * the 'workaround invented mid-ticket' the ruling says to avoid"). WSK-02 is not frozen, and this
 * ticket's job description explicitly says to apply and test it — see test/lockdown.test.mjs and
 * test/boot.test.mjs, which exercise the admin SSR path (the exact path P10 found broken) against
 * this file.
 *
 * WHY this was necessary (restated from FINDINGS.md P10, do not re-derive from scratch): Next.js's
 * App Router compiles Route Handlers (`route.ts`) and Page/Server Components (`page.tsx`) as
 * separate build "layers." A plain `export const tenantStore = new AsyncLocalStorage()` gets
 * re-instantiated once per layer that imports this module, even though every layer's import
 * specifier looks identical in source. Payload's real connection pool is a SINGLE shared object
 * (cached inside `getPayload()`), wired to whichever layer's copy of `tenant-pg.mjs` happened to
 * evaluate first — every OTHER layer's `runWithTenant()` writes to a dead-end AsyncLocalStorage
 * instance the real pool's checkout hook never reads. `globalThis` is process-wide and immune to
 * module-graph duplication: stashing the one real instance there means every layer that imports
 * this file, however many times the bundler duplicates the module record, resolves to the exact
 * same AsyncLocalStorage object.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const GLOBAL_KEY = '__webdesk_payload_tenant_store__'

if (!globalThis[GLOBAL_KEY]) {
  globalThis[GLOBAL_KEY] = new AsyncLocalStorage()
}

/** The one real tenant-context AsyncLocalStorage for this process, however many module-graph
 *  copies of this file's specifier Next.js's bundler creates. */
export const tenantStore = globalThis[GLOBAL_KEY]
