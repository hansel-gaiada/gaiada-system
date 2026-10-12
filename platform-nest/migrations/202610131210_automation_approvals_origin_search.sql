-- 202610131210_automation_approvals_origin_search.sql
--
-- M5-P2: admit `search` as an `automation_approvals.origin`.
--
-- ── WHY ────────────────────────────────────────────────────────────────────────────────────────
-- The search module files an approval per ad-platform conversion upload (origin `search`, workflow_id
-- `search.conversions.upload`, impact high; design docs/plans/2026-10-11-m5-lead-pipeline-design.md §8.6). It executes
-- IN-BAND at decide(), as the decider, the shape probe consent (2026-09-03), GH-12 and WSK-66 use. The probe-consent flow
-- already files `origin = 'search'`; the CHECK as left by 202610101500 lists automation, agent, hr, iam, github,
-- credential_reveal and webdesk, and NOT `search`. This migration adds it, so both flows can be filed.
--
-- ── HOW THE CHECK IS REBUILT: THE 202610101500 IDIOM, VERBATIM IN SPIRIT ────────────────────────
-- The values are read from the constraint's CURRENT definition (`pg_get_constraintdef()`) and `search` is unioned in.
-- The list is NEVER retyped here: a DROP + ADD that re-declared a shared CHECK from one migration's beliefs once silently
-- deleted a value on LIVE (see 202609040505's header). Reading the catalog cannot make that mistake. `pg_constraint`
-- carries no RLS, so the self-checks below fire under the non-superuser migrator.
--
-- Purely additive. No DML. No other constraint touched. Every prior value survives by construction (and the self-check
-- proves it). Re-runnable: unioning a value already present is a no-op on the value set.

DO $$
DECLARE
  cname      text;
  live_def   text;
  lit        text;
  values_in  text[] := ARRAY[]::text[];
  new_vals   text[] := ARRAY['search'];
  final_set  text[];
  value_list text;
  missing    text;
  n_found    int;
BEGIN
  -- Locate the origin CHECK by its current definition text, not by a name that may have changed. 'automation' appears only
  -- in the origin allow-list on this table. Refuse if that heuristic is ever ambiguous.
  SELECT count(*) INTO n_found
    FROM pg_constraint
   WHERE conrelid = 'automation_approvals'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%origin%'
     AND pg_get_constraintdef(oid) ILIKE '%automation%';
  IF n_found <> 1 THEN
    RAISE EXCEPTION
      'M5-P2: expected exactly ONE origin CHECK on automation_approvals, found % - refusing to guess '
      'which one to widen. Inspect pg_constraint for this table before re-running.', n_found;
  END IF;

  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, live_def
    FROM pg_constraint
   WHERE conrelid = 'automation_approvals'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%origin%'
     AND pg_get_constraintdef(oid) ILIKE '%automation%';

  -- Every single-quoted literal in the live definition. Robust to either rendering Postgres may choose
  -- (`IN ('a','b')` or `= ANY (ARRAY['a'::text,'b'::text])`).
  FOR lit IN SELECT (regexp_matches(live_def, '''([^'']*)''', 'g'))[1] LOOP
    values_in := array_append(values_in, lit);
  END LOOP;

  IF array_length(values_in, 1) IS NULL THEN
    RAISE EXCEPTION
      'M5-P2: read the origin CHECK (%) but extracted zero values from its definition: % - '
      'refusing to replace a constraint whose contents could not be parsed.', cname, live_def;
  END IF;

  SELECT array_agg(DISTINCT v ORDER BY v)
    INTO final_set
    FROM unnest(values_in || new_vals) AS v;

  SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO value_list FROM unnest(final_set) AS v;

  EXECUTE format('ALTER TABLE automation_approvals DROP CONSTRAINT %I', cname);
  EXECUTE format(
    'ALTER TABLE automation_approvals ADD CONSTRAINT %I CHECK (origin IN (%s))', cname, value_list);

  RAISE NOTICE 'M5-P2: automation_approvals.origin now admits %', value_list;

  -- Self-check against the RE-READ catalog: every value that was there before, plus 'search'.
  SELECT pg_get_constraintdef(oid) INTO live_def
    FROM pg_constraint WHERE conrelid = 'automation_approvals'::regclass AND conname = cname;

  SELECT string_agg(v, ', ') INTO missing
    FROM unnest(final_set) AS v
   WHERE position(quote_literal(v) IN live_def) = 0;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'M5-P2: rebuilt origin CHECK is missing value(s) % - definition is now: %', missing, live_def;
  END IF;
END $$;

-- Append to the column comment (never overwrite what earlier migrations said).
DO $$
DECLARE cur text;
BEGIN
  SELECT col_description('automation_approvals'::regclass,
           (SELECT attnum FROM pg_attribute WHERE attrelid = 'automation_approvals'::regclass AND attname = 'origin'))
    INTO cur;
  IF cur IS NULL OR position('M5-P2' IN cur) = 0 THEN
    EXECUTE format('COMMENT ON COLUMN automation_approvals.origin IS %L',
      coalesce(cur, 'Which subsystem filed this approval.') ||
      ' `search` is the search module: a probe-consent request (2026-09-03) or an ad-platform conversion upload (M5-P2, '
      'workflow search.conversions.upload), each approved by a human and executed in-band at decide().');
  END IF;
END $$;
