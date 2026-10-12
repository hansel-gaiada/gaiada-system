-- webdesk/migrations/0019_site_status.sql
-- WebDesk site.archive (owner ruling 2026-10-12: archiving a site TAKES an approval): one additive column on
-- `sites`, the same lifecycle column `tenants` and `environments` already carry.
--
--   status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
--
-- Why it exists: 0001's `sites` never got a status, so `site.archive` had nowhere to record an archived
-- state and answered 501 (api/README "What could not be built as specified"). Design §05's sketch gives
-- `tenants` exactly this column; sites gets the same shape.
--
-- Every existing row becomes 'active' (the DEFAULT), so validating the CHECK at ADD time reads the table
-- once and cannot fail. There is no un-archive: nothing in this ledger moves a site back to 'active', the
-- same as tenant.archive (a status that only ever moves one way, written only by the WS4-gated command).
--
-- RLS and grants: nothing to do. `sites` keeps its FORCE ROW LEVEL SECURITY policy (0001) and a new column
-- of an existing table inherits the table-level grants, so webdesk_app can UPDATE it exactly as it already
-- updates tenants.status / environments.status.
--
-- No DML, so this file is clear of the RLS zero-row trap (lint-migration-rls.mjs). Re-runnable: IF NOT
-- EXISTS on the column; the inline CHECK is created with it and is never re-added.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'));

COMMENT ON COLUMN sites.status IS
  'site.archive (2026-10-12): active | archived. archived is terminal and written only by the WS4-gated site.archive command; an archived site''s keys stop resolving, its control-plane routes refuse (409 site-archived), its pending schedules are skipped, its preview tokens 404.';
