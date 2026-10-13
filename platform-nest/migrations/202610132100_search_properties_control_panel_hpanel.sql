-- 202610132100_search_properties_control_panel_hpanel.sql — M6-P6g, HSR-4 (docs/plans/2026-09-04-hostinger-shared-replatform.md §6).
--
-- `search_properties.control_panel` cannot say "hPanel". Hostinger's panel is hPanel, which is not cPanel; today every
-- Hostinger site would have to record 'other', erasing the very distinction the column exists to make (the panel decides
-- what operating on the site looks like at all). This adds ONE value, 'hpanel'.
--
-- ── THE CHECK TRAP, AND HOW THIS FILE AVOIDS IT ─────────────────────────────────────────────────────
-- Postgres cannot ALTER a CHECK in place, so the widening is a DROP + ADD. A DROP + ADD built from memory, or from the
-- first migration that declared the constraint, silently deletes any value a later migration added (this repo lost a
-- live value that way; see migrations/202608311000_integration_connections_github_app_owner_kind.sql). So the new value
-- list is NOT typed here. It is read from the LIVE definition (`pg_get_constraintdef`) and 'hpanel' is unioned in, the
-- same idiom as 202609040401_integration_connections_hosting_providers.sql (VLT-1).
--
-- Every migration that ever touched this constraint (read to write this file; `grep -rl control_panel migrations/`):
--   202608300818_sm74_property_hosting_topology.sql  the ONLY one. It added the column with an inline
--       CHECK (control_panel IS NULL OR control_panel IN ('cpanel','plesk','directadmin','none','other')).
--   No later migration widens, narrows, renames or replaces it. The live value list is therefore expected to be exactly
--   those five; the code below does not rely on that, it reads whatever the constraint holds when it runs and keeps it.
--
-- ── WHAT STAYS TRUE ─────────────────────────────────────────────────────────────────────────────────
-- * NULL stays valid (`control_panel IS NULL OR ...`): NULL means "not surveyed", a different fact from 'none' or 'other'.
--   A CHECK also passes on NULL by itself, so the NULL arm is kept explicit rather than relied on.
-- * The constraint keeps its live name (Postgres auto-named it `search_properties_control_panel_check`).
-- * No row is touched: every existing value is a member of the widened set, so there is nothing to backfill.
-- * No column, index, policy or default changes.
--
-- ── ASSERT, DON'T ASSUME ────────────────────────────────────────────────────────────────────────────
-- After the rebuild the file checks that exactly one control_panel CHECK exists, that every value the old definition held
-- is still in the new one, and that 'hpanel' is. Any failure raises and the whole migration rolls back (migrate.ts runs
-- each file in one transaction). Re-running is a no-op: a definition that already holds 'hpanel' is left alone.
DO $$
DECLARE
  n_found    integer;
  cname      text;
  old_def    text;
  old_vals   text[] := ARRAY[]::text[];
  lit        text;
  final_set  text[];
  value_list text;
  new_def    text;
  v          text;
BEGIN
  SELECT count(*) INTO n_found
    FROM pg_constraint
   WHERE conrelid = 'search_properties'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%control_panel%';

  IF n_found <> 1 THEN
    RAISE EXCEPTION 'M6-P6g: expected exactly ONE control_panel CHECK on search_properties, found % — refusing to guess', n_found;
  END IF;

  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, old_def
    FROM pg_constraint
   WHERE conrelid = 'search_properties'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%control_panel%';

  -- Already widened (a re-run, or a database that took this change another way): nothing to do.
  IF position('''hpanel''' IN old_def) > 0 THEN
    RAISE NOTICE 'M6-P6g: % already admits hpanel — nothing to do', cname;
    RETURN;
  END IF;

  -- Every single-quoted literal the live definition holds. Robust to either rendering Postgres picks
  -- (`IN ('a','b')` or `= ANY (ARRAY['a'::text, 'b'::text])`): both quote each value the same way.
  FOR lit IN SELECT (regexp_matches(old_def, '''([^'']*)''', 'g'))[1] LOOP
    old_vals := array_append(old_vals, lit);
  END LOOP;

  IF array_length(old_vals, 1) IS NULL THEN
    RAISE EXCEPTION 'M6-P6g: parsed zero literals out of the live control_panel CHECK (%) — refusing to proceed', old_def;
  END IF;

  SELECT array_agg(DISTINCT x ORDER BY x) INTO final_set FROM unnest(old_vals || ARRAY['hpanel']) AS x;
  SELECT string_agg(quote_literal(x), ', ' ORDER BY x) INTO value_list FROM unnest(final_set) AS x;

  EXECUTE format('ALTER TABLE search_properties DROP CONSTRAINT %I', cname);
  EXECUTE format(
    'ALTER TABLE search_properties ADD CONSTRAINT %I CHECK (control_panel IS NULL OR control_panel IN (%s))',
    cname, value_list
  );

  -- Assert on what the database now holds, not on what this block meant to write.
  SELECT count(*) INTO n_found
    FROM pg_constraint
   WHERE conrelid = 'search_properties'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%control_panel%';
  IF n_found <> 1 THEN
    RAISE EXCEPTION 'M6-P6g: expected ONE control_panel CHECK after the rebuild, found %', n_found;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO new_def
    FROM pg_constraint
   WHERE conrelid = 'search_properties'::regclass AND contype = 'c' AND conname = cname;
  IF new_def IS NULL THEN
    RAISE EXCEPTION 'M6-P6g: constraint % missing after the rebuild', cname;
  END IF;

  FOREACH v IN ARRAY old_vals LOOP
    IF position('''' || v || '''' IN new_def) = 0 THEN
      RAISE EXCEPTION 'M6-P6g: value % was in the old control_panel CHECK and is missing from the new one (%)', v, new_def;
    END IF;
  END LOOP;
  IF position('''hpanel''' IN new_def) = 0 THEN
    RAISE EXCEPTION 'M6-P6g: hpanel is missing from the rebuilt control_panel CHECK (%)', new_def;
  END IF;

  RAISE NOTICE 'M6-P6g: control_panel CHECK rebuilt from the live definition (% earlier value(s)) + hpanel', array_length(old_vals, 1);
END $$;

COMMENT ON COLUMN search_properties.control_panel IS
  'Observed control panel (cpanel | plesk | directadmin | hpanel | none | other; NULL = not surveyed). Decides what '
  'operating on the site looks like at all: cpanel means FTP and a web UI with no shell, so deployment is a '
  'DNS-and-export exercise rather than a push. hpanel (HSR-4, M6-P6g) is Hostinger''s panel, which is not cPanel.';
