-- 202610101500_automation_approvals_origin_webdesk.sql
--
-- WSK-66: admit `webdesk` as an `automation_approvals.origin`.
--
-- ── WHY ────────────────────────────────────────────────────────────────────────────────────────
-- WebDesk's HIGH editorial commands (`content.publish`, `content.schedule`) and `key.mint` run
-- through ONE WS4 approval that executes IN-BAND at decide() (design
-- docs/plans/2026-10-10-webdesk-write-plane-design.md §6 + §12 WSK-66; ruling WSK-D46). The filing
-- path (`src/modules/webdev/webdesk-approved-command.ts#fileWebdeskCommandApproval`) writes
-- `origin = 'webdesk'` with `workflow_id` = the command name, and decide() recognises the row by
-- BOTH (`isWebdeskApprovedCommandRequest`), the shape GH-12 (`github`) and VLT-3
-- (`credential_reveal`) established. Without this value every filing fails the CHECK.
--
-- ── HOW THE CHECK IS REBUILT: THE 202609040505 PATTERN, VERBATIM IN SPIRIT ──────────────────────
-- The values are read from the constraint's CURRENT definition (`pg_get_constraintdef()`) and
-- `webdesk` is unioned in. The list is NEVER retyped here: a DROP + ADD that re-declared a shared
-- CHECK from one migration's beliefs once silently deleted a value on LIVE (see 202609040505's
-- header and 202608311000's incident note). Reading the catalog cannot make that mistake, because
-- the base set comes from the database rather than from this file. `pg_constraint` carries no RLS,
-- so the self-checks below genuinely fire under the non-superuser migrator.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────────────────────────
-- Purely additive. No DML. No other constraint touched. Every existing row still satisfies the
-- widened CHECK, since every prior value survives by construction (and the self-check proves it).
-- Re-runnable: unioning a value already present is a no-op on the value set.

DO $$
DECLARE
  cname      text;
  live_def   text;
  lit        text;
  values_in  text[] := ARRAY[]::text[];
  new_vals   text[] := ARRAY['webdesk'];
  final_set  text[];
  value_list text;
  missing    text;
  n_found    int;
BEGIN
  -- Locate the origin CHECK by its current definition text, not by a name that may have changed.
  -- 'automation' appears only in the origin allow-list on this table (status/execution_status
  -- CHECKs never mention it). Refuse if that heuristic is ever ambiguous.
  SELECT count(*) INTO n_found
    FROM pg_constraint
   WHERE conrelid = 'automation_approvals'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%origin%'
     AND pg_get_constraintdef(oid) ILIKE '%automation%';
  IF n_found <> 1 THEN
    RAISE EXCEPTION
      'WSK-66: expected exactly ONE origin CHECK on automation_approvals, found % - refusing to guess '
      'which one to widen. Inspect pg_constraint for this table before re-running.', n_found;
  END IF;

  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, live_def
    FROM pg_constraint
   WHERE conrelid = 'automation_approvals'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%origin%'
     AND pg_get_constraintdef(oid) ILIKE '%automation%';

  -- Every single-quoted literal in the live definition. Robust to either rendering Postgres may
  -- choose (`IN ('a','b')` or `= ANY (ARRAY['a'::text,'b'::text])`).
  FOR lit IN SELECT (regexp_matches(live_def, '''([^'']*)''', 'g'))[1] LOOP
    values_in := array_append(values_in, lit);
  END LOOP;

  IF array_length(values_in, 1) IS NULL THEN
    RAISE EXCEPTION
      'WSK-66: read the origin CHECK (%) but extracted zero values from its definition: % - '
      'refusing to replace a constraint whose contents could not be parsed.', cname, live_def;
  END IF;

  SELECT array_agg(DISTINCT v ORDER BY v)
    INTO final_set
    FROM unnest(values_in || new_vals) AS v;

  SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO value_list FROM unnest(final_set) AS v;

  EXECUTE format('ALTER TABLE automation_approvals DROP CONSTRAINT %I', cname);
  EXECUTE format(
    'ALTER TABLE automation_approvals ADD CONSTRAINT %I CHECK (origin IN (%s))', cname, value_list);

  RAISE NOTICE 'WSK-66: automation_approvals.origin now admits %', value_list;

  -- Self-check against the RE-READ catalog: every value that was there before, plus 'webdesk'.
  SELECT pg_get_constraintdef(oid) INTO live_def
    FROM pg_constraint WHERE conrelid = 'automation_approvals'::regclass AND conname = cname;

  SELECT string_agg(v, ', ') INTO missing
    FROM unnest(final_set) AS v
   WHERE position(quote_literal(v) IN live_def) = 0;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'WSK-66: rebuilt origin CHECK is missing value(s) % - definition is now: %', missing, live_def;
  END IF;
END $$;

COMMENT ON COLUMN automation_approvals.origin IS
  'Which subsystem filed this approval. Widened additively, never re-declared from a hardcoded '
  'list - see 202609040505''s header for the incident that rule comes from. `webdesk` is WSK-66: a '
  'WebDesk HIGH command (content.publish / content.schedule / key.mint) approved by a human and '
  'executed in-band at decide() over the control channel with a WS4 assertion.';
