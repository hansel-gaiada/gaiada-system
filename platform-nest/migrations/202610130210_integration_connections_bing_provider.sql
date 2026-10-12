-- 202610130210_integration_connections_bing_provider.sql — M5-P5a: admit 'bing_webmaster' as an
-- `integration_connections.provider`, so the Bing Webmaster API key is sealed in the SAME vault column the
-- Google tokens and hosting credentials use (access_token_enc via secret-box). No new column, no new crypto.
--
-- A Bing connection row: owner_kind = 'client', owner_id = clients.id (polymorphic, no FK, as the Google rows),
-- provider = 'bing_webmaster', the API key sealed in access_token_enc.
--
-- HOW THE CHECK IS REBUILT: from its LIVE definition, never from a typed list. 202608311000 and
-- 202609040401 document why (a DROP + ADD written from a hand-typed allow-list once deleted a value another
-- migration had added, on LIVE). The DO block reads pg_get_constraintdef(), pulls every quoted literal out,
-- unions in the new value, and re-adds the constraint from that computed set; a second block then asserts that
-- every value any earlier migration is known to have added is still present. owner_kind is not touched.
--
-- DDL only: no UPDATE, no INSERT, no backfill. The catalog read is not subject to the table's FORCE RLS.

DO $$
DECLARE
  cname      text;
  live_def   text;
  lit        text;
  values_in  text[] := ARRAY[]::text[];
  new_vals   text[] := ARRAY['bing_webmaster'];
  final_set  text[];
  value_list text;
BEGIN
  -- Found by the CURRENT definition text ('provider' + 'github' together: 'github' only ever appears in the
  -- provider list, never in status / owner_kind), not by a constraint name we might get wrong.
  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, live_def
    FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%provider%'
     AND pg_get_constraintdef(oid) ILIKE '%github%';

  IF cname IS NULL THEN
    RAISE EXCEPTION 'M5-P5a: could not locate the provider CHECK on integration_connections — refusing to guess';
  END IF;

  FOR lit IN SELECT (regexp_matches(live_def, '''([^'']*)''', 'g'))[1] LOOP
    values_in := array_append(values_in, lit);
  END LOOP;

  IF array_length(values_in, 1) IS NULL THEN
    RAISE EXCEPTION 'M5-P5a: parsed zero literals out of the live provider CHECK definition (%); refusing to proceed', live_def;
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

  RAISE NOTICE 'M5-P5a: provider CHECK rebuilt from live definition (% pre-existing value(s)) + % new = % total',
    array_length(values_in, 1), array_length(new_vals, 1), array_length(final_set, 1);
END $$;

-- Prove it: the new value is present and nothing a prior migration added was lost.
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
    RAISE EXCEPTION 'M5-P5a self-check failed: provider CHECK is absent after rebuild';
  END IF;

  FOREACH k IN ARRAY ARRAY[
    'github', 'google_drive', 'claude',                                   -- 0033
    'google_search_console', 'google_analytics', 'google_ads', 'semrush', -- 0035
    'cpanel', 'ftp', 'ssh', 'wp_admin',                                   -- VLT-1
    'bing_webmaster'                                                      -- this migration
  ] LOOP
    IF position(quote_literal(k) IN def) = 0 THEN
      RAISE EXCEPTION 'M5-P5a self-check failed: provider CHECK is missing %; got %', k, def;
    END IF;
  END LOOP;

  RAISE NOTICE 'M5-P5a self-check passed: %', def;
END $$;
