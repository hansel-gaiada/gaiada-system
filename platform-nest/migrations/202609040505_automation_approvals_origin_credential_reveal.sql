-- 202609040505_automation_approvals_origin_credential_reveal.sql
--
-- VLT-3: admit `credential_reveal` as an `automation_approvals.origin`.
--
-- ── WHY THIS EXISTS, AND WHY IT WAS MISSED ─────────────────────────────────────────────────────
-- VLT-3 (the human credential-reveal path, `src/core/connection-reveal.ts`) files a WS4 approval
-- with `origin = 'credential_reveal'` and a dedicated workflow id, mirroring the shape
-- `isGithubRepoCreationRequest()` established: origin AND workflow_id must BOTH match before the
-- decide handler will execute anything.
--
-- The CHECK on that column admitted only ('automation','agent','hr','iam','github'), so every
-- filing failed with `violates check constraint "automation_approvals_origin_check"`. The failure
-- then CASCADED in a way worth recording, because the surface error named nothing useful: no
-- approval row was created, so the test's `approvalId` was `undefined`, so the next request went to
-- `/automation-approvals/undefined/decide` and Postgres rejected `"undefined"` as a uuid. Eight red
-- tests, one missing constraint value, and the loudest error in the log was about a uuid.
--
-- Root cause was a work-partitioning error, not a coding one: the reveal path's implementer was
-- scoped out of `migrations/` and handed a column contract that did not mention this value, so it
-- correctly stayed inside a boundary that was drawn wrong. Recorded here rather than quietly fixed,
-- because the lesson is about how the work was split.
--
-- ── HOW THE CHECK IS REBUILT — READ THIS BEFORE EDITING ────────────────────────────────────────
-- The values are read from the constraint's CURRENT definition via `pg_get_constraintdef()` and the
-- new value is unioned in. It is deliberately NOT retyped from a hardcoded list, even though the
-- previous migration on this very column (`202609010900_automation_approvals_origin_github.sql:49`)
-- did exactly that:
--
--     ADD CONSTRAINT automation_approvals_origin_check CHECK (origin IN ('automation','agent','hr','iam','github'));
--
-- That pattern is how this estate lost a value on LIVE once already: a DROP + ADD on a shared CHECK
-- re-declared the whole allow-list from one migration's understanding of history and silently
-- deleted a value a DIFFERENT migration had added in between (see
-- `202608311000_integration_connections_github_app_owner_kind.sql`'s header for the incident, and
-- `202608311400_...repair...sql` for the repair). Reading the live catalog cannot make that mistake,
-- because the base set comes from the database rather than from this file's beliefs.
--
-- Note the catalog is readable here even though `automation_approvals` may carry RLS: `pg_constraint`
-- and `pg_get_constraintdef()` read the SYSTEM CATALOG, which carries no row-level security at all.
-- That is why these self-checks genuinely fire, unlike a guard that SELECTs the table's own rows —
-- which, as the migration runner (`platform_owner`, `usesuper=false`, `bypassrls=false`) sets no
-- tenant GUC, would see zero rows and pass vacuously. Same distinction drawn in
-- `202609040149_search_properties_domain_key.sql` and the VLT-1 migration.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────────────────────────
-- Purely additive. No DML. No other constraint touched. Every existing row satisfies the widened
-- CHECK vacuously, since the prior values all survive by construction.

DO $$
DECLARE
  cname      text;
  live_def   text;
  lit        text;
  values_in  text[] := ARRAY[]::text[];
  new_vals   text[] := ARRAY['credential_reveal'];
  final_set  text[];
  value_list text;
  missing    text;
BEGIN
  -- Locate the origin CHECK by its current definition text rather than by a name that may have
  -- changed across migrations. 'automation' only ever appears in the origin allow-list on this
  -- table, which disambiguates it from the status/execution_status CHECKs.
  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, live_def
    FROM pg_constraint
   WHERE conrelid = 'automation_approvals'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%origin%'
     AND pg_get_constraintdef(oid) ILIKE '%automation%';

  IF cname IS NULL THEN
    RAISE EXCEPTION
      'VLT-3: could not locate the origin CHECK on automation_approvals - refusing to guess at its '
      'contents. Inspect pg_constraint for this table before re-running.';
  END IF;

  -- Every single-quoted literal in the live definition. Robust to either rendering Postgres may
  -- choose (`IN ('a','b')` or `= ANY (ARRAY['a'::text,'b'::text])`) since both quote values alike.
  FOR lit IN SELECT (regexp_matches(live_def, '''([^'']*)''', 'g'))[1] LOOP
    values_in := array_append(values_in, lit);
  END LOOP;

  IF array_length(values_in, 1) IS NULL THEN
    RAISE EXCEPTION
      'VLT-3: read the origin CHECK (%) but extracted zero values from its definition: % - '
      'refusing to replace a constraint whose contents could not be parsed.', cname, live_def;
  END IF;

  SELECT array_agg(DISTINCT v ORDER BY v)
    INTO final_set
    FROM unnest(values_in || new_vals) AS v;

  SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO value_list FROM unnest(final_set) AS v;

  EXECUTE format('ALTER TABLE automation_approvals DROP CONSTRAINT %I', cname);
  EXECUTE format(
    'ALTER TABLE automation_approvals ADD CONSTRAINT %I CHECK (origin IN (%s))', cname, value_list);

  RAISE NOTICE 'VLT-3: automation_approvals.origin now admits %', value_list;

  -- Self-check: every value we intended to keep or add must be present in the re-read definition.
  -- This guard reads the catalog, so it genuinely fires.
  SELECT pg_get_constraintdef(oid) INTO live_def
    FROM pg_constraint WHERE conrelid = 'automation_approvals'::regclass AND conname = cname;

  SELECT string_agg(v, ', ') INTO missing
    FROM unnest(final_set) AS v
   WHERE position(quote_literal(v) IN live_def) = 0;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'VLT-3: rebuilt origin CHECK is missing value(s) % - definition is now: %', missing, live_def;
  END IF;
END $$;

COMMENT ON COLUMN automation_approvals.origin IS
  'Which subsystem filed this approval. Widened additively, never re-declared from a hardcoded '
  'list - see 202609040505''s header for the incident that rule comes from. `credential_reveal` is '
  'VLT-3: a human asking to see a stored client hosting credential, which must be approved, is '
  'single-use, and is TTL-bound.';
