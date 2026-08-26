-- webdesk/migrations/0001_platform_core.sql
-- WSK-03 — Zone B platform-core schema + roles.
-- Ledger: Zone B owns its OWN numbering starting at 0001 (webdesk-design.md D-1). This is NOT
-- the platform-nest ledger and does not use its timestamp naming rule (that rule, WSK-D21, is
-- scoped to platform-nest only).
--
-- Builds: tenants · sites · environments · api_keys · releases · audit_entries, per the §04 DDL
-- sketch, plus the fail-closed tenancy wall keyed on the `webdesk.tenant_ctx` session GUC
-- (webdesk-design.md §04, WSK-D16).
--
-- ============================================================================================
-- ROLE MODEL (revised after checking against webdesk/postgres/init-roles.sh — WSK-01, landed in
-- this same checkout while this ticket was in progress; that file, not this comment, is the
-- source of truth for the actual bootstrap)
-- ============================================================================================
-- `postgres/init-roles.sh` already creates all three roles (webdesk_owner / webdesk_migrator /
-- webdesk_app — all NOSUPERUSER NOBYPASSRLS) via docker-entrypoint-initdb.d, hands the DATABASE
-- to webdesk_owner, and grants webdesk_migrator USAGE+CREATE on schema "public" with an
-- ALTER DEFAULT PRIVILEGES rule (FOR ROLE webdesk_migrator) that hands SELECT/INSERT/UPDATE/
-- DELETE on future tables to webdesk_app automatically. Its own header says explicitly: "the
-- objects [webdesk_migrator] creates are owned by IT... WSK-03 may reassign ownership to
-- webdesk_owner as schema work matures — not done here."
--
-- An earlier version of this file DID attempt that reassignment (creating the roles itself, then
-- `SET ROLE webdesk_owner` before every CREATE TABLE). That could never have worked against the
-- real bootstrap above: `SET ROLE webdesk_owner` requires the connecting role (webdesk_migrator,
-- per MIGRATE_DATABASE_URL) to already be a MEMBER of webdesk_owner, and granting that membership
-- itself requires admin option on webdesk_owner or superuser — neither of which webdesk_migrator
-- has, and neither of which this file (running AS webdesk_migrator, per the real runner) can grant
-- to itself. Editing `postgres/init-roles.sh` to add that grant was the alternative, and is out of
-- this ticket's scope (WSK-01 owns that file). So the reassignment is deliberately NOT done: every
-- table below is created directly as `webdesk_migrator` (the file's actual connecting role) and
-- owned by it, matching the bootstrap exactly as it already exists. `webdesk_owner` stays what
-- init-roles.sh made it — the database-level custody role — and this ledger never touches it.
-- FORCE RLS below still binds the true owner (webdesk_migrator, NOBYPASSRLS) exactly as intended;
-- tests/rls.spec.sql's bonus probe checks this against the migrator role, not webdesk_owner.
--
-- No SET ROLE, no ALTER DEFAULT PRIVILEGES, no role creation in this file — all three already
-- exist and are already wired by init-roles.sh before any migration ever runs.
-- ============================================================================================

-- ---------------------------------------------------------------------------
-- 1. Fail-closed tenant-context helpers
-- ---------------------------------------------------------------------------
-- current_setting(name, true) returns NULL (never raises) when the GUC is unset, and NULL
-- compared to anything in a policy predicate is UNKNOWN, which Postgres treats as "does not
-- match" for both USING and WITH CHECK — i.e. an unset GUC reads and writes ZERO rows, never an
-- error. This is the load-bearing property; every policy in this ledger is built on it and
-- tests/rls.spec.sql probes it directly.
CREATE OR REPLACE FUNCTION webdesk_tenant_ctx() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('webdesk.tenant_ctx', true), '')::uuid
$$;
COMMENT ON FUNCTION webdesk_tenant_ctx() IS
  'The active request''s tenant, from the webdesk.tenant_ctx GUC. NULL (never an error) when unset.';

