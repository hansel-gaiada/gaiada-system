-- 202610111816 — M5-W1b: the writers' room grant SCOPES, and the guards that keep the four editorial roles on their
-- dedicated path. docs/plans/2026-10-11-m5-writers-room-design.md §2.2 (how a grant carries its scope), §2.5 (the IAM
-- traps), §2.6 (the grant path), §6 (this file), §9 row W1b. PERMISSION-CONTRACT §27 (W1a) and §27.1 (this ticket).
--
-- WHAT THIS ADDS
--   1. `user_role_editorial_scopes`: the scope rows of a writers' room grant. One row = "this grant reaches THIS WebDesk
--      site, these collections (or all of them), these locales (or all of them)". A grant is the existing `user_roles`
--      row (role webdesk_writer | webdesk_translator | webdesk_seo_reviewer | webdesk_editor, scope_type `company`,
--      scope_id = the ERP company that owns the WebDesk tenant); its scope rows hang off it (FK ON DELETE CASCADE), so
--      revoking or expiring the grant (the P2-09 sweep deletes the row) takes every scope row with it.
--      "All" is an explicit boolean, never an empty list: CHECK all_x <=> cardinality(x) = 0, otherwise 1..100 entries.
--      One row per (grant, site): a re-grant on the same site REPLACES that site's scope (the grant path upserts).
--   2. RLS: FORCE + the plain tenant wall (`tenant_id = ANY(app_current_tenants())`, the 0025-hardened form), PLUS a
--      `principal_lookup` SELECT policy: assemblePrincipal() reads these rows BEFORE any tenant context exists, keyed on
--      `app.principal_user_id`, exactly like company_memberships (0001) and client_contacts (0072 §7b). WITHOUT IT THE
--      READ RETURNS ZERO ROWS AND NO ERROR, every editorial grant arrives without `editorialScopes`, and Cerbos denies
--      every writer: the silent-zero trap. The policy exposes only the rows of grants HELD BY that one user, never a
--      tenant's: a principal sees its own scopes and nobody else's (proven by editorial-grant.db.test.ts).
--      Deliberately NOT app_module_allowed('webdev'): principal assembly sets no module scope, so a module wall would
--      zero every read (the same reasoning as webdesk_site_clients, 202610111200). The grant routes are gated at the
--      application layer (Cerbos `webdesk_collection:manage_editorial` + ModuleEnabledGuard("webdev")).
--   3. `user_role_editorial_scopes_guard` (trigger on the scope table): a scope row may hang ONLY off a grant of one of
--      the four roles, at `company` scope, of THIS row's tenant. A scope row for a `manager` grant, a `global` writer
--      grant, or a writer grant of another company is refused for ANY writer, seeds and fixtures included.
--   4. `user_roles_editorial_guard` (trigger on user_roles): the four roles exist ONLY at `company` scope and ONLY as
--      manual grants (`managed_by` and `managed_by_position` NULL: no position role set, no service assignment can
--      mint one), and an existing editorial grant's role and scope cannot be repointed (revoke and re-grant). A raw
--      `INSERT ... scope_type 'global'` of webdesk_writer is rejected here (a global grant has no root, and no tenant to
--      bind its scope rows to).
--   5. The position-role clause: `position_roles_editorial_guard` (a SEPARATE trigger on position_roles, so the live
--      `position_roles_guard()` body, re-declared four times since 0109, is not re-typed from memory): the four roles
--      can never be attached to a position's role set.
--
-- THE APPLICATION LAYER IN FRONT OF THESE (the triggers are the backstop that survives a forgotten guard):
--   grant-write.service.ts — `grantEditorialRole` / `revokeEditorialRole` are the ONLY writers of these rows and of an
--   editorial `user_roles` row; `assertGrantAllowed` refuses the four roles by name on every generic origin
--   (`editorial_role_dedicated_path`); positions.controller.ts refuses them in a role set; ROLE_SCOPE_CONSTRAINTS pins
--   them to `company`.
--
-- RLS / DML NOTE: migrations run as platform_owner, which has NO BYPASSRLS. This file writes NO row into any table: it is
-- DDL plus self-assertions that read pg_catalog and the global `roles` table (no RLS). Nothing to backfill: before this
-- file no editorial grant could carry a scope, so every existing grant of the four roles (there should be none) stays
-- inert, exactly as W1a left it (fail closed).

