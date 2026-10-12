-- M5-V3-d — consented visitor profiles (docs/plans/2026-10-12-m5-phase5-design.md §4.5, §4.6, §4.7, §4.8).
--
-- Only visitors who accepted analytics AND whose consent the WebDesk consent log proves (D5) ever get a row
-- here. Profiles are built from the collector's 72-hour buffer by the ERP's own jobs (V3-e); this file is the
-- schema only. Six new tables, one trigger, one index on agency_leads. DDL ONLY: no INSERT/UPDATE/DELETE,
-- no backfill, so the RLS zero-row trap (an unset app.current_tenant_ids reads ZERO rows, silently) cannot
-- bite and there is nothing for lint-migration-rls to flag.
--
--   search_visitor_profiles       one row per (property, visitor id). Summary only: counts, device class, geo
--                                 (country + city), first source, latest network/company resolver result,
--                                 interests, score and every score part. NO raw IP and NO user agent anywhere
--                                 (the collector never stores them either; a self-check below refuses any
--                                 column named like one).
--   search_visitor_events         the consented event stream of a profile; ON DELETE CASCADE from the profile,
--                                 so deleting a profile (withdrawal sweep, erasure, 14-month purge) deletes
--                                 its events in the same statement. `data` is allow-listed at the database.
--   search_visitor_tombstones     SHA-256 of a visitor id or consent id that was withdrawn or erased. HASHES
--                                 ONLY: an erased person's pseudonym is not kept. A trigger on the profiles
--                                 table refuses to (re)create a profile whose visitor id or consent id is
--                                 tombstoned (the database enforces what ingest also checks).
--   search_interest_rules         the data behind interests (path or section prefix -> facet + tag + weight).
--   search_visitor_ingest_state   one cursor row per property for the pull from the collector.
--   (agency_leads)                ONE added index for the lead link; no column, constraint or policy touched.
--
-- RLS. Every new table is ENABLE + FORCE ROW LEVEL SECURITY with the same composed wall as 202610122200 /
-- 0034 / 202608221727: `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')`, as USING and
-- WITH CHECK. Written through withTenants([t], fn, {modules:['search']}). No grant is added or widened: runtime
-- DML grants come from the owner's ALTER DEFAULT PRIVILEGES + RUNTIME_GRANTS_SQL pass (migrations/README.md).
-- Nothing here is SECURITY DEFINER and nothing bypasses RLS.
--
-- HASH CONTRACT (the writer in V3-e and the rights-request flow in V3-h MUST use it):
--   id_hash = sha256( utf8( <uuid in lower-case canonical text form> ) )   -- SQL: sha256(convert_to(id::text,'UTF8'))
--   Node:    createHash('sha256').update(id.toLowerCase(), 'utf8').digest()
-- The trigger below computes the same value from the profile's visitor_id / consent_id.
--
-- TRAPS HANDLED. (1) NULL defeats UNIQUE: every unique key here is over NOT NULL columns, so none can be
-- bypassed by a NULL. (2) NULL passes a CHECK: where a nullable column must still be well-formed the CHECK
-- is meant to pass NULL (country, city, path, name, data, first_source, network, company); where NULL must
-- NOT pass (an event's path/name by kind) the CHECK is written as `kind <> 'x' OR col IS NOT NULL`, which is
-- false for a NULL. (3) No DROP + ADD on a shared CHECK: every constraint is new and named by its own table.
--
-- IDEMPOTENT: re-running the file is a no-op (IF NOT EXISTS everywhere, policies and the trigger guarded
-- by catalog lookups); the runner applies it once and records the filename regardless.
-- To undo: DROP TABLE search_visitor_events, search_visitor_profiles, search_visitor_tombstones,
-- search_interest_rules, search_visitor_ingest_state; DROP FUNCTION search_visitor_profiles_tombstone_guard();
-- DROP INDEX ix_lead_consent_id. (Dropping the tombstones forgets who must stay forgotten; only do it with
-- the profiles.)
--
-- ROLLOUT: purely additive; deploy order irrelevant (nothing reads these tables until V3-e/V3-g ship).

-- (1) profiles ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_visitor_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  visitor_id uuid NOT NULL,                       -- the browser-minted id (I1); never sent to a third party (I7)
  consent_id uuid NOT NULL,                       -- the WebDesk consent log id that proves analytics consent
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,              -- the 14-month retention clock (§4.7)
  visits integer NOT NULL DEFAULT 0 CHECK (visits >= 0),
  pageviews integer NOT NULL DEFAULT 0 CHECK (pageviews >= 0),
  device text NOT NULL DEFAULT 'unknown' CHECK (device IN ('desktop','mobile','tablet','unknown')),
  country text CHECK (country ~ '^[A-Z]{2}$'),
  city text CHECK (char_length(city) BETWEEN 1 AND 120),
  first_source jsonb CHECK (jsonb_typeof(first_source) = 'object' AND pg_column_size(first_source) <= 2048),
                                                  -- {referrerHost, utmSource, utmMedium, utmCampaign}; no query strings
  network jsonb CHECK (jsonb_typeof(network) = 'object' AND pg_column_size(network) <= 2048),
  company jsonb CHECK (jsonb_typeof(company) = 'object' AND pg_column_size(company) <= 2048),
                                                  -- latest resolver results with kind/confidence/source/version
  interests jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(interests) = 'object' AND pg_column_size(interests) <= 8192),
  score smallint NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  score_parts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(score_parts) = 'object' AND pg_column_size(score_parts) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_visitor_profiles_seen_order CHECK (last_seen_at >= first_seen_at),
  CONSTRAINT search_visitor_profiles_key UNIQUE (tenant_id, property_id, visitor_id),
  -- lets an event reference its profile WITH tenant and property, so an event can never drift to another
  -- tenant or property than its profile (a plain FK on id alone would allow it).
  CONSTRAINT search_visitor_profiles_scope UNIQUE (id, tenant_id, property_id)
);
CREATE INDEX IF NOT EXISTS ix_visitor_consent ON search_visitor_profiles (tenant_id, property_id, consent_id);
CREATE INDEX IF NOT EXISTS ix_visitor_recent  ON search_visitor_profiles (tenant_id, property_id, last_seen_at DESC);
-- the list is ordered by score on the server (V3-g)
CREATE INDEX IF NOT EXISTS ix_visitor_score   ON search_visitor_profiles (tenant_id, property_id, score DESC, last_seen_at DESC);

