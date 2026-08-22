// SMM-22 — `declareSocialModuleScope` extracted verbatim from `publish-precondition.ts` into its
// own leaf module. WHY: `usage-ledger.ts` (this ticket's new ledger/stop-loss surface) needs this
// function too, and `publish-precondition.ts` (this ticket's OTHER file) needs `usage-ledger.ts`'s
// budget arithmetic for its own budget stage — importing the function from `publish-precondition.ts`
// directly would make that a circular import (`publish-precondition.ts` -> `usage-ledger.ts` ->
// `publish-precondition.ts`). This file is the shared leaf both sides import from instead.
//
// `publish-precondition.ts` re-exports this symbol under its own original name so EVERY existing
// import of `declareSocialModuleScope` from `"./publish-precondition"` (dispatch.ts,
// reply-precondition.ts, inbox-retention-job.ts, inbox-sync-job.ts, inbox-triage-job.ts,
// client-review.ts — none of them touched by this ticket) keeps compiling unchanged. Nothing about
// the function's behavior, name, or doc moved — only its physical file.
import type { PoolClient } from "pg";

/**
 * ⚠ THE SINGLE MOST IMPORTANT LINE IN THIS MODULE. Every `social_*` table carries 0105's THREE-wall
 * policy: `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social')`. A generic
 * caller (the D14 executor, a scheduled sweep, this ticket's own reservation function) opens its
 * transaction with `withTenants([tenantId], ...)` and NO `{modules}` option — it has no business
 * knowing which module it is about to touch. With `app.scopes` unset, `app_module_allowed('social')`
 * is FALSE and every query against a `social_*` table reads ZERO ROWS, silently, fail-closed. For a
 * READ that answer can look like "not found"; for a LEDGER READ feeding a stop-loss decision it
 * looks like "nobody has spent anything yet" — the single sharpest trap in this module, since it
 * would make the stop-loss never trip.
 *
 * So every caller declares its own module scope, ADDITIVELY and idempotently, on its OWN
 * transaction. `set_config(..., true)` is transaction-local (it unwinds at COMMIT/ROLLBACK), it adds
 * a scope rather than replacing one, and it is not a data write.
 *
 * Reuse this EXACT function rather than growing a second copy — a hand-written duplicate is exactly
 * how the two copies would drift.
 */
export async function declareSocialModuleScope(c: PoolClient): Promise<void> {
  await c.query(
    `SELECT set_config('app.scopes',
       CASE
         WHEN coalesce(current_setting('app.scopes', true), '') = '' THEN 'social'
         WHEN 'social' = ANY(string_to_array(current_setting('app.scopes', true), ',')) THEN current_setting('app.scopes', true)
         ELSE current_setting('app.scopes', true) || ',social'
       END, true)`,
  );
}