-- ═══════════════ helper: a scope list is well-formed (used by the CHECKs below) ════════════════════════════════
-- IMMUTABLE so it may sit in a CHECK. No NULL element, every element 1..p_max characters with no surrounding whitespace
-- or control characters, no duplicates. Membership in the site's REAL collections / the tenant's REAL locales is the grant
-- path's check (it reads WebDesk); the database bounds the shape.
CREATE OR REPLACE FUNCTION editorial_scope_list_ok(p_list text[], p_max int) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$
  SELECT p_list IS NOT NULL
     AND array_position(p_list, NULL) IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_list) AS e(v)
        WHERE char_length(e.v) < 1 OR char_length(e.v) > p_max
           OR e.v <> btrim(e.v) OR e.v ~ '[[:cntrl:]]'
     )
     AND (SELECT count(DISTINCT v) FROM unnest(p_list) AS d(v)) = cardinality(p_list)
$f$;

-- ═══════════════ (1) the scope table ══════════════════════════════════════════════════════════════════════════
CREATE TABLE user_role_editorial_scopes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_role_id        uuid NOT NULL REFERENCES user_roles(id) ON DELETE CASCADE,
  -- The ERP company that owns the WebDesk tenant = the grant's company scope (the guard trigger enforces equality).
  tenant_id           uuid NOT NULL REFERENCES companies(id),
  -- WebDesk's own identifiers (opaque here: Zone B owns them). The slug is informational (the site id is globally
  -- unique in WebDesk); it is what the BFF route names, and the grant path proves the pair is this company's.
  webdesk_tenant_slug text NOT NULL CHECK (webdesk_tenant_slug ~ '^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$'),
  site_id             uuid NOT NULL,
  all_collections     boolean NOT NULL,
  collections         text[] NOT NULL DEFAULT '{}',
  all_locales         boolean NOT NULL,
  locales             text[] NOT NULL DEFAULT '{}',
  -- Who wrote the scope (the audit row in `activities` is the record; this is the quick answer).
  granted_by          uuid REFERENCES users(id),
  origin_site         text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_ures_grant_site UNIQUE (user_role_id, site_id),
  -- "All" is an explicit boolean, never an empty list (design §2.2).
  CONSTRAINT ck_ures_collections_shape CHECK (
    (all_collections AND cardinality(collections) = 0)
    OR (NOT all_collections AND cardinality(collections) BETWEEN 1 AND 100 AND editorial_scope_list_ok(collections, 100))
  ),
  CONSTRAINT ck_ures_locales_shape CHECK (
    (all_locales AND cardinality(locales) = 0)
    OR (NOT all_locales AND cardinality(locales) BETWEEN 1 AND 100 AND editorial_scope_list_ok(locales, 35))
  )
);

-- "who holds an editorial role on this site": the grants list of the BFF.
CREATE INDEX ix_ures_tenant_site ON user_role_editorial_scopes (tenant_id, site_id);

ALTER TABLE user_role_editorial_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role_editorial_scopes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_role_editorial_scopes;
CREATE POLICY tenant_isolation ON user_role_editorial_scopes FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- principal_lookup: SELECT only, and only the rows of grants HELD BY the user being resolved. `user_roles` carries no RLS
-- (a global table), so the EXISTS reads it directly. NULLIF(...,'') is not optional: a bare ''::uuid ERRORS the whole query
-- and drags every other permissive policy on the table down with it (0004's finding). Unset GUC -> NULL -> no row.
DROP POLICY IF EXISTS principal_lookup ON user_role_editorial_scopes;
CREATE POLICY principal_lookup ON user_role_editorial_scopes FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM user_roles ur
     WHERE ur.id = user_role_editorial_scopes.user_role_id
       AND ur.user_id = NULLIF(current_setting('app.principal_user_id', true), '')::uuid
  ));