-- (2) events -----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_visitor_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  collector_event_id bigint NOT NULL,             -- the collector's bigserial; dedupes a re-pulled batch
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pageview','event')),
  path text CHECK (char_length(path) BETWEEN 1 AND 512 AND left(path, 1) = '/'
                   AND position('?' in path) = 0 AND position('#' in path) = 0),   -- path only, no query or hash
  name text CHECK (char_length(name) BETWEEN 1 AND 50),
  -- only the five keys the collector accepts (§4.2 step 2); anything else is refused here too.
  data jsonb CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 1024
                    AND (data - ARRAY['section_id','link_location','form_id','step_index','language_to']) = '{}'::jsonb),
  CONSTRAINT search_visitor_events_pageview_path CHECK (kind <> 'pageview' OR path IS NOT NULL),
  CONSTRAINT search_visitor_events_event_name CHECK (kind <> 'event' OR name IS NOT NULL),
  CONSTRAINT search_visitor_events_collector_key UNIQUE (property_id, collector_event_id),
  CONSTRAINT search_visitor_events_profile_fk FOREIGN KEY (profile_id, tenant_id, property_id)
    REFERENCES search_visitor_profiles (id, tenant_id, property_id) ON DELETE CASCADE
);
-- the detail view (latest 200) and the 90-day interest recompute both read one profile's events by time
CREATE INDEX IF NOT EXISTS ix_visitor_events_profile ON search_visitor_events (profile_id, occurred_at DESC);

