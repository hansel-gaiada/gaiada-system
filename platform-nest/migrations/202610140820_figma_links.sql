-- DW-6k (docs/FRONTEND-BFF-CONTRACT.md §36; plan docs/plans/2026-10-13-department-workspaces.md §4.1 and §4.2): FIGMA LINKS on PM
-- tasks, work requests and campaign parts. Two things, both additive.
--
--   1. The `integration_connections` provider CHECK admits 'figma', so the company's Figma token is sealed in the SAME vault
--      column every other token uses (access_token_enc via core/secret-box). No new column, no new crypto. A Figma connection
--      row is owner_kind = 'company', owner_id = the company, provider = 'figma'; `meta.tokenType` says whether the sealed
--      secret is a personal access token ('pat', sent as X-Figma-Token) or an OAuth token ('oauth', sent as a Bearer).
--   2. `figma_links` (new): one link per (target, file, frame), with a small cache of what Figma last said. Thumbnails are
--      never stored (§36.3).
--
-- HOW THE CHECK IS REBUILT: from its LIVE definition, never from a typed list. 202608311000, 202609040401 and 202610130210
-- document why: a DROP + ADD written from a hand-typed allow-list once deleted a value another migration had added, on LIVE.
-- The DO block reads pg_get_constraintdef(), pulls every quoted literal out, unions in 'figma', and re-adds the constraint
-- from that computed set. The second block then asserts the FULL list: every one of the twelve values that existed before this
-- migration is still allowed, and 'figma' is too. owner_kind is not touched.
--
-- Values before this migration (12): github, google_drive, claude (0033); google_search_console, google_analytics,
-- google_ads, semrush (0035); cpanel, ftp, ssh, wp_admin (202609040401); bing_webmaster (202610130210).
-- Values after (13): the same twelve + figma.
--
-- figma_links.target_id has no FK: it names a row in one of THREE tables (pm_tasks, work_requests, agency_campaign_parts),
-- so the route checks that the target exists in the tenant (§36.2). asset_group_id is the Asset Library group the link's
-- exports go into (§36.4): the first export's id, which is also the group key of every later version (§35.2).
--
-- Grants: runtime DML comes from the owner's ALTER DEFAULT PRIVILEGES + the RUNTIME_GRANTS_SQL pass (migrations/README.md),
-- as for every other tenant table; nothing is granted by hand here. Pure DDL: no UPDATE, no INSERT, no backfill, so the RLS
-- zero-row trap of a backfill does not arise.

-- ── 1 · the provider CHECK ──────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  cname      text;
  live_def   text;
  lit        text;
  values_in  text[] := ARRAY[]::text[];
  new_vals   text[] := ARRAY['figma'];
  final_set  text[];
  value_list text;
BEGIN
  -- Found by the CURRENT definition text ('provider' + 'github' together: 'github' only ever appears in the provider list,
  -- never in status / owner_kind), not by a constraint name we might get wrong.
  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, live_def
    FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%provider%'
     AND pg_get_constraintdef(oid) ILIKE '%github%';

  IF cname IS NULL THEN
    RAISE EXCEPTION 'DW-6k: could not locate the provider CHECK on integration_connections - refusing to guess';
  END IF;

  FOR lit IN SELECT (regexp_matches(live_def, '''([^'']*)''', 'g'))[1] LOOP
    values_in := array_append(values_in, lit);
  END LOOP;

  IF array_length(values_in, 1) IS NULL THEN
    RAISE EXCEPTION 'DW-6k: parsed zero literals out of the live provider CHECK definition (%); refusing to proceed', live_def;
  END IF;

  SELECT array_agg(DISTINCT v) INTO final_set
    FROM unnest(values_in || new_vals) AS v;

  SELECT string_agg(quote_literal(v), ', ') INTO value_list
    FROM unnest(final_set) AS v;

  EXECUTE format('ALTER TABLE integration_connections DROP CONSTRAINT %I', cname);
  EXECUTE format(
    'ALTER TABLE integration_connections ADD CONSTRAINT %I CHECK (provider IN (%s))',
    cname, value_list
  );

  RAISE NOTICE 'DW-6k: provider CHECK rebuilt from live definition (% pre-existing value(s)) + % new = % total',
    array_length(values_in, 1), array_length(new_vals, 1), array_length(final_set, 1);
END $$;

-- Prove it: the full list. Every value a prior migration added is still allowed, and figma is too.
DO $$
DECLARE
  def text;
  k   text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'integration_connections'
     AND pg_get_constraintdef(c.oid) ILIKE '%provider%'
     AND pg_get_constraintdef(c.oid) ILIKE '%github%';

  IF def IS NULL THEN
    RAISE EXCEPTION 'DW-6k self-check failed: provider CHECK is absent after rebuild';
  END IF;

  FOREACH k IN ARRAY ARRAY[
    'github', 'google_drive', 'claude',                                   -- 0033
    'google_search_console', 'google_analytics', 'google_ads', 'semrush', -- 0035
    'cpanel', 'ftp', 'ssh', 'wp_admin',                                   -- 202609040401 (VLT-1)
    'bing_webmaster',                                                     -- 202610130210
    'figma'                                                               -- this migration
  ] LOOP
    IF position(quote_literal(k) IN def) = 0 THEN
      RAISE EXCEPTION 'DW-6k self-check failed: provider CHECK is missing %; got %', k, def;
    END IF;
  END LOOP;

  RAISE NOTICE 'DW-6k provider CHECK self-check passed: %', def;
END $$;

-- ── 2 · figma_links ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS figma_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  target_kind text NOT NULL CHECK (target_kind IN ('pm_task', 'work_request', 'campaign_part')),
  target_id uuid NOT NULL,
  file_key text NOT NULL,
  node_id text,
  url text NOT NULL,
  title text,
  last_modified timestamptz,
  open_comments integer,
  cached_at timestamptz,
  asset_group_id uuid REFERENCES creative_assets(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- One live link per target, file and frame. NULL node_id (the whole file) is one slot, via COALESCE: a plain unique index
-- would let two whole-file links through (NULL never equals NULL).
CREATE UNIQUE INDEX IF NOT EXISTS ux_figma_links_target_file_node
  ON figma_links (tenant_id, target_kind, target_id, file_key, COALESCE(node_id, ''))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_figma_links_target
  ON figma_links (tenant_id, target_kind, target_id)
  WHERE deleted_at IS NULL;

ALTER TABLE figma_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE figma_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON figma_links;
CREATE POLICY tenant_isolation ON figma_links FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_class WHERE relname = 'figma_links' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140820: figma_links must exist with RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'figma_links' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140820: figma_links needs exactly one tenant_isolation policy, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'figma_links' AND indexname IN ('ux_figma_links_target_file_node', 'ix_figma_links_target');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610140820: the two figma_links indexes are missing (found % of 2)', n;
  END IF;
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'figma_links' AND indexname = 'ux_figma_links_target_file_node'
     AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%deleted_at IS NULL%' AND indexdef ILIKE '%COALESCE%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140820: ux_figma_links_target_file_node must be a UNIQUE partial index over COALESCE(node_id, '''')';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'figma_links'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%target_kind%'
     AND pg_get_constraintdef(oid) ILIKE '%pm_task%' AND pg_get_constraintdef(oid) ILIKE '%work_request%'
     AND pg_get_constraintdef(oid) ILIKE '%campaign_part%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140820: the target_kind CHECK is missing or incomplete (found % matching)', n;
  END IF;
END $$;