COMMENT ON TABLE user_role_editorial_scopes IS
  'M5-W1b: the scope rows of a writers'' room grant (user_roles row of webdesk_writer/_translator/_seo_reviewer/_editor at '
  'company scope): one WebDesk site, its collections (or all) and locales (or all). assemblePrincipal() attaches them to '
  'the grant as editorialScopes; the derived roles in derived_roles.yaml match them against resource siteId/collectionKey/'
  'locale. Written ONLY by grant-write.service.ts grantEditorialRole/revokeEditorialRole. FORCE RLS: tenant wall + '
  'principal_lookup (own grants only). Guarded by user_role_editorial_scopes_guard.';

-- ═══════════════ (3) the scope-row guard: right role, company scope, same tenant ══════════════════════════════
CREATE OR REPLACE FUNCTION user_role_editorial_scopes_guard() RETURNS trigger
LANGUAGE plpgsql AS $f$
DECLARE
  v_role       text;
  v_scope_type text;
  v_scope_id   text;
BEGIN
  SELECT r.name, ur.scope_type, ur.scope_id INTO v_role, v_scope_type, v_scope_id
    FROM user_roles ur JOIN roles r ON r.id = ur.role_id
   WHERE ur.id = NEW.user_role_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_role_editorial_scopes: grant % does not exist', NEW.user_role_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_role IS NULL OR v_role NOT IN ('webdesk_writer', 'webdesk_translator', 'webdesk_seo_reviewer', 'webdesk_editor') THEN
    RAISE EXCEPTION 'user_role_editorial_scopes: scope rows may only belong to a writers'' room grant (got role %)', v_role
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_scope_type IS DISTINCT FROM 'company' THEN
    RAISE EXCEPTION 'user_role_editorial_scopes: the grant must be at company scope (got %)', v_scope_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_scope_id IS DISTINCT FROM NEW.tenant_id::text THEN
    RAISE EXCEPTION 'user_role_editorial_scopes: the scope row''s tenant % is not the grant''s company %', NEW.tenant_id, v_scope_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS user_role_editorial_scopes_guard ON user_role_editorial_scopes;
CREATE TRIGGER user_role_editorial_scopes_guard
  BEFORE INSERT OR UPDATE ON user_role_editorial_scopes
  FOR EACH ROW EXECUTE FUNCTION user_role_editorial_scopes_guard();

-- ═══════════════ (4) user_roles: the four roles at company scope, manual only, never repointed ═════════════════
-- Independent of `user_roles_client_scope_guard` (202610110520); both fire, each guards its own role family.
CREATE OR REPLACE FUNCTION user_roles_editorial_guard() RETURNS trigger
LANGUAGE plpgsql AS $f$
DECLARE
  v_name     text;
  v_old_name text;
BEGIN
  SELECT name INTO v_name FROM roles WHERE id = NEW.role_id;
  IF v_name IN ('webdesk_writer', 'webdesk_translator', 'webdesk_seo_reviewer', 'webdesk_editor') THEN
    IF NEW.scope_type IS DISTINCT FROM 'company' THEN
      RAISE EXCEPTION 'user_roles: % may only be granted at scope_type=company (got %) — editorial_role_dedicated_path', v_name, NEW.scope_type
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.managed_by IS NOT NULL OR NEW.managed_by_position IS NOT NULL THEN
      RAISE EXCEPTION 'user_roles: % may not be provisioned by a position or a service assignment — editorial_role_dedicated_path', v_name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT name INTO v_old_name FROM roles WHERE id = OLD.role_id;
    IF v_old_name IN ('webdesk_writer', 'webdesk_translator', 'webdesk_seo_reviewer', 'webdesk_editor')
       AND (NEW.role_id IS DISTINCT FROM OLD.role_id
            OR NEW.scope_type IS DISTINCT FROM OLD.scope_type
            OR NEW.scope_id IS DISTINCT FROM OLD.scope_id) THEN
      RAISE EXCEPTION 'user_roles: a writers'' room grant''s role and scope cannot be changed in place (its scope rows belong to it); revoke and re-grant'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS user_roles_editorial_guard ON user_roles;
