/**
 * WSK-04b (WSK-D25) — Payload's OWN app-layer tenant predicate, independent of the
 * `webdesk.tenant_ctx` Postgres GUC.
 *
 * WHY THIS FILE EXISTS: WSK-04 proved mutual independence (RLS and an app-layer filter can each
 * fail on their own and the other still isolates tenants) on `webdesk/api`'s `ContentService`,
 * whose `WHERE site_id = $1` predicate is ordinary application SQL, unrelated to Postgres RLS.
 * Payload's collections had no equivalent — the ONLY thing standing between a cross-tenant read
 * and Postgres was `src/tenant-pg.mjs`'s GUC stamp. If that stamp is ever skipped (a bug in the
 * pool subclass, a future `@payloadcms/db-postgres` upgrade that stops routing through
 * `Pool.connect()`) *and* RLS is separately disarmed (the proven, reproduced dev-push hazard —
 * see `webdesk/spike-rls/payload/FINDINGS.md`'s addendum), there was nothing left. WSK-D25 rules
 * that gap closed: Payload collections carrying `tenantId` get their own `access` predicate,
 * built from Payload's own access-control API (a `Where`-returning function — see
 * `node_modules/payload/dist/config/types.d.ts`'s `AccessResult = boolean | Where`), not a
 * boolean gate.
 *
 * INDEPENDENCE, MADE CONCRETE: this predicate reads the tenant id from `tenantStore`
 * (`./tenant-pool.mjs`'s `globalThis`-anchored AsyncLocalStorage), the SAME value the request
 * edge (`tenant-context.mjs`'s `runWithTenant()`) established — but it never touches Postgres to
 * get it. `tenant-pg.mjs`'s GUC stamp is a SEPARATE write, on a SEPARATE object (the pooled `pg`
 * connection), performed by a SEPARATE piece of code (`TenantAwarePool#connect()`). A bug that
 * makes the pool subclass stop stamping the GUC does not touch this file's read of `tenantStore`;
 * a bug in this file (or its removal) does not touch the GUC stamp. That is what "independent" has
 * to mean for the mutual-independence proof to be more than a coincidence: two mechanisms with
 * disjoint code paths to disjoint state, not two call sites of the same underlying fact.
 *
 * WHY THIS DOES NOT BREAK overrideAccess CALLERS (setup-schema.mjs, seeding/admin bootstrap):
 * Payload's Local API defaults every operation to `overrideAccess: true`
 * (`node_modules/payload/dist/collections/operations/local/{find,create,update,delete}.js`), and
 * `executeAccess()` (`node_modules/payload/dist/auth/executeAccess.js`) only calls a collection's
 * `access.*` function at all when the caller's `overrideAccess` is falsy
 * (`node_modules/payload/dist/collections/operations/find.js`: `if (!overrideAccess) { ... }`,
 * same shape in create/update/delete). This file's functions are therefore INERT for any Local API
 * call that does not explicitly pass `overrideAccess: false` — which is every call
 * `setup-schema.mjs` makes (via `getPayload({config})`'s dev-push path, which does not touch
 * collection data at all) and every plain `payload.create/find/update/delete(...)` a future
 * seeding script writes without opting in. REST (`app/(payload)/api/[...slug]/route.ts`) and the
 * admin panel's own client-side fetches through that same route DO enforce access (the REST
 * operations never set `overrideAccess`, so it is `undefined` -> falsy -> access runs) — which is
 * exactly the staff-facing surface WSK-D24 keeps Payload responsible for.
 *
 * FAIL-CLOSED, both directions: no tenant in `tenantStore` -> `false` (denies outright; Payload
 * turns a `false`/empty-Where read into a Forbidden or an empty result set, never an error) rather
 * than an unscoped `Where` that would fall through to "everything." Reads/updates/deletes get a
 * `Where` clause Payload folds into its own query (`combineQueries` in
 * `node_modules/payload/dist/collections/operations/find.js`) alongside whatever the caller
 * requested — so a caller cannot use its own `where` to sidestep the tenant filter, Payload ANDs
 * them. `create` gets a boolean check against `data.tenantId` because a `Where` has no document to
 * filter at create time (see `executeAccess`'s own comment: "If the result is `true`, the user has
 * access. If the result is an object, it is interpreted as a ... query" — nothing to query yet on
 * create).
 */
import { tenantStore } from './tenant-pool.mjs'

/** The tenant id `runWithTenant()` established for this async context, or null. Exported for
 *  tests that want to assert on it directly without duplicating the AsyncLocalStorage read. */
export function currentTenantId() {
  return tenantStore.getStore() ?? null
}

/**
 * read/update/delete: a Where-returning access function (Payload's documented API — see this
 * file's header). Fails closed (`false`) with no tenant context. Never falls back to "no filter."
 */
export const tenantScopedWhere = () => {
  const tenantId = currentTenantId()
  if (!tenantId) return false
  return { tenantId: { equals: tenantId } }
}

/**
 * create: boolean-only (no document exists yet to build a Where against). Denies with no tenant
 * context, and denies a create whose own `data.tenantId` does not match the resolved tenant --
 * closing the write-side of the same gap (a caller cannot create a row stamped for a DIFFERENT
 * tenant than the one the request edge resolved, even though nothing here touches the DB layer).
 */
/** @param {{ data?: { tenantId?: string } }} args -- `data` is optional in Payload's own
 *  `AccessArgs` type (it is omitted for list-level access checks); annotated here so `tsc`
 *  checking this file via `allowJs` infers the same optionality `payload.config.ts`'s `Access`
 *  type expects, instead of a stricter "required" shape inferred from the bare destructure. */
export const tenantScopedCreate = ({ data } = {}) => {
  const tenantId = currentTenantId()
  if (!tenantId) return false
  if (!data || typeof data.tenantId !== 'string' || data.tenantId !== tenantId) return false
  return true
}

/**
 * Convenience: the full `access` block for a Payload collection carrying `tenantId`. Every
 * present/future tenant-scoped collection should spread this in, e.g.:
 *
 *   { slug: 'pages', fields: [...], access: tenantScopedAccess() }
 *
 * `admin`/staff-elevated overrides are deliberately NOT built in here -- this predicate has no
 * concept of a staff role today (Payload's `users` collection carries no tenant/role fields yet).
 * When one exists, it is an explicit, reviewed addition to these four functions, not a bypass
 * flag threaded through this module.
 */
export function tenantScopedAccess() {
  return {
    create: tenantScopedCreate,
    read: tenantScopedWhere,
    update: tenantScopedWhere,
    delete: tenantScopedWhere,
  }
}