-- Second GUC for the narrow set of platform-level operations that have no single tenant to
-- scope by: creating a tenant in the first place (chicken/egg — the row does not exist yet to
-- scope to), a cross-tenant registry listing, and platform-level audit_entries (tenant_id IS
-- NULL, per §04's own sketch). This is NOT in webdesk-design.md's §04 sketch — the sketch is
-- silent on how FORCE RLS on `tenants` can ever admit an INSERT of a brand-new tenant, and on
-- how a nullable audit_entries.tenant_id is supposed to compose with a policy keyed only on
-- tenant_ctx (a plain `tenant_id = webdesk_tenant_ctx()` predicate can NEVER match a NULL
-- tenant_id under any GUC value, since NULL = anything, and even NULL = NULL, is UNKNOWN — so a
-- literal reading of the sketch makes every platform-level audit row permanently unreadable by
-- any role). This function is the resolution; see the two policies below that use it, and see
-- the report for the full writeup. It carries the same trust caveat as tenant_ctx itself: it
-- must only ever be set by the control-plane's own internal code path, never from
-- tenant-supplied input — enforced by discipline, not by this function, exactly like tenant_ctx.
CREATE OR REPLACE FUNCTION webdesk_platform_ctx() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('webdesk.platform_ctx', true) = 'true'
$$;
COMMENT ON FUNCTION webdesk_platform_ctx() IS
  'True only when the control plane has explicitly set webdesk.platform_ctx for a
   platform-level (no single tenant) operation: tenant provisioning/listing, and
   tenant_id IS NULL rows in audit_entries. Set exclusively by internal control-plane code.';

-- ---------------------------------------------------------------------------
-- 2. Tables (§04 sketch)
-- ---------------------------------------------------------------------------
-- Every table below is created as webdesk_migrator (this file's connecting role, per
-- init-roles.sh) and therefore owned by it; webdesk_app's DML rights arrive automatically via
-- init-roles.sh's `ALTER DEFAULT PRIVILEGES FOR ROLE webdesk_migrator` rule — no GRANT needed
-- here, only the immutability REVOKEs below, which claw back specific verbs after the fact.

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  company_ref uuid NOT NULL,             -- Zone A companies.id, OPAQUE here — no cross-zone FK
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  kind       text NOT NULL CHECK (kind IN ('astro', 'node', 'wp')),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sites_tenant ON sites (tenant_id);

CREATE TABLE environments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid NOT NULL REFERENCES sites(id),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL CHECK (name IN ('staging', 'production')),
  domain     text,
  status     text NOT NULL DEFAULT 'provisioning',
  UNIQUE (site_id, name)
);
CREATE INDEX ix_environments_tenant ON environments (tenant_id);
CREATE INDEX ix_environments_site ON environments (site_id);

CREATE TABLE api_keys (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  env_id     uuid NOT NULL REFERENCES environments(id),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  key_hash   text NOT NULL,              -- sha256(key + server pepper); plaintext shown ONCE
  scope      text NOT NULL CHECK (scope IN ('read', 'write')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_api_keys_tenant ON api_keys (tenant_id);
CREATE INDEX ix_api_keys_env ON api_keys (env_id);
-- key_hash is only ever looked up scoped to a tenant (the api resolves the tenant from the
-- request host/path before it ever sees the key) — a global UNIQUE on key_hash alone would let
-- one tenant's lookup timing/existence leak information about another tenant's key space.
CREATE UNIQUE INDEX ux_api_keys_tenant_hash ON api_keys (tenant_id, key_hash);

CREATE TABLE releases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  env_id       uuid NOT NULL REFERENCES environments(id),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  version      text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('deploy', 'promote', 'rollback')),
  snapshot_ref jsonb NOT NULL DEFAULT '{}',
  created_by   text NOT NULL,            -- Zone A principal id, opaque string — attribution only
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (env_id, version)
);
CREATE INDEX ix_releases_tenant ON releases (tenant_id);
CREATE INDEX ix_releases_env ON releases (env_id);

CREATE TABLE audit_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants(id),   -- nullable: platform-level commands (§04)
  actor          text NOT NULL,
  action         text NOT NULL,
  args_hash      text,
  ws4_approval_id text,                          -- single-use dedup for Layer-4 assertions (§03)
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entries_tenant ON audit_entries (tenant_id);
CREATE INDEX ix_audit_entries_ws4 ON audit_entries (ws4_approval_id) WHERE ws4_approval_id IS NOT NULL;