CREATE TRIGGER user_roles_editorial_guard
  BEFORE INSERT OR UPDATE OF role_id, scope_type, scope_id, managed_by, managed_by_position ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_editorial_guard();

-- ═══════════════ (5) the position-role clause ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION position_roles_editorial_guard() RETURNS trigger
LANGUAGE plpgsql AS $f$
DECLARE
  v_name text;
BEGIN
  SELECT name INTO v_name FROM roles WHERE id = NEW.role_id;
  IF v_name IN ('webdesk_writer', 'webdesk_translator', 'webdesk_seo_reviewer', 'webdesk_editor') THEN
    RAISE EXCEPTION 'position_roles: role "%" can never be attached to a position — editorial_role_dedicated_path (a writers'' room grant carries per-site scope rows, which a role set cannot)', v_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS position_roles_editorial_guard ON position_roles;
CREATE TRIGGER position_roles_editorial_guard
  BEFORE INSERT OR UPDATE ON position_roles
  FOR EACH ROW EXECUTE FUNCTION position_roles_editorial_guard();

-- ═══════════════ Assert, don't assume ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  got integer;
BEGIN
  SELECT count(*) INTO got FROM roles
   WHERE company_id IS NULL
     AND name IN ('webdesk_writer', 'webdesk_translator', 'webdesk_seo_reviewer', 'webdesk_editor');
  IF got <> 4 THEN
    RAISE EXCEPTION '202610111816: expected the 4 global writers'' room roles of 202610111443, found %', got;
  END IF;

  SELECT count(*) INTO got FROM pg_class
   WHERE oid = 'user_role_editorial_scopes'::regclass AND relrowsecurity AND relforcerowsecurity;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610111816: user_role_editorial_scopes must have RLS enabled AND forced';
  END IF;

  SELECT count(*) INTO got FROM pg_policies
   WHERE tablename = 'user_role_editorial_scopes'
     AND ((policyname = 'tenant_isolation' AND cmd = 'ALL') OR (policyname = 'principal_lookup' AND cmd = 'SELECT'));
  IF got <> 2 THEN
    RAISE EXCEPTION '202610111816: expected tenant_isolation (ALL) and principal_lookup (SELECT) on user_role_editorial_scopes, found %', got;
  END IF;

  SELECT count(*) INTO got FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled <> 'D'
     AND ((tgrelid = 'user_role_editorial_scopes'::regclass AND tgname = 'user_role_editorial_scopes_guard')
       OR (tgrelid = 'user_roles'::regclass AND tgname = 'user_roles_editorial_guard')
       OR (tgrelid = 'position_roles'::regclass AND tgname = 'position_roles_editorial_guard'));
  IF got <> 3 THEN
    RAISE EXCEPTION '202610111816: expected the 3 editorial guard triggers, found % enabled', got;
  END IF;

  -- the four roles still carry no bundle (W1a's invariant; nothing here may imply a perm_* mirror)
  SELECT count(*) INTO got FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
   WHERE r.name IN ('webdesk_writer', 'webdesk_translator', 'webdesk_seo_reviewer', 'webdesk_editor');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610111816: the writers'' room roles must carry no permission bundle, found % row(s)', got;
  END IF;

  -- the helper rejects what the CHECKs rely on it to reject
  IF editorial_scope_list_ok(ARRAY['post', 'post'], 100) OR editorial_scope_list_ok(ARRAY[' post'], 100)
     OR editorial_scope_list_ok(ARRAY[''], 100) OR editorial_scope_list_ok(ARRAY['post', NULL], 100)
     OR editorial_scope_list_ok(ARRAY[repeat('x', 36)], 35) OR NOT editorial_scope_list_ok(ARRAY['post', 'guide'], 100) THEN
    RAISE EXCEPTION '202610111816: editorial_scope_list_ok does not behave as the CHECKs assume';
  END IF;

  RAISE NOTICE '202610111816: user_role_editorial_scopes (FORCE RLS, tenant_isolation + principal_lookup) and 3 guard triggers in place';
END $$;
