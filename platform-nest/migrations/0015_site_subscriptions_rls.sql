-- Close the D5 gap on site_subscriptions (the central node->tenant ACL). It has a tenant_id but is
-- NOT tenant-isolated: the sync engine reads it with no tenant context ("which tenants may node X
-- touch?" — internal/protocol/acl.go, internal/gc/tombstone.go), so a tenant-isolation policy would
-- return zero rows and break the ACL/GC. But leaving it with NO RLS lets the shared gaiada_app owner
-- (which also runs the platform) read/tamper with the sync ACL.
--
-- Fix: FORCE RLS gated on a session GUC the SYNC ENGINE opts into (app.sync_context='on', set per
-- connection in sync-engine-go internal/db.NewPool). The platform never sets it, so it is fail-closed
-- out of the ACL (zero rows), while the sync engine's context-free reads/writes still work. This is a
-- defense-in-depth barrier against accidental cross-touch by the shared role — a hard boundary needs a
-- separate DB role (target-state). FORCE RLS applies to DML only, so migrations/DDL are unaffected.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE site_subscriptions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE site_subscriptions FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS sync_context ON site_subscriptions';
  EXECUTE 'CREATE POLICY sync_context ON site_subscriptions FOR ALL
    USING (current_setting(''app.sync_context'', true) = ''on'')
    WITH CHECK (current_setting(''app.sync_context'', true) = ''on'')';
END $$;