-- (3) tombstones (hashes only) -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_visitor_tombstones (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL,                      -- no FK: a tombstone outlives everything else, by design
  kind text NOT NULL CHECK (kind IN ('visitor','consent')),
  id_hash bytea NOT NULL CHECK (octet_length(id_hash) = 32),   -- sha256 of the id; see HASH CONTRACT above
  reason text NOT NULL CHECK (reason IN ('withdraw','erase')),
  created_at timestamptz NOT NULL DEFAULT now(),  -- the 14-month retention clock (§4.7)
  PRIMARY KEY (property_id, kind, id_hash)
);
CREATE INDEX IF NOT EXISTS ix_visitor_tombstones_age ON search_visitor_tombstones (tenant_id, created_at);

-- (4) interest rules ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_interest_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  match text NOT NULL CHECK (match IN ('path_prefix','section_prefix')),
  pattern text NOT NULL CHECK (char_length(pattern) BETWEEN 1 AND 200),
  facet text NOT NULL CHECK (facet IN ('industry','service')),
  tag text NOT NULL CHECK (tag ~ '^[a-z0-9-]{1,40}$'),
  weight smallint NOT NULL CHECK (weight BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_interest_rules_key UNIQUE (property_id, match, pattern, facet, tag)
);
CREATE INDEX IF NOT EXISTS ix_interest_rules_property ON search_interest_rules (tenant_id, property_id);

-- (5) ingest state -----------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_visitor_ingest_state (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid PRIMARY KEY REFERENCES search_properties(id),
  cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_outcome text CHECK (char_length(last_outcome) <= 200)   -- words, no ids
);

-- (6) a tombstoned visitor or consent can never get a profile ----------------------------------------------
-- BEFORE INSERT, and BEFORE UPDATE of the two ids. SECURITY INVOKER (default): it reads the tombstones table
-- under the caller's own RLS scope, which is the same tenant, so nothing is bypassed. The message carries no id.
-- A concurrent withdrawal that has not committed yet is invisible here; V3-e's advisory lock
-- (0x53430005, per property) is what serialises ingest against the sweep. This trigger is the last line.
CREATE OR REPLACE FUNCTION search_visitor_profiles_tombstone_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM search_visitor_tombstones t
     WHERE t.tenant_id = NEW.tenant_id AND t.property_id = NEW.property_id
       AND ((t.kind = 'visitor' AND t.id_hash = sha256(convert_to(NEW.visitor_id::text, 'UTF8')))
         OR (t.kind = 'consent' AND t.id_hash = sha256(convert_to(NEW.consent_id::text, 'UTF8'))))
  ) THEN
    RAISE EXCEPTION 'search_visitor_profiles: refused, this visitor or consent is tombstoned'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.search_visitor_profiles'::regclass AND tgname = 'search_visitor_profiles_tombstone_guard') THEN
    EXECUTE 'CREATE TRIGGER search_visitor_profiles_tombstone_guard
               BEFORE INSERT OR UPDATE OF visitor_id, consent_id, tenant_id, property_id ON search_visitor_profiles
               FOR EACH ROW EXECUTE FUNCTION search_visitor_profiles_tombstone_guard()';
  END IF;
END $$;

-- (7) RLS: ENABLE + FORCE + the composed search wall on every new table ------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['search_visitor_profiles', 'search_visitor_events', 'search_visitor_tombstones',
                           'search_interest_rules', 'search_visitor_ingest_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR ALL
           USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
           WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))', t);
    END IF;
  END LOOP;
END $$;

-- (8) the lead link ----------------------------------------------------------------------------------------
-- agency_leads is a plain tenant wall (no module wall). This only ADDS an index for
--   agency_leads.visitor_consent->>'consentId' = profile.consent_id   (same tenant)
-- No column, constraint, policy or row is touched. The predicate is `IS NOT NULL` rather than the jsonb `?`
-- operator so a query written as `(visitor_consent->>'consentId') = $1` is provably covered by the partial
-- index (an equality on the expression implies it is not null; the planner cannot derive `?` from it).
CREATE INDEX IF NOT EXISTS ix_lead_consent_id
  ON agency_leads (tenant_id, (visitor_consent->>'consentId'))
  WHERE (visitor_consent->>'consentId') IS NOT NULL;

