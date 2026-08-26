-- webdesk/migrations/tests/rls.spec.sql
-- WSK-03 — permanent cross-tenant RLS probe suite for Zone B's platform-core + content + forms
-- + mail schema (0001-0004).
--
-- Run (after applying 0001-0004 to the target database), as a role that can freely SET ROLE to
-- both webdesk_migrator and webdesk_app — the superuser bootstrap connection is the simplest choice
-- and is what this file assumes:
--
--   psql "$SUPERUSER_DATABASE_URL" -v ON_ERROR_STOP=1 -f webdesk/migrations/tests/rls.spec.sql
--
-- The whole file runs inside ONE transaction that is explicitly ROLLED BACK at the end, so it
-- leaves the target database byte-for-byte as it found it and is safe to run repeatedly against
-- a shared dev database, in CI, or by hand. A probe that fails RAISEs an uncaught error, which
-- (with ON_ERROR_STOP) makes psql exit non-zero and print exactly which assertion failed — there
-- is no "silently skipped" outcome.
--
-- What this proves, matching the WSK-03 brief line for line:
--   (1) zero rows via every access path a tenant-scoped session can take
--   (2) no-GUC => zero rows, never an error (the fail-closed property)
--   (3) a cross-tenant INSERT is refused by WITH CHECK
--   (4) the app role cannot run DDL
--   (5) the app role cannot disable RLS (or FORCE) on a table it does not own
-- Plus one bonus probe this ledger's design specifically needs proven, not assumed: that
-- webdesk_migrator (NOBYPASSRLS, per 0001/postgres/init-roles.sh, and the true table OWNER — see 0001's header note) is bound by FORCE RLS exactly like webdesk_app is.

\set ON_ERROR_STOP on

BEGIN;

-- ============================================================================================
-- Fixtures
-- ============================================================================================
-- Even the owner is FORCE-RLS'd (0001's own design point), so fixture setup itself has to go
-- through the same GUCs as real traffic would -- this section is already a live check that the
-- invariant holds for the owner, not just for webdesk_app.

SET LOCAL ROLE webdesk_migrator;

-- Tenant creation is platform-level: there is no tenant yet to scope the INSERT to.
SET LOCAL webdesk.platform_ctx = 'true';

INSERT INTO tenants (id, slug, company_ref, status) VALUES
  ('a0000000-0000-0000-0000-00000000000a', 'wsk03-probe-tenant-a', 'c0000000-0000-0000-0000-0000000000c1', 'active'),
  ('b0000000-0000-0000-0000-00000000000b', 'wsk03-probe-tenant-b', 'c0000000-0000-0000-0000-0000000000c2', 'active')
ON CONFLICT (slug) DO NOTHING;

SET LOCAL webdesk.platform_ctx = '';

-- ---- Tenant A's fixtures ----
SET LOCAL webdesk.tenant_ctx = 'a0000000-0000-0000-0000-00000000000a';

INSERT INTO sites (id, tenant_id, kind, name) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'astro', 'A site')
ON CONFLICT (id) DO NOTHING;

INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'staging', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO api_keys (id, env_id, tenant_id, key_hash, scope) VALUES
  ('a3000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'hash-a', 'read')
ON CONFLICT (id) DO NOTHING;

INSERT INTO releases (id, env_id, tenant_id, version, kind, created_by) VALUES
  ('a4000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '0.0.1', 'deploy', 'probe')
ON CONFLICT (id) DO NOTHING;

INSERT INTO audit_entries (id, tenant_id, actor, action) VALUES
  ('a5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'probe', 'sites.provision')
ON CONFLICT (id) DO NOTHING;

INSERT INTO collections (id, tenant_id, site_id, key) VALUES
  ('a6000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'case-study')
ON CONFLICT (id) DO NOTHING;

INSERT INTO content_items (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id) VALUES
  ('a7000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', 'id-ID', 'acme-rebrand', 'a7ffffff-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO content_versions (id, tenant_id, content_item_id, version, blocks, publish_state, created_by) VALUES
  ('a8000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'a7000000-0000-0000-0000-000000000001', 1, '[]'::jsonb, 'draft', 'probe')
ON CONFLICT (id) DO NOTHING;

INSERT INTO media_assets (id, tenant_id, site_id, bucket_key, mime, size_bytes) VALUES
  ('a9000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'tenant-a/probe.png', 'image/png', 100)
ON CONFLICT (id) DO NOTHING;

INSERT INTO form_defs (id, tenant_id, site_id, key) VALUES
  ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'contact')
ON CONFLICT (id) DO NOTHING;

INSERT INTO submissions (id, tenant_id, site_id, form_def_id, payload, consent_notice_text, consent_notice_version, expires_at) VALUES
  ('ab000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', '{"email":"probe@example.test"}'::jsonb, 'v1 notice text', 'v1', now() + interval '180 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO mail_templates (id, tenant_id, site_id, key, subject, body_html) VALUES
  ('ac000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'welcome', 'Welcome', '<p>hi</p>')
ON CONFLICT (id) DO NOTHING;

INSERT INTO mail_log (id, tenant_id, site_id, to_address, subject) VALUES
  ('ad000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'someone@example.test', 'Welcome')
ON CONFLICT (id) DO NOTHING;

INSERT INTO suppressions (id, tenant_id, address, reason) VALUES
  ('ae000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'bounced@example.test', 'bounce')
ON CONFLICT (id) DO NOTHING;

-- ---- Tenant B's fixtures (mirror set, so cross-tenant leakage has something to leak) ----
SET LOCAL webdesk.tenant_ctx = 'b0000000-0000-0000-0000-00000000000b';

INSERT INTO sites (id, tenant_id, kind, name) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'node', 'B site')
ON CONFLICT (id) DO NOTHING;

INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES
  ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'staging', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO api_keys (id, env_id, tenant_id, key_hash, scope) VALUES
  ('b3000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'hash-b', 'read')
ON CONFLICT (id) DO NOTHING;

INSERT INTO releases (id, env_id, tenant_id, version, kind, created_by) VALUES
  ('b4000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', '0.0.1', 'deploy', 'probe')
ON CONFLICT (id) DO NOTHING;

INSERT INTO audit_entries (id, tenant_id, actor, action) VALUES
  ('b5000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'probe', 'sites.provision')
ON CONFLICT (id) DO NOTHING;

INSERT INTO collections (id, tenant_id, site_id, key) VALUES
  ('b6000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'b1000000-0000-0000-0000-000000000001', 'case-study')
ON CONFLICT (id) DO NOTHING;

INSERT INTO content_items (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id) VALUES
  ('b7000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'b1000000-0000-0000-0000-000000000001', 'b6000000-0000-0000-0000-000000000001', 'en-US', 'globex-launch', 'b7ffffff-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO content_versions (id, tenant_id, content_item_id, version, blocks, publish_state, created_by) VALUES
  ('b8000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'b7000000-0000-0000-0000-000000000001', 1, '[]'::jsonb, 'draft', 'probe')
ON CONFLICT (id) DO NOTHING;

INSERT INTO media_assets (id, tenant_id, site_id, bucket_key, mime, size_bytes) VALUES
  ('b9000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'b1000000-0000-0000-0000-000000000001', 'tenant-b/probe.png', 'image/png', 100)
ON CONFLICT (id) DO NOTHING;

INSERT INTO form_defs (id, tenant_id, site_id, key) VALUES
  ('ba000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'b1000000-0000-0000-0000-000000000001', 'contact')
ON CONFLICT (id) DO NOTHING;

INSERT INTO submissions (id, tenant_id, site_id, form_def_id, payload, consent_notice_text, consent_notice_version, expires_at) VALUES
  ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'b1000000-0000-0000-0000-000000000001', 'ba000000-0000-0000-0000-000000000001', '{"email":"probe@example.test"}'::jsonb, 'v1 notice text', 'v1', now() + interval '180 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO mail_templates (id, tenant_id, site_id, key, subject, body_html) VALUES
  ('bc000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'b1000000-0000-0000-0000-000000000001', 'welcome', 'Welcome', '<p>hi</p>')
ON CONFLICT (id) DO NOTHING;

INSERT INTO mail_log (id, tenant_id, site_id, to_address, subject) VALUES
  ('bd000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'b1000000-0000-0000-0000-000000000001', 'someone@example.test', 'Welcome')
ON CONFLICT (id) DO NOTHING;

INSERT INTO suppressions (id, tenant_id, address, reason) VALUES
  ('be000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'bounced@example.test', 'bounce')
ON CONFLICT (id) DO NOTHING;

-- ---- One platform-level (tenant_id IS NULL) audit entry ----
SET LOCAL webdesk.tenant_ctx = '';
SET LOCAL webdesk.platform_ctx = 'true';
INSERT INTO audit_entries (id, tenant_id, actor, action) VALUES
  ('af000000-0000-0000-0000-000000000001', NULL, 'control-plane', 'platform.boot')
ON CONFLICT (id) DO NOTHING;
SET LOCAL webdesk.platform_ctx = '';

RESET ROLE;

-- ============================================================================================
-- Probe 0 (bonus) — webdesk_migrator, the actual table owner, is bound by FORCE RLS with no GUC set.
-- ============================================================================================
SET LOCAL ROLE webdesk_migrator;
SET LOCAL webdesk.tenant_ctx = '';
SET LOCAL webdesk.platform_ctx = '';
DO $$
DECLARE cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM sites;
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'PROBE 0 FAILED: webdesk_migrator (NOBYPASSRLS, the true table owner) read % site rows with no GUC set — FORCE RLS is not binding the owner', cnt;
  END IF;
  RAISE NOTICE 'PASS (0): webdesk_migrator (the true table owner) with no GUC set reads zero rows too (FORCE RLS binds the owner, not just the app role)';
END $$;
RESET ROLE;

-- ============================================================================================
-- Probe 1 — tenant A's session sees exactly tenant A's rows, on every tenant-scoped table.
-- ============================================================================================
SET LOCAL ROLE webdesk_app;
SET LOCAL webdesk.tenant_ctx = 'a0000000-0000-0000-0000-00000000000a';
SET LOCAL webdesk.platform_ctx = '';
DO $$
DECLARE cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM tenants; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: tenants visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM sites; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: sites visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM environments; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: environments visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM api_keys; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: api_keys visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM releases; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: releases visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM audit_entries; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: audit_entries visible to A = % (want 1 — its own tenant row, NOT the platform-level row)', cnt; END IF;
  SELECT count(*) INTO cnt FROM collections; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: collections visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM content_items; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: content_items visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM content_versions; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: content_versions visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM media_assets; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: media_assets visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM form_defs; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: form_defs visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM submissions; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: submissions visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM mail_templates; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: mail_templates visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM mail_log; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: mail_log visible to A = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM suppressions; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 1 FAILED: suppressions visible to A = % (want 1)', cnt; END IF;
  -- Direct id lookup of B's row must also come back empty, not just the count being right.
  SELECT count(*) INTO cnt FROM sites WHERE id = 'b1000000-0000-0000-0000-000000000001';
  IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 1 FAILED: tenant A can see tenant B''s site by direct id lookup'; END IF;
  RAISE NOTICE 'PASS (1): tenant A sees exactly its own rows on every tenant-scoped table, and cannot reach B''s site by id';
END $$;
RESET ROLE;

-- ============================================================================================
-- Probe 2 — symmetric check for tenant B.
-- ============================================================================================
SET LOCAL ROLE webdesk_app;
SET LOCAL webdesk.tenant_ctx = 'b0000000-0000-0000-0000-00000000000b';
SET LOCAL webdesk.platform_ctx = '';
DO $$
DECLARE cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM sites; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 2 FAILED: sites visible to B = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM submissions; IF cnt <> 1 THEN RAISE EXCEPTION 'PROBE 2 FAILED: submissions visible to B = % (want 1)', cnt; END IF;
  SELECT count(*) INTO cnt FROM sites WHERE id = 'a1000000-0000-0000-0000-000000000001';
  IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 2 FAILED: tenant B can see tenant A''s site by direct id lookup'; END IF;
  RAISE NOTICE 'PASS (2): tenant B sees exactly its own rows, and cannot reach A''s site by id';
END $$;
RESET ROLE;

-- ============================================================================================
-- Probe 3 — no GUC set at all => ZERO rows on every path, and it is an empty result, not an
-- error. (The single most important fail-closed property in the whole design.)
-- ============================================================================================
SET LOCAL ROLE webdesk_app;
SET LOCAL webdesk.tenant_ctx = '';
SET LOCAL webdesk.platform_ctx = '';
DO $$
DECLARE cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM tenants; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: tenants readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM sites; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: sites readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM environments; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: environments readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM api_keys; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: api_keys readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM releases; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: releases readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM audit_entries; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: audit_entries readable with no GUC set (%) — includes the platform-level row, which must ALSO stay hidden without platform_ctx', cnt; END IF;
  SELECT count(*) INTO cnt FROM collections; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: collections readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM content_items; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: content_items readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM content_versions; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: content_versions readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM media_assets; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: media_assets readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM form_defs; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: form_defs readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM submissions; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: submissions readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM mail_templates; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: mail_templates readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM mail_log; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: mail_log readable with no GUC set (%)', cnt; END IF;
  SELECT count(*) INTO cnt FROM suppressions; IF cnt <> 0 THEN RAISE EXCEPTION 'PROBE 3 FAILED: suppressions readable with no GUC set (%)', cnt; END IF;
  RAISE NOTICE 'PASS (3): every tenant-scoped table reads ZERO rows with no GUC set, and none of the 14 SELECTs above raised an error';
END $$;
RESET ROLE;

-- ============================================================================================
-- Probe 4 — a cross-tenant INSERT (tenant_ctx=A, row's own tenant_id=B) is refused by
-- WITH CHECK, on the plain single-tenant tables (sites) and on the two dual-mode tables
-- (tenants, audit_entries) with platform_ctx correctly left off.
-- ============================================================================================
SET LOCAL ROLE webdesk_app;
SET LOCAL webdesk.tenant_ctx = 'a0000000-0000-0000-0000-00000000000a';
SET LOCAL webdesk.platform_ctx = '';
DO $$
BEGIN
  BEGIN
    INSERT INTO sites (id, tenant_id, kind, name)
      VALUES ('c1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'astro', 'cross-tenant attempt');
    RAISE EXCEPTION 'PROBE 4 FAILED: cross-tenant INSERT into sites (tenant_ctx=A, row tenant_id=B) was NOT rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%row-level security%' THEN
      RAISE NOTICE 'PASS (4a): cross-tenant insert into sites refused — %', SQLERRM;
    ELSE
      RAISE;
    END IF;
  END;

  BEGIN
    INSERT INTO tenants (id, slug, company_ref) VALUES ('c2000000-0000-0000-0000-000000000001', 'wsk03-should-not-exist', 'c0000000-0000-0000-0000-000000000099');
    RAISE EXCEPTION 'PROBE 4 FAILED: tenant_ctx=A (no platform_ctx) was able to INSERT a brand-new tenants row';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%row-level security%' THEN
      RAISE NOTICE 'PASS (4b): a plain tenant session cannot create a new tenants row without platform_ctx — %', SQLERRM;
    ELSE
      RAISE;
    END IF;
  END;

  BEGIN
    INSERT INTO audit_entries (id, tenant_id, actor, action)
      VALUES ('c3000000-0000-0000-0000-000000000001', NULL, 'a-tenant-pretending-to-be-platform', 'forged');
    RAISE EXCEPTION 'PROBE 4 FAILED: tenant_ctx=A (no platform_ctx) was able to INSERT a platform-level (tenant_id NULL) audit_entries row';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%row-level security%' THEN
      RAISE NOTICE 'PASS (4c): a plain tenant session cannot forge a platform-level audit entry — %', SQLERRM;
    ELSE
      RAISE;
    END IF;
  END;
END $$;
RESET ROLE;

-- ============================================================================================
-- Probe 4d/4e — the exact regression this file's own verification run found: an EARLIER version
-- of the tenants policy used the same symmetric `id = tenant_ctx OR platform_ctx` shape on every
-- command, including INSERT/UPDATE, and a real password-authenticated webdesk_app connection
-- (not a SET-ROLE stand-in) was able to (a) fabricate a brand-new tenant by simply setting
-- tenant_ctx to a UUID of its own choosing and inserting a tenants row with that same id, and
-- would equally have been able to (b) update its OWN existing tenants row — because on this one
-- table the "identity" column and the "scope" GUC are the same value, so WITH CHECK
-- (id = tenant_ctx) is trivially satisfiable by whoever picks tenant_ctx. Fixed by splitting
-- SELECT (id = tenant_ctx OR platform_ctx, a convenience) away from INSERT/UPDATE/DELETE
-- (platform_ctx only, unconditionally). This probe is permanent so that fix can never regress
-- silently.
-- ============================================================================================
SET LOCAL ROLE webdesk_app;
SET LOCAL webdesk.tenant_ctx = 'd0000000-0000-0000-0000-000000000d00';  -- a UUID nobody has yet
SET LOCAL webdesk.platform_ctx = '';
DO $$
DECLARE cnt int;
BEGIN
  BEGIN
    INSERT INTO tenants (id, slug, company_ref)
      VALUES ('d0000000-0000-0000-0000-000000000d00', 'wsk03-self-declared-tenant', 'c0000000-0000-0000-0000-000000000098');
    RAISE EXCEPTION 'PROBE 4d FAILED: a session fabricated a brand-new tenant by setting tenant_ctx to its own chosen id and inserting a matching row, with no platform_ctx';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%row-level security%' THEN
      RAISE NOTICE 'PASS (4d): a session cannot fabricate a new tenant by matching id to its own self-chosen tenant_ctx — %', SQLERRM;
    ELSE
      RAISE;
    END IF;
  END;

  -- Same shape against an EXISTING tenant: ctx=A, targeting its OWN row, no platform_ctx.
  -- UPDATE's USING clause simply hides the row rather than raising, so this checks ROW_COUNT
  -- instead of expecting an exception.
  PERFORM set_config('webdesk.tenant_ctx', 'a0000000-0000-0000-0000-00000000000a', true);
  UPDATE tenants SET status = 'archived' WHERE id = 'a0000000-0000-0000-0000-00000000000a';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt > 0 THEN
    RAISE EXCEPTION 'PROBE 4e FAILED: a tenant session updated its OWN tenants row (% row(s)) with no platform_ctx', cnt;
  END IF;
  RAISE NOTICE 'PASS (4e): UPDATE on tenants'' own row affects zero rows without platform_ctx';
END $$;
RESET ROLE;

-- ============================================================================================
-- Probe 5 — the app role cannot run DDL (no CREATE on schema public was ever granted to it).
-- ============================================================================================
SET LOCAL ROLE webdesk_app;
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE TABLE probe_ddl_should_never_exist (id int)';
    RAISE EXCEPTION 'PROBE 5 FAILED: webdesk_app was able to CREATE TABLE';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS (5): webdesk_app cannot CREATE TABLE — %', SQLERRM;
  END;
END $$;
RESET ROLE;

-- ============================================================================================
-- Probe 6 — the app role cannot disable RLS (or drop FORCE) on a table it does not own.
-- ============================================================================================
SET LOCAL ROLE webdesk_app;
DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER TABLE sites DISABLE ROW LEVEL SECURITY';
    RAISE EXCEPTION 'PROBE 6 FAILED: webdesk_app was able to DISABLE ROW LEVEL SECURITY on sites';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS (6a): webdesk_app cannot DISABLE ROW LEVEL SECURITY — %', SQLERRM;
  END;

  BEGIN
    EXECUTE 'ALTER TABLE sites NO FORCE ROW LEVEL SECURITY';
    RAISE EXCEPTION 'PROBE 6 FAILED: webdesk_app was able to lift FORCE ROW LEVEL SECURITY on sites';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS (6b): webdesk_app cannot lift NO FORCE ROW LEVEL SECURITY — %', SQLERRM;
  END;
END $$;
RESET ROLE;

-- ============================================================================================
-- Done. Roll back every fixture and leave the database exactly as found.
-- ============================================================================================
ROLLBACK;
