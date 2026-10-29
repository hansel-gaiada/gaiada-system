-- 202610291300_social_reports_monthly.sql — SCP-5a: the monthly report's notes, action plan and SIMULATED mark.
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §63.1 file 9 ("<prefix+8>_social_reports_monthly.sql") and §63.18; plan
-- docs/plans/2026-10-15-social-content-pipeline.md (SCP-Q5, SCP-Q20, SCP-Q22). The routes are social-reports.controller.ts.
--
-- ── WHAT THIS ADDS (on the existing `social_reports`, 0105; the third wall unchanged) ─────────────────────
--   notes        jsonb NOT NULL DEFAULT '{}', CHECK (jsonb_typeof(notes) = 'object'). One insight and one suggestion per
--                area: keys `followers`, `engagement`, `audience`, each `{insight <= 500, suggestion <= 500}`. The keys and
--                the lengths are the route's (`report-notes.ts`, 400 `{field: 'notes'}`); the column only refuses a
--                non-object, so an old row (the default `{}`) reads as "no notes yet", never as an error.
--   action_plan  jsonb NOT NULL DEFAULT '[]', CHECK (jsonb_typeof(action_plan) = 'array'). At most 10
--                `{action <= 300, owner: 'agency'|'client', due?: 'YYYY-MM-DD'}`, validated by the route (400
--                `{field: 'actionPlan'}`).
--   simulated    boolean NOT NULL DEFAULT false. TRUE when the frozen numbers include a simulated row (a simulated post,
--                variant, metric row or boost, counted only while the simulator switch is on, as `GET overview` counts
--                them), so the page and the PDF carry the SIMULATED watermark (plan §5). Written once, at create.
--
-- Both CHECKs are NOT NULL columns, so a CHECK can never pass on a NULL here: the column refuses NULL itself.
--
-- ── NO DML ────────────────────────────────────────────────────────────────────────────────────────────────
-- Three columns with constant defaults: Postgres records the default in the catalogue and rewrites no row, so no
-- existing row's stored values change (an old row reads `{}`, `[]` and false). No row is read or written, so the RLS
-- zero-row trap (an unset tenant GUC reads zero rows of a FORCE-RLS table) cannot bite. The closing DO block asserts the
-- catalogue, never a row count.
--
-- ── RE-RUNNABLE ───────────────────────────────────────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD. Applies on its own with plain `psql -f` (CI's sync-engine-go
-- job applies every migration that way, with no ledger) and again without error. `social_reports` is not in the
-- sync-engine's write-back registry, so nothing here reaches a replica.
--
-- ── ROLLOUT ───────────────────────────────────────────────────────────────────────────────────────────────
-- Additive. Runs on boot; the ALTER takes a brief ACCESS EXCLUSIVE lock on a small table and validates two CHECKs over
-- its rows (all of which hold the defaults). No deploy-order constraint: the old code never reads the new columns.

ALTER TABLE social_reports
  ADD COLUMN IF NOT EXISTS notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS action_plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false;

ALTER TABLE social_reports
  DROP CONSTRAINT IF EXISTS social_reports_notes_ck,
  ADD CONSTRAINT social_reports_notes_ck CHECK (jsonb_typeof(notes) = 'object'),
  DROP CONSTRAINT IF EXISTS social_reports_action_plan_ck,
  ADD CONSTRAINT social_reports_action_plan_ck CHECK (jsonb_typeof(action_plan) = 'array');

-- Assert what this file made: the three columns with their types, nullability and defaults, the two CHECKs with their exact
-- expressions, and the wall left in place.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_reports' AND is_nullable = 'NO'
     AND ((column_name = 'notes' AND data_type = 'jsonb' AND column_default LIKE '''{}''::jsonb%')
       OR (column_name = 'action_plan' AND data_type = 'jsonb' AND column_default LIKE '''[]''::jsonb%')
       OR (column_name = 'simulated' AND data_type = 'boolean' AND column_default = 'false'));
  IF n <> 3 THEN
    RAISE EXCEPTION '202610291300: social_reports needs notes jsonb NOT NULL DEFAULT ''{}'', action_plan jsonb NOT NULL DEFAULT ''[]'' and simulated boolean NOT NULL DEFAULT false, found % of 3 right', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = to_regclass('social_reports') AND contype = 'c'
     AND ((conname = 'social_reports_notes_ck' AND pg_get_constraintdef(oid) = 'CHECK ((jsonb_typeof(notes) = ''object''::text))')
       OR (conname = 'social_reports_action_plan_ck' AND pg_get_constraintdef(oid) = 'CHECK ((jsonb_typeof(action_plan) = ''array''::text))'));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610291300: expected social_reports_notes_ck and social_reports_action_plan_ck with their exact expressions, found % of 2', n;
  END IF;

  -- The wall is untouched: social_reports still has RLS enabled and forced, and its policy still carries the module wall.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('social_reports') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610291300: social_reports must keep RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND tablename = 'social_reports' AND qual LIKE '%app_module_allowed%';
  IF n < 1 THEN
    RAISE EXCEPTION '202610291300: social_reports must keep its module wall (app_module_allowed) policy';
  END IF;
END $$;