COMMENT ON TABLE search_visitor_profiles IS
  'M5-V3: one row per consented visitor of a search property (design 2026-10-12 §4.5). Only visitors whose analytics consent the WebDesk '
  'consent log proves. Summary only: no IP, no user agent, no name/email/phone. Deleted on withdrawal (sweep), on erasure, and 14 months '
  'after last_seen_at; events cascade. A score orders a list and drives no decision about a person.';
COMMENT ON TABLE search_visitor_tombstones IS
  'M5-V3: sha256 of a withdrawn or erased visitor id or consent id (HASHES ONLY, see the migration header for the encoding). A trigger on '
  'search_visitor_profiles refuses to re-create a tombstoned profile. Kept 14 months.';

-- Self-assertions (pg_catalog has no RLS, so these fire under the non-superuser migrator too).
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = current_schema() AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
     AND c.relname IN ('search_visitor_profiles', 'search_visitor_events', 'search_visitor_tombstones',
                       'search_interest_rules', 'search_visitor_ingest_state');
  IF n <> 5 THEN RAISE EXCEPTION 'M5-V3-d: all five visitor tables must ENABLE + FORCE row level security, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND policyname = 'tenant_isolation'
     AND tablename IN ('search_visitor_profiles', 'search_visitor_events', 'search_visitor_tombstones',
                       'search_interest_rules', 'search_visitor_ingest_state')
     AND qual ILIKE '%app_current_tenants%' AND qual ILIKE '%app_module_allowed%'
     AND with_check ILIKE '%app_current_tenants%' AND with_check ILIKE '%app_module_allowed%';
  IF n <> 5 THEN RAISE EXCEPTION 'M5-V3-d: expected the composed tenant_isolation policy (USING + WITH CHECK) on all five tables, found %', n; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'search_visitor_profiles'
     AND column_name IN ('visitor_id','consent_id','first_seen_at','last_seen_at','visits','pageviews','device','country','city',
                         'first_source','network','company','interests','score','score_parts');
  IF n <> 15 THEN RAISE EXCEPTION 'M5-V3-d: search_visitor_profiles is missing columns (found % of 15)', n; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'search_visitor_events'
     AND column_name IN ('profile_id','collector_event_id','occurred_at','kind','path','name','data');
  IF n <> 7 THEN RAISE EXCEPTION 'M5-V3-d: search_visitor_events is missing columns (found % of 7)', n; END IF;

  -- no raw IP and no user agent, in any of the new tables, under any spelling we would plausibly use
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name IN ('search_visitor_profiles', 'search_visitor_events', 'search_visitor_tombstones',
                        'search_interest_rules', 'search_visitor_ingest_state')
     AND column_name ~* '(^|_)(ip|ips|ua|user_?agent|ip_?addr(ess)?|remote_?addr|forwarded.*)($|_)';
  IF n <> 0 THEN RAISE EXCEPTION 'M5-V3-d: a visitor table has an IP or user-agent column (found %)', n; END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema()
     AND indexname IN ('ix_visitor_consent', 'ix_visitor_recent', 'ix_visitor_score', 'ix_visitor_events_profile',
                       'ix_visitor_tombstones_age', 'ix_interest_rules_property', 'ix_lead_consent_id');
  IF n <> 7 THEN RAISE EXCEPTION 'M5-V3-d: expected 7 indexes, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema() AND indexname = 'ix_lead_consent_id' AND tablename = 'agency_leads'
     AND indexdef ILIKE '%WHERE%';
  IF n <> 1 THEN RAISE EXCEPTION 'M5-V3-d: ix_lead_consent_id must be a partial index on agency_leads'; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.search_visitor_profiles'::regclass AND tgname = 'search_visitor_profiles_tombstone_guard' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'M5-V3-d: the tombstone guard trigger is missing'; END IF;

  -- the cascade is the erasure mechanism: it must be ON DELETE CASCADE (confdeltype 'c')
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conname = 'search_visitor_events_profile_fk' AND confdeltype = 'c';
  IF n <> 1 THEN RAISE EXCEPTION 'M5-V3-d: events must cascade from their profile'; END IF;
END $$;