-- Audit is append-only: claw back UPDATE/DELETE that init-roles.sh's default-privilege rule
-- would otherwise hand to webdesk_app automatically. A compromised or buggy app process can
-- still record new (possibly false) entries — it can never rewrite or erase history. (Zone A's
-- precedent for this is a BEFORE trigger, because its app role already held blanket grants from
-- a much older default-privilege rule; here we simply revoke the two verbs immediately after
-- creation, which is the cheaper equivalent when nothing has used the grant yet.)
REVOKE UPDATE, DELETE ON audit_entries FROM webdesk_app;

-- ---------------------------------------------------------------------------
-- 3. FORCE RLS, fail-closed, on every tenant-scoped table (WSK-D16, §04, §11)
-- ---------------------------------------------------------------------------
-- ENABLE + FORCE together: FORCE is what makes the policy bind the table OWNER too (by default
-- Postgres exempts owners from RLS; FORCE removes that exemption). Combined with NOBYPASSRLS on
-- every role in this database (init-roles.sh), there is no role anywhere — including
-- webdesk_migrator, the actual owner of every table here — that reads or writes these tables
-- without going through a policy. tests/rls.spec.sql's bonus probe checks this directly.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenants;
DROP POLICY IF EXISTS tenant_isolation_select ON tenants;
DROP POLICY IF EXISTS tenant_isolation_write ON tenants;
-- tenants is the registry itself, not a "tenant_id"-bearing child row, so its own primary key IS
-- the scoping value — which makes a single symmetric `id = tenant_ctx OR platform_ctx` policy
-- (the shape every other table in this ledger uses) actively DANGEROUS here, not just wrong.
-- Verified empirically, not assumed: a real webdesk_app connection with no platform_ctx and
-- tenant_ctx SELF-ASSIGNED to an arbitrary UUID was able to INSERT a brand-new tenants row with
-- that same id — WITH CHECK (id = tenant_ctx) is trivially satisfiable by whoever picks
-- tenant_ctx, because on THIS table the "identity" column and the "scope" GUC are the same
-- value, with no foreign key forcing the id to already exist first (every other table's
-- tenant_id must reference an EXISTING tenants row, which is what makes their own
-- `tenant_id = tenant_ctx` shortcut safe — it can only ever match rows already anchored to a
-- real, pre-existing tenant). So the write side is split out from the read side: reading one's
-- own registry row stays a convenience a tenant session gets for free; creating, mutating or
-- removing a tenant is control-plane-only (§03/§08 — provisioning and status changes are WS4-
-- gated commands), never something a tenant-scoped GUC value can grant to itself.
CREATE POLICY tenant_isolation_select ON tenants FOR SELECT
  USING (id = webdesk_tenant_ctx() OR webdesk_platform_ctx());
CREATE POLICY tenant_isolation_write ON tenants FOR INSERT
  WITH CHECK (webdesk_platform_ctx());
CREATE POLICY tenant_isolation_update ON tenants FOR UPDATE
  USING      (webdesk_platform_ctx())
  WITH CHECK (webdesk_platform_ctx());
CREATE POLICY tenant_isolation_delete ON tenants FOR DELETE
  USING (webdesk_platform_ctx());

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sites;
CREATE POLICY tenant_isolation ON sites FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON environments;
CREATE POLICY tenant_isolation ON environments FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON api_keys;
CREATE POLICY tenant_isolation ON api_keys FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE releases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON releases;
CREATE POLICY tenant_isolation ON releases FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE audit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_entries;
-- Same dual-mode shape as tenants, mirrored onto the nullable tenant_id: a normal per-tenant
-- session sees/writes only its own tenant's entries; a platform-level entry (tenant_id IS NULL)
-- is visible only under platform_ctx.
CREATE POLICY tenant_isolation ON audit_entries FOR ALL
  USING (
    (tenant_id IS NOT NULL AND tenant_id = webdesk_tenant_ctx())
    OR (tenant_id IS NULL AND webdesk_platform_ctx())
  )
  WITH CHECK (
    (tenant_id IS NOT NULL AND tenant_id = webdesk_tenant_ctx())
    OR (tenant_id IS NULL AND webdesk_platform_ctx())
  );
