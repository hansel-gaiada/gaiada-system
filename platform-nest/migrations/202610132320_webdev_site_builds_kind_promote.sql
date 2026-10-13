-- 202610132320_webdev_site_builds_kind_promote.sql — M6-P6h (docs/plans/2026-10-11-webdesk-m6-plan.md, the M6-P6h row):
-- a production PROMOTE is recorded in the WSK-60 build ledger, one row per approval, like a staging publish or rebuild.
--
-- ── NUMBERING ───────────────────────────────────────────────────────────────────────────────────────
-- Main's newest migration when this file was named (origin/main 34866ec7, release 1.0.0-alpha.371) was
-- `202610132210_webdev_deploy_secret_name_repo_id.sql`; this takes a later minute, with a gap left for concurrent sessions.
--
-- ── WHAT CHANGES: ONE CHECK, WIDENED BY ONE VALUE ──────────────────────────────────────────────────
-- `webdev_site_builds.kind` gains 'promote'. Postgres cannot ALTER a CHECK in place, so the widening is a DROP + ADD, and a
-- DROP + ADD built from memory silently deletes any value a later migration added (this repo lost a live value that way:
-- migrations/202608311000_integration_connections_github_app_owner_kind.sql; memory "a DROP+ADD on a shared CHECK
-- re-declares everything"). So the value list is NOT typed here: it is READ from the live definition
-- (`pg_get_constraintdef`) and 'promote' is unioned in, the house pattern of 202610132100_search_properties_control_panel_hpanel.sql.
--
-- Every migration that ever touched this constraint (`grep -l webdev_site_builds migrations/`):
--   202610101730_webdev_site_builds.sql  the ONLY one that declares it: an inline `kind text NOT NULL CHECK (kind IN
--       ('publish', 'rebuild'))`, auto-named `webdev_site_builds_kind_check`.
--   202610110441_webdev_schedule_firings.sql  references the table (an FK from webdev_schedule_firings.build_id) and rebuilds a
--       DIFFERENT table's kind CHECK (webdev_zoneb_event_log); it does not touch this one.
--   202610110151_projects_status_check.sql  names the table in a comment only.
-- The live list is therefore expected to be exactly ('publish', 'rebuild'). The code below does not rely on that: it keeps
-- whatever the constraint holds when it runs, and it ASSERTS that the two values the code relies on are among them.
--
-- ── WHAT STAYS TRUE ─────────────────────────────────────────────────────────────────────────────────
-- * NULL stays refused: the column is NOT NULL (unchanged), so the CHECK's own NULL pass is never reached. The rebuilt CHECK
--   is still written NULL-safe in intent (`kind IN (...)` on a NOT NULL column); no `IS NULL OR` arm is added, on purpose.
-- * The constraint keeps its live name.
-- * No row is touched: every existing value is a member of the widened set, so there is nothing to backfill, and the RLS
--   zero-row trap has nothing to bite (no DML at all).
-- * No column, index, policy or default changes. The other CHECKs on the table (state, failure_reason, live ⇒ verified,
--   the poll outcomes) already hold for a promote row as written: a promote is `rebuilding` → `live` | `unverified`, or
--   `failed` with a typed reason, exactly like a staging build.
--
-- ── ASSERT, DON'T ASSUME ────────────────────────────────────────────────────────────────────────────
-- Before the change: exactly ONE kind CHECK exists, and it admits 'publish' and 'rebuild' (a live CHECK that has drifted away
-- from what the code needs is refused, loudly, rather than widened). After: exactly one exists, every value the old one held
-- is still in it, and 'promote' is. Any failure raises and the whole migration rolls back (migrate.ts runs each file in one
-- transaction). Re-running is a no-op: a definition that already admits 'promote' is left alone.
DO $$
DECLARE
  n_found    integer;
  cname      text;
  old_def    text;
  old_vals   text[] := ARRAY[]::text[];
  known      text[] := ARRAY['publish', 'rebuild'];
  lit        text;
  missing    text;
  final_set  text[];
  value_list text;
  new_def    text;
  v          text;
BEGIN
  -- The kind CHECK is located by its definition, not by a name that may have changed. "kind" appears in no other CHECK on
  -- this table (state, failure_reason, verified_at, dispatched_at, poll_count), and the count below proves it.
  SELECT count(*) INTO n_found
    FROM pg_constraint
   WHERE conrelid = 'webdev_site_builds'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ~* '\mkind\M';

  IF n_found <> 1 THEN
    RAISE EXCEPTION 'M6-P6h: expected exactly ONE kind CHECK on webdev_site_builds, found % — refusing to guess', n_found;
  END IF;

  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, old_def
    FROM pg_constraint
   WHERE conrelid = 'webdev_site_builds'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ~* '\mkind\M';

  -- Already widened (a re-run, or a database that took this change another way): nothing to do.
  IF position('''promote''' IN old_def) > 0 THEN
    RAISE NOTICE 'M6-P6h: % already admits promote — nothing to do', cname;
    RETURN;
  END IF;

  -- Every single-quoted literal the live definition holds. Robust to either rendering Postgres picks
  -- (`IN ('a','b')` or `= ANY (ARRAY['a'::text, 'b'::text])`): both quote each value the same way.
  FOR lit IN SELECT (regexp_matches(old_def, '''([^'']*)''', 'g'))[1] LOOP
    old_vals := array_append(old_vals, lit);
  END LOOP;

  IF array_length(old_vals, 1) IS NULL THEN
    RAISE EXCEPTION 'M6-P6h: parsed zero literals out of the live kind CHECK (%) — refusing to proceed', old_def;
  END IF;

  SELECT string_agg(x, ', ') INTO missing FROM unnest(known) AS x WHERE NOT (x = ANY (old_vals));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'M6-P6h: the live kind CHECK (%) no longer admits % — it has drifted from what the code expects; refusing to rebuild it', old_def, missing;
  END IF;

  SELECT array_agg(DISTINCT x ORDER BY x) INTO final_set FROM unnest(old_vals || ARRAY['promote']) AS x;
  SELECT string_agg(quote_literal(x), ', ' ORDER BY x) INTO value_list FROM unnest(final_set) AS x;

  EXECUTE format('ALTER TABLE webdev_site_builds DROP CONSTRAINT %I', cname);
  EXECUTE format('ALTER TABLE webdev_site_builds ADD CONSTRAINT %I CHECK (kind IN (%s))', cname, value_list);

  -- Assert on what the database now holds, not on what this block meant to write.
  SELECT count(*) INTO n_found
    FROM pg_constraint
   WHERE conrelid = 'webdev_site_builds'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ~* '\mkind\M';
  IF n_found <> 1 THEN
    RAISE EXCEPTION 'M6-P6h: expected ONE kind CHECK after the rebuild, found %', n_found;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO new_def
    FROM pg_constraint
   WHERE conrelid = 'webdev_site_builds'::regclass AND contype = 'c' AND conname = cname;
  IF new_def IS NULL THEN
    RAISE EXCEPTION 'M6-P6h: constraint % missing after the rebuild', cname;
  END IF;

  FOREACH v IN ARRAY old_vals LOOP
    IF position(quote_literal(v) IN new_def) = 0 THEN
      RAISE EXCEPTION 'M6-P6h: value % was in the old kind CHECK and is missing from the new one (%)', v, new_def;
    END IF;
  END LOOP;
  IF position('''promote''' IN new_def) = 0 THEN
    RAISE EXCEPTION 'M6-P6h: promote is missing from the rebuilt kind CHECK (%)', new_def;
  END IF;

  RAISE NOTICE 'M6-P6h: webdev_site_builds kind CHECK rebuilt from the live definition (% earlier value(s)) + promote', array_length(old_vals, 1);
END $$;

COMMENT ON COLUMN webdev_site_builds.kind IS
  'publish | rebuild (WSK-60: a STAGING build, after a publish or a content.rebuild approval) | promote (M6-P6h: a PRODUCTION '
  'deploy after an approved site.promote, HIGH and never self-approvable). One row per approval (ux_wsb_tenant_approval).';

COMMENT ON COLUMN webdev_site_builds.staging_url IS
  'The base URL the build stamp is read under (<base>/webdesk-build.json). For publish and rebuild it is the STAGING site''s '
  'origin (what the editor''s build-status shows as stagingUrl). For promote (M6-P6h) it is the PRODUCTION site''s, and for a '
  'wp site the base includes /wp-content/themes/<theme>, where the template writes its stamp. The column name predates promote.';
