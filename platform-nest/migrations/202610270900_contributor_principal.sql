-- 202610270900 — M5-W1d: the fenced `contributor` principal for freelance writers (owner ruling WSK-D84, 2026-10-13,
-- answering O-4). Design: docs/plans/2026-10-11-m5-writers-room-design.md §3.1 (items 1 to 9), §3.2 (the walls), D10,
-- §6 (this file), §9 row W1d. PERMISSION-CONTRACT §27.6, FRONTEND-BFF-CONTRACT §27 "Freelance contributors".
--
-- WHAT THIS ADDS
--   1. `users.kind` admits `contributor`, through a SELF-VERIFYING CHECK widening built from the LIVE definition (the
--      202610110520 pattern: a DROP+ADD typed from memory has deleted values on live before).
--   2. `users_contributor_no_home_company`: a contributor never has a home company. `home_company_id` is a STAFF anchor
--      (principal.ts, MON-00c); a contributor is rooted only by its own anchor row below.
--   3. `editorial_contributors`: the ANCHOR (never a `company_memberships` row: most readers of that table do not filter
--      `kind`, which is why clients were kept out of it, PERMISSION-CONTRACT §13.1). One row per (company, person):
--      sponsor, status (invited | active | ended), `valid_until NOT NULL`, at most 180 days after the write that set it.
--      FORCE RLS: the tenant wall plus the `principal_lookup` read shape client_contacts uses (0072 §7b), because
--      assemblePrincipal() reads it before any tenant context exists. WITHOUT THAT POLICY THE READ RETURNS ZERO ROWS AND
--      NO ERROR, and every contributor would silently reach nothing.
--   4. `editorial_contributor_invites`: the single-use invite tokens (only sha256 of the raw token is stored), a SIBLING
--      of `client_invites`, never a widening of it. FORCE RLS, tenant wall only (the accept route learns the tenant from
--      the token's signature, exactly as the client invite does).
--   5. Guards, for ANY writer (seeds and fixtures included):
--        user_roles_contributor_guard      a contributor holds ONLY webdesk_writer / webdesk_translator /
--                                          webdesk_seo_reviewer, always with an `expires_at`, and only while an
--                                          un-ended, unexpired anchor in that company covers the whole grant.
--        company_memberships_contributor_guard / client_contacts_contributor_guard
--                                          a contributor is never a member and never a client contact.
--        users_contributor_kind_guard      a `users` row becomes a contributor only when it holds no grant, no membership
--                                          and no client contact (ever, deleted rows included); it stops being one only
--                                          after every anchor has ended.
--        editorial_contributors_guard      an anchor only for a `contributor` row; `valid_from` is re-stamped on every
--                                          write of `valid_until`, so the 180-day CHECK means "from that write".
--
-- RLS / DML NOTE: migrations run as platform_owner, which has NO BYPASSRLS. This file writes NO row into any table: it is
-- DDL plus self-assertions that read pg_catalog. Nothing to backfill: before this file no `contributor` value could exist.
-- The trigger functions that read FORCE-RLS tables (anchors, memberships, client contacts) read them as the CALLER: on a
-- connection with no tenant context they see nothing, which makes a grant to a contributor FAIL CLOSED (refused) and a
-- conversion check read under the `principal_lookup` GUC set inside the function itself (see (8)).

-- ═══════════════ helper: the quoted literals of a constraint definition (session-local) ══════════════════
CREATE OR REPLACE FUNCTION pg_temp.check_literals(def text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[])
    FROM regexp_matches(def, '''([^'']*)''', 'g') AS m
$f$;

-- ═══════════════ (1) users.kind — admit 'contributor', built from the LIVE definition ═════════════════════
-- The new list is the LIVE list plus one value, so nothing the live CHECK allows can be lost by construction. It must also
-- contain the four values PK-01 (202608201442) declared: if any is missing the live estate has drifted from the repo and
-- this file refuses to guess. After the swap the definition is re-read and must still admit every prior value.
DO $$
DECLARE
  v_name    text;
  v_def     text;
  v_live    text[];
  v_known   text[] := ARRAY['employee', 'client', 'automation', 'bot'];
  v_new     text[];
  v_missing text[];
  v_after   text[];
  n         int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'users'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ~ '\mkind\M' AND pg_get_constraintdef(oid) LIKE '%''employee''%'
     AND pg_get_constraintdef(oid) NOT LIKE '%home_company_id%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610270900: expected exactly 1 kind CHECK on users, found % — refusing to guess which to replace', n;
  END IF;
  SELECT conname, pg_get_constraintdef(oid) INTO v_name, v_def FROM pg_constraint
   WHERE conrelid = 'users'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ~ '\mkind\M' AND pg_get_constraintdef(oid) LIKE '%''employee''%'
     AND pg_get_constraintdef(oid) NOT LIKE '%home_company_id%';

  v_live := pg_temp.check_literals(v_def);
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing FROM unnest(v_known) AS x WHERE NOT (x = ANY (v_live));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '202610270900: the LIVE users.kind CHECK (%) no longer admits % — the estate has drifted from PK-01. Nothing was changed.',
      v_def, v_missing;
  END IF;

  IF 'contributor' = ANY (v_live) THEN
    RAISE NOTICE '202610270900: users.kind already admits contributor — skipped (%)', v_def;
    RETURN;
  END IF;
  SELECT array_agg(x ORDER BY x) INTO v_new FROM (SELECT DISTINCT unnest(v_live || ARRAY['contributor']) AS x) AS d;

  EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', v_name);
  EXECUTE format('ALTER TABLE users ADD CONSTRAINT %I CHECK (kind IN (%s))', v_name,
                 (SELECT string_agg(quote_literal(x), ', ' ORDER BY x) FROM unnest(v_new) AS x));

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = v_name;
  v_after := pg_temp.check_literals(v_def);
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing FROM unnest(v_live || ARRAY['contributor']) AS x WHERE NOT (x = ANY (v_after));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '202610270900: users.kind CHECK lost value(s) % in the re-declaration (now: %)', v_missing, v_def;
  END IF;
  -- and it gained nothing but 'contributor'
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing FROM unnest(v_after) AS x WHERE NOT (x = ANY (v_live || ARRAY['contributor']));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '202610270900: users.kind CHECK gained unexpected value(s) % (now: %)', v_missing, v_def;
  END IF;
  RAISE NOTICE '202610270900: users.kind CHECK widened: % -> %', v_live, v_after;
END $$;

COMMENT ON COLUMN users.kind IS
  'PK-01 + M5-W1d. What this ACCOUNT is: employee|client|automation|bot|contributor. `contributor` is a freelance '
  'writer (WSK-D84): an EXTERNAL principal anchored by editorial_contributors (never company_memberships), fenced at '
  'the HTTP layer to @ContributorRoute() routes at assurance high, holding only the writer/translator/SEO-reviewer roles. '
  'Orthogonal to company_memberships.kind (why the account is in a company). `bot` is distinct from `automation` '
  'deliberately: a pinned n8n workflow is enumerable in advance, a model-driven persona is not.';

-- ═══════════════ (2) a contributor never has a home company (a STAFF anchor) ══════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_contributor_no_home_company') THEN
    ALTER TABLE users ADD CONSTRAINT users_contributor_no_home_company
      CHECK (kind <> 'contributor' OR home_company_id IS NULL);
  END IF;
END $$;

-- ═══════════════ (3) the anchor ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE editorial_contributors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES companies(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  -- The staff member answerable for this engagement (who invited or last renewed it).
  sponsor_user_id  uuid NOT NULL REFERENCES users(id),
  status           text NOT NULL CHECK (status IN ('invited', 'active', 'ended')),
  -- Re-stamped by the guard trigger whenever valid_until is written, so the CHECK below means "at most 180 days after
  -- the write that set it" (a CHECK cannot read now() honestly; the trigger can).
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_until      timestamptz NOT NULL,
  invited_at       timestamptz NOT NULL DEFAULT now(),
  activated_at     timestamptz,
  ended_at         timestamptz,
  ended_by         uuid REFERENCES users(id),
  origin_site      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_editorial_contributors_tenant_user UNIQUE (tenant_id, user_id),
  -- the target of the invites' composite FK (an invite can never point at another company's anchor)
  CONSTRAINT ux_editorial_contributors_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ck_editorial_contributors_window CHECK (valid_until <= valid_from + interval '180 days'),
  CONSTRAINT ck_editorial_contributors_ended CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CONSTRAINT ck_editorial_contributors_not_own_sponsor CHECK (sponsor_user_id <> user_id)
);

