-- DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48.2): admit 'google_gmail' as a provider, in the TWO places that list the Google providers.
--
--   1. `integration_connections.provider` CHECK: the person's own Gmail link is a vault row (owner_kind 'user', owner_id = the person), exactly like
--      DW-6i's `google_drive`. In simulated mode the row holds no Google token (a sealed marker only, meta.gmailMode = 'simulated'); in live mode
--      it holds the sealed Google tokens. No new column, no new crypto.
--   2. `google_oauth_states.provider` CHECK (migration 0076, an unnamed inline CHECK, so Postgres's own `google_oauth_states_provider_check`):
--      the shared Google state machine writes an in-flight request per provider and refuses one this list does not name. Without this, live mode's
--      "start" would die at the INSERT.
--
-- HOW EACH CHECK IS REBUILT: from its LIVE definition, never from a typed list. 202608311000, 202609040401, 202610130210 and 202610140840 document
-- why: a DROP + ADD written from a hand-typed allow-list once deleted a value another migration had added, on LIVE. Each DO block reads
-- pg_get_constraintdef(), pulls every quoted literal out, unions in 'google_gmail', and re-declares the WHOLE constraint from that computed set
-- (a DROP + ADD re-declares everything). The second block then asserts the FULL list for each: every value any earlier migration is known to have
-- added is still allowed, and 'google_gmail' is too. owner_kind and status are not touched.
--
-- integration_connections values before this migration (13), by the migration that added them: github, google_drive, claude (0033);
-- google_search_console, google_analytics, google_ads, semrush (0035); cpanel, ftp, ssh, wp_admin (202609040401); bing_webmaster (202610130210);
-- figma (202610140840, the last re-declaration, DW-6k). After (14): the same thirteen + google_gmail.
-- google_oauth_states values before (4): google_search_console, google_analytics, google_ads, google_drive (0076). After (5): + google_gmail.
--
-- DDL only: no UPDATE, no INSERT, no backfill, so the RLS zero-row trap of a backfill does not arise. The catalog reads are not subject to the
-- tables' FORCE RLS.

-- ── 1 · integration_connections.provider ────────────────────────────────────────────────────────
DO $$
DECLARE
  cname      text;
  live_def   text;
  lit        text;
  values_in  text[] := ARRAY[]::text[];
  new_vals   text[] := ARRAY['google_gmail'];
  final_set  text[];
  value_list text;
BEGIN
  -- Found by the CURRENT definition text ('provider' + 'github' together: 'github' only ever appears in the provider list, never in status /
  -- owner_kind), not by a constraint name we might get wrong.
  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, live_def
    FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%provider%'
     AND pg_get_constraintdef(oid) ILIKE '%github%';

  IF cname IS NULL THEN
    RAISE EXCEPTION 'DW-8j: could not locate the provider CHECK on integration_connections - refusing to guess';
  END IF;

  FOR lit IN SELECT (regexp_matches(live_def, '''([^'']*)''', 'g'))[1] LOOP
    values_in := array_append(values_in, lit);
  END LOOP;

  IF array_length(values_in, 1) IS NULL THEN
    RAISE EXCEPTION 'DW-8j: parsed zero literals out of the live provider CHECK definition (%); refusing to proceed', live_def;
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

  RAISE NOTICE 'DW-8j: integration_connections provider CHECK rebuilt from live definition (% pre-existing value(s)) + % new = % total',
    array_length(values_in, 1), array_length(new_vals, 1), array_length(final_set, 1);
END $$;

-- ── 2 · google_oauth_states.provider ────────────────────────────────────────────────────────────
DO $$
DECLARE
  cname      text;
  live_def   text;
  lit        text;
  values_in  text[] := ARRAY[]::text[];
  new_vals   text[] := ARRAY['google_gmail'];
  final_set  text[];
  value_list text;
BEGIN
  -- 'provider' + 'google_ads' together: the code_challenge_method and owner_kind CHECKs name neither.
  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, live_def
    FROM pg_constraint
   WHERE conrelid = 'google_oauth_states'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%provider%'
     AND pg_get_constraintdef(oid) ILIKE '%google_ads%';

  IF cname IS NULL THEN
    RAISE EXCEPTION 'DW-8j: could not locate the provider CHECK on google_oauth_states - refusing to guess';
  END IF;

  FOR lit IN SELECT (regexp_matches(live_def, '''([^'']*)''', 'g'))[1] LOOP
    values_in := array_append(values_in, lit);
  END LOOP;

  IF array_length(values_in, 1) IS NULL THEN
    RAISE EXCEPTION 'DW-8j: parsed zero literals out of the live google_oauth_states provider CHECK (%); refusing to proceed', live_def;
  END IF;

  SELECT array_agg(DISTINCT v) INTO final_set
    FROM unnest(values_in || new_vals) AS v;

  SELECT string_agg(quote_literal(v), ', ') INTO value_list
    FROM unnest(final_set) AS v;

  EXECUTE format('ALTER TABLE google_oauth_states DROP CONSTRAINT %I', cname);
  EXECUTE format(
    'ALTER TABLE google_oauth_states ADD CONSTRAINT %I CHECK (provider IN (%s))',
    cname, value_list
  );

  RAISE NOTICE 'DW-8j: google_oauth_states provider CHECK rebuilt from live definition (% pre-existing value(s)) + % new = % total',
    array_length(values_in, 1), array_length(new_vals, 1), array_length(final_set, 1);
END $$;

-- ── Prove it: the full lists. Every value a prior migration added is still allowed, and google_gmail is too. ─────────────────
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
    RAISE EXCEPTION 'DW-8j self-check failed: integration_connections provider CHECK is absent after rebuild';
  END IF;

  FOREACH k IN ARRAY ARRAY[
    'github', 'google_drive', 'claude',                                   -- 0033
    'google_search_console', 'google_analytics', 'google_ads', 'semrush', -- 0035
    'cpanel', 'ftp', 'ssh', 'wp_admin',                                   -- 202609040401 (VLT-1)
    'bing_webmaster',                                                     -- 202610130210
    'figma',                                                              -- 202610140840
    'google_gmail'                                                        -- this migration
  ] LOOP
    IF position(quote_literal(k) IN def) = 0 THEN
      RAISE EXCEPTION 'DW-8j self-check failed: integration_connections provider CHECK is missing %; got %', k, def;
    END IF;
  END LOOP;

  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'google_oauth_states'
     AND pg_get_constraintdef(c.oid) ILIKE '%provider%'
     AND pg_get_constraintdef(c.oid) ILIKE '%google_ads%';

  IF def IS NULL THEN
    RAISE EXCEPTION 'DW-8j self-check failed: google_oauth_states provider CHECK is absent after rebuild';
  END IF;

  FOREACH k IN ARRAY ARRAY[
    'google_search_console', 'google_analytics', 'google_ads', 'google_drive',   -- 0076
    'google_gmail'                                                               -- this migration
  ] LOOP
    IF position(quote_literal(k) IN def) = 0 THEN
      RAISE EXCEPTION 'DW-8j self-check failed: google_oauth_states provider CHECK is missing %; got %', k, def;
    END IF;
  END LOOP;

  RAISE NOTICE 'DW-8j provider CHECK self-checks passed';
END $$;
