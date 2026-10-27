-- 202610271200 — M6-P6o2: per-site vault records. `integration_connections.owner_kind` admits 'webdev_site', so each
-- site AND environment can hold its own docroot-locked deploy principal (WSK-D79, M6 plan §6.3, WSK-D88).
--
-- ── NUMBERING (migrations/README.md, the timestamp scheme) ────────────────────────────────────────────────────────
-- origin/main's newest at write time: 202610270910_webdev_site_dns_tasks.sql. 1200 is clear of it and of everything below.
--
-- ── THE PROBLEM ────────────────────────────────────────────────────────────────────────────────────────────────────
-- 0033's `UNIQUE (tenant_id, owner_kind, owner_id, provider)` lets an owner hold ONE `ssh` and ONE `ftp` record. The
-- deploy credential's owners until now were the company (owner_id = the tenant) or one client (owner_id = clients.id), so
-- two company-owned sites, or one client's staging and production, collided on the same key. M6-P6o found it; its tests
-- worked around it by giving every site its own client, and its runbook step 2b stated the limit.
--
-- ── THE DECISION: OPTION A, a new owner_kind (202608311000's precedent), NOT option B (a discriminator column) ─────────
--   owner_kind = 'webdev_site'
--   owner_id   = the `webdev_sites` row id
--
-- Why A. 202608311000 met the same collision (two GitHub App credentials under one tenant and provider) and ruled on it:
-- a value that is not a company id under owner_kind='company' "makes the row lie about its own meaning", and the
-- discriminator is what stands in for the FK this polymorphic column does not carry. The same holds here, in both shapes
-- option B could take:
--   * a synthetic owner_id under 'company' or 'client' is that exact lie;
--   * a nullable `site_id` column folded into the key (NULLS NOT DISTINCT, or a COALESCE expression index) keeps the row
--     saying owner_kind='company' while it is in truth ONE site's key. Every reader that branches on owner_kind would then
--     read it wrong: the generic `owner=company` list would show a site's deploy principal as a company record, and the
--     company tier's `ownedByCompany` test (delivery-binding.ts) would accept it for EVERY site of the company, which is
--     the opposite of a per-site record. It also moves the ON CONFLICT target in integrations.service.ts#createConnection
--     for every existing kind (company, client, user, github_app) to an expression index, a change to rows that have no
--     part in this ticket.
-- With A the unique key, the ON CONFLICT target, RLS and every existing row stay exactly as they are; the new kind is one
-- more value of the discriminator, and its key is naturally (tenant, 'webdev_site', <row>, ssh|ftp): at most one SFTP and
-- one FTPS principal per site environment, which is the rule WSK-D79 states.
--
-- Why the `webdev_sites` row and not the provisioned site. A `webdev_sites` row IS one site in one environment: the
-- staging row, and its production sibling created from it (site-registry.service.ts#createProductionFromStaging), each with
-- its OWN delivery binding (`host_kind`, `host_ref`, `access`, `vault_ref`) and its own org secret
-- (`WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>`). `webdev_provisioned_sites` names the site across BOTH environments, so keying
-- on it would collide again for staging vs production, which is half the bug. The row is also what holds `vault_ref`, so
-- "is this record this row's own" is an identity test (owner_id = the row's id), with nothing to join.
--
-- ── WHO READS THE ROW, AND WHAT EACH DOES WITH 'webdev_site' (application code, same change) ───────────────────────
--   delivery-binding.ts#vaultRecordRefusal   (the bind, and P6o's write facts) accepts it for its OWN row only; a record
--                                            of another site, or of the same site's other environment, is refused
--                                            `vault_ref_wrong_owner`.
--   deploy-secret.service.ts                 the seal accepts it and also refuses a credential whose `environment` is not
--                                            the owning row's; a new route creates the record for a row (validated: a
--                                            live staging or production row of this tenant) and lists a row's records.
--   integrations.controller.ts               unchanged. cerbosOwnerId() gives "" for every non-user kind, so the record
--                                            is the company tier (`integration_connection · manage`) for PATCH, revoke,
--                                            the VLT-3 reveal request, its redeem, and the decide gate. Not creatable
--                                            through the generic POST (CLIENT_CREATABLE_OWNER_KINDS stays user|company).
--   Cerbos integration_connection            no policy change (no restart needed for this ticket).
--   RLS                                      unchanged: tenant_isolation over app_current_tenants(), FORCE kept.
--
-- ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────────────────────────────────────
--   * No FK from owner_id to webdev_sites: owner_id is polymorphic and carries no FK for any kind (0033), and WSK-D30 keeps
--     the registry and the vault uncoupled at the schema level (202609040404's header). The creation route validates the
--     row; and a stray owner_id is inert, because only the row it names can bind it.
--   * No second CHECK such as "webdev_site implies provider ssh|ftp". Every widening of owner_kind finds its CHECK by its
--     definition text (0035, this file); a second CHECK naming owner_kind would make that lookup ambiguous for every future
--     author. The provider is enforced where it matters: the create route takes ssh|ftp only, and the bind and the seal
--     refuse any other provider (`vault_ref_wrong_provider`, `deploy_credential_wrong_record`).
--
-- ── HOW THE CHECK IS REBUILT: from its LIVE definition, never from a typed list ────────────────────────────────────
-- 202608311000 shipped a DROP + ADD typed from 0033's list and deleted 'client' ON LIVE (202608311400 repaired it). This
-- file reads pg_get_constraintdef(), refuses unless EXACTLY ONE owner_kind CHECK exists and it still admits every value
-- an earlier migration added ('user','company' 0033; 'client' 0035; 'github_app' 202608311000/202608311400), then
-- re-declares the live set plus 'webdev_site' under the SAME name, re-reads it and asserts nothing was lost or gained.
-- Re-runnable: when 'webdev_site' is already admitted it changes nothing and says so.
--
-- ── DATA, RLS, GRANTS, ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────
-- DDL and COMMENTs only: no INSERT, no UPDATE, no backfill, so the RLS zero-row trap of a backfill cannot arise (the
-- catalog reads are not subject to FORCE RLS). Every existing row's owner_kind is one of the four prior values, so the
-- widened CHECK is satisfied by all history. No GRANT, no policy change. Additive: deploy order is migrate then the app;
-- an old app never writes 'webdev_site', and the new app's route is the only writer of it. Rollback, if ever needed: drop
-- the per-site rows first (they would violate a narrowed CHECK), then rebuild the CHECK from its live definition minus
-- 'webdev_site'.

-- ═══ (1) owner_kind admits 'webdev_site', rebuilt from the LIVE definition ═══════════════════════════════════════════
DO $$
DECLARE
  v_name    text;
  v_def     text;
  v_live    text[];
  v_known   text[] := ARRAY['user', 'company', 'client', 'github_app'];
  v_new     text[];
  v_missing text[];
  v_after   text[];
  n         int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%owner_kind%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271200: expected exactly 1 owner_kind CHECK on integration_connections, found %; refusing to guess which to replace', n;
  END IF;

  SELECT conname, pg_get_constraintdef(oid) INTO v_name, v_def FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%owner_kind%';

  SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[]) INTO v_live
    FROM regexp_matches(v_def, '''([^'']*)''', 'g') AS m;
  IF cardinality(v_live) = 0 THEN
    RAISE EXCEPTION '202610271200: parsed zero literals out of the live owner_kind CHECK (%); refusing to proceed', v_def;
  END IF;

  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing FROM unnest(v_known) AS x WHERE NOT (x = ANY (v_live));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '202610271200: the LIVE owner_kind CHECK (%) no longer admits %: the estate has drifted from 0033/0035/202608311400. Nothing was changed.',
      v_def, v_missing;
  END IF;

  IF 'webdev_site' = ANY (v_live) THEN
    RAISE NOTICE '202610271200: owner_kind already admits webdev_site; nothing changed (%)', v_def;
    RETURN;
  END IF;

  SELECT array_agg(x ORDER BY x) INTO v_new FROM (SELECT DISTINCT unnest(v_live || ARRAY['webdev_site']) AS x) AS d;
  EXECUTE format('ALTER TABLE integration_connections DROP CONSTRAINT %I', v_name);
  EXECUTE format('ALTER TABLE integration_connections ADD CONSTRAINT %I CHECK (owner_kind IN (%s))', v_name,
                 (SELECT string_agg(quote_literal(x), ', ' ORDER BY x) FROM unnest(v_new) AS x));

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass AND conname = v_name;
  SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[]) INTO v_after
    FROM regexp_matches(v_def, '''([^'']*)''', 'g') AS m;
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing FROM unnest(v_new) AS x WHERE NOT (x = ANY (v_after));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '202610271200: the owner_kind CHECK lost % in the re-declaration (now: %)', v_missing, v_def;
  END IF;
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing FROM unnest(v_after) AS x WHERE NOT (x = ANY (v_new));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '202610271200: the owner_kind CHECK gained unexpected % (now: %)', v_missing, v_def;
  END IF;
  RAISE NOTICE '202610271200: owner_kind CHECK widened: % -> %', v_live, v_after;
END $$;

-- ═══ (2) the meaning, where a reader of the schema finds it ══════════════════════════════════════════════════════════
COMMENT ON COLUMN integration_connections.owner_kind IS
  'Who the record belongs to, and so what owner_id is (polymorphic, no FK): user -> users.id (a person''s own link); '
  'company -> the company id (= tenant_id); client -> clients.id (0035); github_app -> a UUIDv5 of the App slug '
  '(202608311000, ops-provisioned); webdev_site -> webdev_sites.id, ONE site in ONE environment (202610271200, M6-P6o2: '
  'that row''s own docroot-locked ssh or ftp deploy principal, bindable to that row only). The UNIQUE key '
  '(tenant_id, owner_kind, owner_id, provider) gives each owner one record per provider.';

COMMENT ON COLUMN webdev_sites.vault_ref IS
  'Pointer to an operator vault item. NEVER a credential (WSK-D30). For a delivered site it is the text form of an '
  'integration_connections.id in the SAME tenant, provider ssh or ftp for the row''s access, owned by the company, by this '
  'row''s own client, or (preferred, M6-P6o2, 202610271200) by THIS row itself (owner_kind=''webdev_site'', owner_id = this '
  'row''s id), so each site and environment has its own principal. Enforced at the application layer '
  '(delivery-binding.ts#vaultRecordRefusal), not by a DB foreign key: this column is deliberately untyped text so this '
  'table carries no schema dependency on the vault table''s shape (202609040404).';

-- ═══ (3) self-check: the whole contract this file relies on, re-read from the catalog ════════════════════════════════
DO $$
DECLARE
  v_def      text;
  v_vals     text[];
  v_expected text[] := ARRAY['client', 'company', 'github_app', 'user', 'webdev_site'];
  n          int;
  v_rls      boolean;
  v_force    boolean;
BEGIN
  -- exactly one owner_kind CHECK, admitting exactly the five kinds
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%owner_kind%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271200 self-check: expected exactly 1 owner_kind CHECK, found %', n;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%owner_kind%';
  SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[]) INTO v_vals
    FROM regexp_matches(v_def, '''([^'']*)''', 'g') AS m;
  IF v_vals IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION '202610271200 self-check: owner_kind CHECK admits %, expected exactly % (definition: %)', v_vals, v_expected, v_def;
  END IF;

  -- the unique key the ON CONFLICT upsert (integrations.service.ts#createConnection) targets is still there, unchanged
  SELECT count(*) INTO n FROM pg_constraint c
   WHERE c.conrelid = 'integration_connections'::regclass AND c.contype = 'u'
     AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
         = ARRAY['tenant_id', 'owner_kind', 'owner_id', 'provider'];
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271200 self-check: UNIQUE (tenant_id, owner_kind, owner_id, provider) found % time(s), expected 1', n;
  END IF;

  -- RLS on and FORCED, with the tenant wall
  SELECT relrowsecurity, relforcerowsecurity INTO v_rls, v_force FROM pg_class WHERE oid = 'integration_connections'::regclass;
  IF NOT (v_rls AND v_force) THEN
    RAISE EXCEPTION '202610271200 self-check: integration_connections must have RLS enabled AND forced (enabled %, forced %)', v_rls, v_force;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'integration_connections' AND policyname = 'tenant_isolation'
     AND qual ILIKE '%app_current_tenants%' AND with_check ILIKE '%app_current_tenants%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271200 self-check: the tenant_isolation policy (app_current_tenants, USING and WITH CHECK) is missing';
  END IF;

  RAISE NOTICE '202610271200 self-check passed: owner_kind %, unique key intact, FORCE RLS intact', v_vals;
END $$;