CREATE INDEX ix_editorial_contributors_user ON editorial_contributors (user_id);

ALTER TABLE editorial_contributors ENABLE ROW LEVEL SECURITY;
ALTER TABLE editorial_contributors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON editorial_contributors;
CREATE POLICY tenant_isolation ON editorial_contributors FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));
-- principal_lookup: SELECT only, only the rows of the user being resolved (0072 §7b's shape). NULLIF(...,'') is not
-- optional: a bare ''::uuid ERRORS the whole query (0004's finding). Unset GUC -> NULL -> no row.
DROP POLICY IF EXISTS principal_lookup ON editorial_contributors;
CREATE POLICY principal_lookup ON editorial_contributors FOR SELECT
  USING (user_id = NULLIF(current_setting('app.principal_user_id', true), '')::uuid);

COMMENT ON TABLE editorial_contributors IS
  'M5-W1d (WSK-D84): the tenant ANCHOR of a freelance contributor (users.kind=contributor). Never company_memberships. '
  'assemblePrincipal() adds an ACTIVE, UNEXPIRED anchor to companies, and to rootCompanies only when no staff anchor '
  'exists. valid_until is NOT NULL and at most 180 days after the write that set it. FORCE RLS: tenant wall + '
  'principal_lookup (own rows only). Written by modules/webdev/editorial-contributors.service.ts.';

-- ═══════════════ (4) the invite tokens ════════════════════════════════════════════════════════════════════
CREATE TABLE editorial_contributor_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  contributor_id  uuid NOT NULL,
  -- The address the invite was ISSUED for; the accept provisions THIS address and nothing from the request.
  email           text NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  -- sha256(raw token), hex. The raw token exists only in the one response that mints it.
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  invited_by      uuid REFERENCES users(id),
  origin_site     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_editorial_contributor_invites_anchor FOREIGN KEY (contributor_id, tenant_id)
    REFERENCES editorial_contributors (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX ix_editorial_contributor_invites_open ON editorial_contributor_invites (contributor_id) WHERE consumed_at IS NULL;

ALTER TABLE editorial_contributor_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE editorial_contributor_invites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON editorial_contributor_invites;
CREATE POLICY tenant_isolation ON editorial_contributor_invites FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

COMMENT ON TABLE editorial_contributor_invites IS
  'M5-W1d: single-use contributor invite tokens (core/contributor-invites.ts, token `ctr1`, its own HMAC label). A '
  'SIBLING of client_invites, never a widening of it: neither token verifies against the other''s parser. Only '
  'sha256(token) is stored; the consume claims by id AND hash. FORCE RLS, tenant wall only.';

-- ═══════════════ (5) the anchor's own guard ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION editorial_contributors_guard() RETURNS trigger
LANGUAGE plpgsql AS $f$
DECLARE
  v_kind text;
BEGIN
  SELECT kind INTO v_kind FROM users WHERE id = NEW.user_id;
  IF v_kind IS DISTINCT FROM 'contributor' THEN
    RAISE EXCEPTION 'editorial_contributors: an anchor may only belong to a users.kind=contributor row (got %) — contributor_anchor_kind', v_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'editorial_contributors: an anchor''s company and person cannot be changed in place'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
    NEW.valid_from := now();
    IF NEW.status <> 'ended' AND NEW.valid_until <= now() THEN
      RAISE EXCEPTION 'editorial_contributors: valid_until must be in the future for a live anchor (got %)', NEW.valid_until
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS editorial_contributors_guard ON editorial_contributors;
CREATE TRIGGER editorial_contributors_guard
  BEFORE INSERT OR UPDATE ON editorial_contributors
  FOR EACH ROW EXECUTE FUNCTION editorial_contributors_guard();

-- ═══════════════ (6) user_roles: a contributor holds the three roles only, time-boxed inside its anchor ═════
-- Independent of user_roles_editorial_guard (202610111816), which already keeps the four editorial roles at `company`
-- scope and off positions and service assignments; both fire. The anchor read runs as the CALLER under RLS: the grant
-- path writes on a `withTenants([company])` connection, so the anchor is visible; a raw INSERT with no tenant context
-- sees no anchor and is REFUSED (fail closed), seeds included.
CREATE OR REPLACE FUNCTION user_roles_contributor_guard() RETURNS trigger
LANGUAGE plpgsql AS $f$
DECLARE
  v_kind  text;
  v_role  text;
  v_until timestamptz;
BEGIN
  SELECT kind INTO v_kind FROM users WHERE id = NEW.user_id;
  IF v_kind IS DISTINCT FROM 'contributor' THEN
    RETURN NEW;
  END IF;
  SELECT name INTO v_role FROM roles WHERE id = NEW.role_id;
  IF v_role IS NULL OR v_role NOT IN ('webdesk_writer', 'webdesk_translator', 'webdesk_seo_reviewer') THEN
    RAISE EXCEPTION 'user_roles: a contributor may hold only webdesk_writer, webdesk_translator or webdesk_seo_reviewer (got %) — contributor_role_forbidden', v_role
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.scope_type IS DISTINCT FROM 'company' THEN
    RAISE EXCEPTION 'user_roles: a contributor''s grant must be at company scope (got %) — contributor_role_forbidden', NEW.scope_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.expires_at IS NULL THEN
    RAISE EXCEPTION 'user_roles: a contributor''s grant must carry expires_at — contributor_grant_expiry_required'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT ec.valid_until INTO v_until FROM editorial_contributors ec
   WHERE ec.tenant_id::text = NEW.scope_id AND ec.user_id = NEW.user_id
     AND ec.status IN ('invited', 'active') AND ec.valid_until > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_roles: the contributor has no live anchor in company % (or it is not visible in this tenant context) — contributor_grant_needs_anchor', NEW.scope_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.expires_at > v_until THEN
    RAISE EXCEPTION 'user_roles: a contributor''s grant (expires %) may not outlive its anchor (valid until %) — contributor_grant_outlives_anchor', NEW.expires_at, v_until
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS user_roles_contributor_guard ON user_roles;
CREATE TRIGGER user_roles_contributor_guard
  BEFORE INSERT OR UPDATE OF user_id, role_id, scope_type, scope_id, expires_at ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_contributor_guard();

-- ═══════════════ (7) never a member, never a client contact ═══════════════════════════════════════════════
-- `users` carries no RLS, so these reads see the truth for any caller.
CREATE OR REPLACE FUNCTION refuse_contributor_principal_row() RETURNS trigger
LANGUAGE plpgsql AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'contributor') THEN
    RAISE EXCEPTION '%: a contributor (users.kind=contributor) can never hold a row here — contributor_not_%', TG_TABLE_NAME,
      CASE WHEN TG_TABLE_NAME = 'company_memberships' THEN 'a_member' ELSE 'a_client_contact' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS company_memberships_contributor_guard ON company_memberships;
CREATE TRIGGER company_memberships_contributor_guard
  BEFORE INSERT OR UPDATE OF user_id ON company_memberships
  FOR EACH ROW EXECUTE FUNCTION refuse_contributor_principal_row();

DROP TRIGGER IF EXISTS client_contacts_contributor_guard ON client_contacts;
CREATE TRIGGER client_contacts_contributor_guard
  BEFORE INSERT OR UPDATE OF user_id ON client_contacts
  FOR EACH ROW EXECUTE FUNCTION refuse_contributor_principal_row();

-- ═══════════════ (8) becoming a contributor, and leaving the kind ═════════════════════════════════════════
-- Becoming one: no grant (user_roles has no RLS), and no membership and no client contact EVER (deleted rows included,
-- so an ex-staff member or ex-client cannot be repurposed). Memberships and contacts are FORCE RLS; the function reads
-- them under their `principal_lookup` policies by setting `app.principal_user_id` to THIS row's id for the two reads and
-- then restoring the caller's previous value, so the check sees every company and the caller's transaction is left as it
-- found it. Leaving the kind: only once every anchor has ended (read under the same lookup).
CREATE OR REPLACE FUNCTION users_contributor_kind_guard() RETURNS trigger
LANGUAGE plpgsql AS $f$
DECLARE
  v_prev    text;
  v_member  boolean;
  v_contact boolean;
  v_anchor  boolean;
BEGIN
  IF NEW.kind IS NOT DISTINCT FROM OLD.kind THEN
    RETURN NEW;
  END IF;
  v_prev := current_setting('app.principal_user_id', true);
  PERFORM set_config('app.principal_user_id', NEW.id::text, true);
  SELECT EXISTS (SELECT 1 FROM company_memberships WHERE user_id = NEW.id),
         EXISTS (SELECT 1 FROM client_contacts WHERE user_id = NEW.id),
         EXISTS (SELECT 1 FROM editorial_contributors WHERE user_id = NEW.id AND status <> 'ended')
    INTO v_member, v_contact, v_anchor;
  PERFORM set_config('app.principal_user_id', coalesce(v_prev, ''), true);

  IF NEW.kind = 'contributor' THEN
    IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = NEW.id) THEN
      RAISE EXCEPTION 'users: % cannot become a contributor while it holds a role grant — contributor_conversion_refused', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_member OR v_contact THEN
      RAISE EXCEPTION 'users: % cannot become a contributor: it is, or was, a company member or a client contact — contributor_conversion_refused', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.kind = 'contributor' AND v_anchor THEN
    RAISE EXCEPTION 'users: % is a contributor with an anchor that has not ended; end it first — contributor_kind_locked', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS users_contributor_kind_guard ON users;
CREATE TRIGGER users_contributor_kind_guard
  BEFORE UPDATE OF kind ON users
  FOR EACH ROW EXECUTE FUNCTION users_contributor_kind_guard();

-- ═══════════════ Assert, don't assume ═════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  got integer;
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ '\mkind\M'
     AND pg_get_constraintdef(oid) LIKE '%''employee''%' AND pg_get_constraintdef(oid) NOT LIKE '%home_company_id%';
  IF NOT (pg_temp.check_literals(v_def) @> ARRAY['employee', 'client', 'automation', 'bot', 'contributor']) THEN
    RAISE EXCEPTION '202610270900: users.kind CHECK does not admit all five kinds: %', v_def;
  END IF;

  SELECT count(*) INTO got FROM pg_constraint
   WHERE conrelid = 'users'::regclass AND conname = 'users_contributor_no_home_company' AND contype = 'c';
  IF got <> 1 THEN RAISE EXCEPTION '202610270900: users_contributor_no_home_company is missing'; END IF;

  SELECT count(*) INTO got FROM pg_class
   WHERE oid IN ('editorial_contributors'::regclass, 'editorial_contributor_invites'::regclass)
     AND relrowsecurity AND relforcerowsecurity;
  IF got <> 2 THEN RAISE EXCEPTION '202610270900: both contributor tables must have RLS enabled AND forced (found %)', got; END IF;

  SELECT count(*) INTO got FROM pg_policies
   WHERE (tablename = 'editorial_contributors'
          AND ((policyname = 'tenant_isolation' AND cmd = 'ALL') OR (policyname = 'principal_lookup' AND cmd = 'SELECT')))
      OR (tablename = 'editorial_contributor_invites' AND policyname = 'tenant_isolation' AND cmd = 'ALL');
  IF got <> 3 THEN RAISE EXCEPTION '202610270900: expected 3 RLS policies on the contributor tables, found %', got; END IF;
  SELECT count(*) INTO got FROM pg_policies WHERE tablename = 'editorial_contributor_invites';
  IF got <> 1 THEN RAISE EXCEPTION '202610270900: editorial_contributor_invites must carry the tenant wall only, found % policies', got; END IF;

  SELECT count(*) INTO got FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled <> 'D'
     AND ((tgrelid = 'editorial_contributors'::regclass AND tgname = 'editorial_contributors_guard')
       OR (tgrelid = 'user_roles'::regclass AND tgname = 'user_roles_contributor_guard')
       OR (tgrelid = 'company_memberships'::regclass AND tgname = 'company_memberships_contributor_guard')
       OR (tgrelid = 'client_contacts'::regclass AND tgname = 'client_contacts_contributor_guard')
       OR (tgrelid = 'users'::regclass AND tgname = 'users_contributor_kind_guard'));
  IF got <> 5 THEN RAISE EXCEPTION '202610270900: expected the 5 contributor guard triggers, found % enabled', got; END IF;

  RAISE NOTICE '202610270900: users.kind admits contributor; editorial_contributors + editorial_contributor_invites (FORCE RLS) and 5 guard triggers in place';
END $$;
