-- webdesk/migrations/0005_tenant_locales.sql
-- WSK-06 — adds the tenant-level locale declaration the frozen /v1 envelope's locale rule
-- depends on (webdesk-design.md §05, WSK-D18): "a tenant declares its locale set and a default
-- at provisioning; every content read resolves to exactly one locale (?locale=, else the tenant
-- default)". 0001_platform_core.sql's `tenants` table (WSK-03) has no locale columns at all — a
-- genuine schema gap for this ticket's frozen contract, not something WSK-06 can route around
-- with an app-layer default, because the default is PER TENANT (an Indonesian client's default
-- is id-ID; an English-market client's may not be).
--
-- Justification for a NEW migration rather than editing 0001 directly (this ticket's hard
-- constraint: 0001-0004 are frozen/owned by other tickets): this is a pure
-- ADD COLUMN ... DEFAULT, metadata-only in PG 11+ (no table rewrite, no backfill DML under RLS —
-- the exact trap the estate's migration lint rules exist to catch does not apply here because
-- there is no UPDATE statement anywhere in this file).
--
-- Runs as webdesk_migrator, same as every file in this ledger (0001's header note on the role
-- model applies unchanged — no SET ROLE, no ownership change; this file only adds columns to a
-- table webdesk_migrator already owns).

ALTER TABLE tenants
  ADD COLUMN default_locale text NOT NULL DEFAULT 'id-ID',
  ADD COLUMN locales text[] NOT NULL DEFAULT ARRAY['id-ID']::text[];

COMMENT ON COLUMN tenants.default_locale IS
  'The locale a /v1 read resolves to when the caller sends no ?locale= (webdesk-design.md §05,
   WSK-D18). Defaulting every existing/new row to id-ID matches the design''s stated Indonesian-
   market default; a tenant with a different default is expected to have it set explicitly at
   provisioning, not rely on this column default.';
COMMENT ON COLUMN tenants.locales IS
  'The tenant''s declared locale set (§05: "a tenant declares its locale set ... at
   provisioning"). Not FK-enforced against any locale table — v1 has none; §08''s "locale
   coverage" console card and WSK-14''s composition validator are the natural places to check a
   content_items.locale value against this array, not this migration.';

-- No RLS change needed: FORCE RLS + tenant_isolation_select/insert/update/delete on `tenants`
-- (0001_platform_core.sql) already govern these new columns exactly like every existing column on
-- the same row — RLS is row-level, not column-level. Re-verified by re-running
-- scripts/check-rls-integrity.mjs after this migration (see this ticket's final report).
