-- 202610110520 — WSK-49f: the `client_website_editor` grant path (owner ruling WSK-D60, amended 2026-10-11;
-- docs/blueprints/webdesk-design-v2.md §14, docs/plans/2026-10-11-webdesk-m3-plan.md "WSK-49").
--
-- WHAT THIS ADDS
--   1. `user_roles.scope_type` admits `client` (scope_id = clients.id, uuid-shaped). The grant is anchored on
--      the CLIENT RECORD, never on a membership alone (a global grant has no root).
--   2. `client_contacts.capability` admits `admin` beside `signer | viewer`. `admin` is assigned only by
--      Gaiada staff (the staff endpoint); it is what lets a client contact grant the role below.
--   3. The global role `client_website_editor`: a role stored as DATA, with NO bundle rows and NO perm_* mirror
--      (a flat perms catalog cannot express "this one client"; it would over-grant). Cerbos checks it by an
--      ATTRIBUTE condition (derived_roles.yaml: scopeType client, scopeId == resource.attr.clientId).
--   4. A DB guard (trigger) that keeps the role and the scope welded together: `scope_type='client'` is the
--      ONLY scope this role may carry, and this role is the ONLY one a client scope may carry. A seed, a
--      position reconciler or a future writer that forgets the application guard still cannot mint a
--      company-scoped `client_website_editor` (which no Cerbos rule would honour, but which would silently
--      sit there) nor a client-scoped staff role.
--   5. Two catalog permissions on the EXISTING `client_contact` kind (staff-side grant authority):
--      core.client_contact.manage_website_editor, core.client_contact.manage_admin, with their bundle rows.
--
-- ── THE CHECK WIDENINGS ARE SELF-VERIFYING AGAINST THE LIVE DATABASE ─────────────────────────────────────
-- A DROP+ADD that re-declares a CHECK list from memory has silently deleted values on LIVE before. So every
-- widening below, in order: (a) reads the LIVE definition with pg_get_constraintdef() from pg_constraint,
-- (b) parses the allowed values out of it and RAISE EXCEPTION naming any value that is missing from the NEW
-- list (nothing has been changed at that point, and the whole file is one transaction anyway), (c) DROPs and
-- ADDs, (d) re-reads the definition and asserts it still accepts EVERY prior value plus the new one.
-- The per-scope shape CHECK is not re-typed at all: the new definition is the LIVE definition with one literal
-- list textually extended, so any drift in the rest of its text is carried through rather than lost.
--
-- RLS / DML NOTE: migrations run as platform_owner, which has NO BYPASSRLS. Nothing here writes a tenant row.
-- The only DML is on `roles`, `permissions` and `role_permissions`, which are GLOBAL reference tables with no
-- RLS (0093's own conclusion), so the zero-rows trap does not apply. No `client_contacts`/`user_roles` data is
-- written or backfilled.

-- ═══════════════ helper: the quoted literals of a constraint definition (session-local) ══════════════════
CREATE OR REPLACE FUNCTION pg_temp.check_literals(def text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[])
    FROM regexp_matches(def, '''([^'']*)''', 'g') AS m
$f$;

-- ═══════════════ (1) user_roles.scope_type — admit 'client' ═════════════════════════════════════════════
DO $$
DECLARE
  v_name    text;
  v_def     text;
  v_live    text[];
  v_new     text[] := ARRAY['global', 'company', 'org_unit', 'project', 'client'];
  v_missing text[];
  v_after   text[];
  n         int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'user_roles'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%scope_type%' AND pg_get_constraintdef(oid) NOT LIKE '%scope_id%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610110520: expected exactly 1 scope_type-only CHECK on user_roles, found % — refusing to guess which to replace', n;
  END IF;
  SELECT conname, pg_get_constraintdef(oid) INTO v_name, v_def FROM pg_constraint
   WHERE conrelid = 'user_roles'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%scope_type%' AND pg_get_constraintdef(oid) NOT LIKE '%scope_id%';

  v_live := pg_temp.check_literals(v_def);
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing FROM unnest(v_live) AS x WHERE NOT (x = ANY (v_new));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '202610110520: the LIVE user_roles scope_type CHECK (%) allows value(s) % that are missing from the new list % — widening would silently delete them. Nothing was changed.',
      v_def, v_missing, v_new;
  END IF;

  EXECUTE format('ALTER TABLE user_roles DROP CONSTRAINT %I', v_name);
  EXECUTE format('ALTER TABLE user_roles ADD CONSTRAINT %I CHECK (scope_type IN (%s))', v_name,
                 (SELECT string_agg(quote_literal(x), ', ' ORDER BY ord) FROM unnest(v_new) WITH ORDINALITY AS t(x, ord)));

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conrelid = 'user_roles'::regclass AND conname = v_name;
  v_after := pg_temp.check_literals(v_def);
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing FROM unnest(v_live || ARRAY['client']) AS x WHERE NOT (x = ANY (v_after));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '202610110520: user_roles scope_type CHECK lost value(s) % in the re-declaration (now: %)', v_missing, v_def;
  END IF;
END $$;

-- ═══════════════ (2) user_roles per-scope shape CHECK — 'client' rides the uuid branch ═════════════════
-- Derived from the LIVE definition by extending the one literal list that names company/project. If that
-- literal is not found the migration aborts rather than guessing.
DO $$
DECLARE
  v_name   text;
  v_def    text;
  v_body   text;
  v_new    text;
  v_known  text[] := ARRAY['global', 'company', 'org_unit', 'project', 'client'];
  v_idlits text[];
  v_bad    text[];
  n        int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'user_roles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%scope_id%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610110520: expected exactly 1 scope_id shape CHECK on user_roles, found %', n;
  END IF;
  SELECT conname, pg_get_constraintdef(oid) INTO v_name, v_def FROM pg_constraint
   WHERE conrelid = 'user_roles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%scope_id%';

  -- every identifier-like literal in the live shape CHECK must be a scope this migration knows
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_idlits FROM unnest(pg_temp.check_literals(v_def)) AS x WHERE x ~ '^[a-z_]+$';
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_bad FROM unnest(v_idlits) AS x WHERE NOT (x = ANY (v_known));
  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION '202610110520: the LIVE user_roles shape CHECK names scope value(s) % this migration does not know — refusing to rewrite it. Nothing was changed. Definition: %', v_bad, v_def;
  END IF;

  IF v_def LIKE '%''client''::text%' THEN
    RAISE NOTICE '202610110520: shape CHECK already admits client — skipped';
    RETURN;
  END IF;
  v_body := replace(v_def, 'ARRAY[''company''::text, ''project''::text]', 'ARRAY[''company''::text, ''project''::text, ''client''::text]');
  IF v_body = v_def THEN
    RAISE EXCEPTION '202610110520: could not find the company/project literal list in the LIVE shape CHECK, refusing to guess. Definition: %', v_def;
  END IF;
  v_new := regexp_replace(v_body, '^CHECK ', '');

  EXECUTE format('ALTER TABLE user_roles DROP CONSTRAINT %I', v_name);
  EXECUTE format('ALTER TABLE user_roles ADD CONSTRAINT %I CHECK %s', v_name, v_new);

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conrelid = 'user_roles'::regclass AND conname = v_name;
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_bad FROM unnest(v_idlits || ARRAY['client']) AS x
   WHERE NOT (x = ANY (pg_temp.check_literals(v_def)));
  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION '202610110520: user_roles shape CHECK lost value(s) % in the re-declaration (now: %)', v_bad, v_def;
  END IF;
END $$;

-- ═══════════════ (3) client_contacts.capability — admit 'admin' ═════════════════════════════════════════
DO $$
DECLARE
  v_name    text;
  v_def     text;
  v_live    text[];
  v_new     text[] := ARRAY['signer', 'viewer', 'admin'];
  v_missing text[];
  v_after   text[];
  n         int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'client_contacts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%capability%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610110520: expected exactly 1 capability CHECK on client_contacts, found % — refusing to guess which to replace', n;
  END IF;
  SELECT conname, pg_get_constraintdef(oid) INTO v_name, v_def FROM pg_constraint
   WHERE conrelid = 'client_contacts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%capability%';

  v_live := pg_temp.check_literals(v_def);
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing FROM unnest(v_live) AS x WHERE NOT (x = ANY (v_new));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '202610110520: the LIVE client_contacts capability CHECK (%) allows value(s) % that are missing from the new list % — widening would silently delete them. Nothing was changed.',
      v_def, v_missing, v_new;
  END IF;

  EXECUTE format('ALTER TABLE client_contacts DROP CONSTRAINT %I', v_name);
  EXECUTE format('ALTER TABLE client_contacts ADD CONSTRAINT %I CHECK (capability IN (%s))', v_name,
                 (SELECT string_agg(quote_literal(x), ', ' ORDER BY ord) FROM unnest(v_new) WITH ORDINALITY AS t(x, ord)));

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conrelid = 'client_contacts'::regclass AND conname = v_name;
  v_after := pg_temp.check_literals(v_def);
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing FROM unnest(v_live || ARRAY['admin']) AS x WHERE NOT (x = ANY (v_after));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '202610110520: client_contacts capability CHECK lost value(s) % in the re-declaration (now: %)', v_missing, v_def;
  END IF;
END $$;

-- ═══════════════ (4) the role, as data ═══════════════════════════════════════════════════════════════════
-- `roles` has UNIQUE (company_id, name) which never fires for company_id IS NULL, so NOT EXISTS is the guard.
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, 'client_website_editor',
       'WSK-D60: a client contact who may edit their OWN client''s website through WebDesk. Scope is one client record (scope_type=client, scope_id=clients.id); checked by an attribute condition in Cerbos. Carries no permission bundle and no perm_* mirror.'
 WHERE NOT EXISTS (SELECT 1 FROM roles WHERE company_id IS NULL AND name = 'client_website_editor');

-- ═══════════════ (5) DB guard: the role and the client scope are welded together ═════════════════════════
CREATE OR REPLACE FUNCTION user_roles_client_scope_guard() RETURNS trigger
LANGUAGE plpgsql AS $f$
DECLARE
  v_name text;
BEGIN
  SELECT name INTO v_name FROM roles WHERE id = NEW.role_id;
  IF NEW.scope_type = 'client' AND v_name IS DISTINCT FROM 'client_website_editor' THEN
    RAISE EXCEPTION 'user_roles: scope_type=client may only carry the client_website_editor role (got %)', v_name
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_name = 'client_website_editor' AND NEW.scope_type <> 'client' THEN
    RAISE EXCEPTION 'user_roles: client_website_editor may only be granted at scope_type=client (got %)', NEW.scope_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS user_roles_client_scope_guard ON user_roles;
CREATE TRIGGER user_roles_client_scope_guard
  BEFORE INSERT OR UPDATE OF role_id, scope_type, scope_id ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_client_scope_guard();

-- ═══════════════ (6) the staff-side catalog permissions (existing `client_contact` kind) ═════════════════
-- Role-arm only: no perm_* derived role, no mirror (the client-admin arm is attribute-gated, and a flat key
-- cannot express it). ui_grantable is explicit (0110's DEFAULT true would otherwise decide).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.client_contact.manage_website_editor', 'core', 'client_contact', 'manage_website_editor',
   'Grant or revoke the client_website_editor role (WebDesk site editing, scoped to one client) for a contact of a client; also lists who holds it.',
   'client_contact', 'manage_website_editor', 'grantable', true, true),
  ('core.client_contact.manage_admin', 'core', 'client_contact', 'manage_admin',
   'Grant or revoke the client-contact capability admin (the client-side granter of client_website_editor). Staff only.',
   'client_contact', 'manage_admin', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- Reach (a transcription of resource_client_contact.yaml's role-arm rules):
--   manage_website_editor — platform_admin, company_admin, owner (mirrors company_admin), manager
--   manage_admin          — platform_admin, company_admin, owner (mirrors company_admin)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('platform_admin', 'core.client_contact.manage_website_editor'),
  ('company_admin',  'core.client_contact.manage_website_editor'),
  ('owner',          'core.client_contact.manage_website_editor'),
  ('manager',        'core.client_contact.manage_website_editor'),
  ('platform_admin', 'core.client_contact.manage_admin'),
  ('company_admin',  'core.client_contact.manage_admin'),
  ('owner',          'core.client_contact.manage_admin')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- ═══════════════ Assert, don't assume ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE
  got integer;
BEGIN
  SELECT count(*) INTO got FROM roles WHERE company_id IS NULL AND name = 'client_website_editor';
  IF got <> 1 THEN RAISE EXCEPTION '202610110520: expected exactly 1 global client_website_editor role, found %', got; END IF;

  -- the role carries NO bundle: no perm_* mirror may ever be implied by a bundle row
  SELECT count(*) INTO got FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.name = 'client_website_editor';
  IF got <> 0 THEN RAISE EXCEPTION '202610110520: client_website_editor must carry no permission bundle, found % rows', got; END IF;

  SELECT count(*) INTO got FROM permissions
   WHERE key IN ('core.client_contact.manage_website_editor', 'core.client_contact.manage_admin')
     AND class = 'grantable' AND cerbos_kind = 'client_contact' AND sensitive AND ui_grantable;
  IF got <> 2 THEN RAISE EXCEPTION '202610110520: expected 2 client_contact manage_* permissions, found %', got; END IF;

  SELECT count(*) INTO got FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.key LIKE 'core.client_contact.manage\_%'
     AND r.name IN ('platform_admin', 'company_admin', 'owner', 'manager');
  IF got <> 7 THEN RAISE EXCEPTION '202610110520: expected 7 manage_* bundle rows, found %', got; END IF;

  SELECT count(*) INTO got FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key LIKE 'core.client_contact.manage\_%' AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'manager');
  IF got <> 0 THEN RAISE EXCEPTION '202610110520: a manage_* permission leaked to % other role row(s)', got; END IF;

  -- the guard trigger exists and is enabled
  SELECT count(*) INTO got FROM pg_trigger
   WHERE tgrelid = 'user_roles'::regclass AND tgname = 'user_roles_client_scope_guard' AND tgenabled <> 'D';
  IF got <> 1 THEN RAISE EXCEPTION '202610110520: user_roles_client_scope_guard is missing or disabled'; END IF;
END $$;
