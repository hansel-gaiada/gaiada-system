-- SCP-5f (docs/FRONTEND-BFF-CONTRACT.md §63.27.1; plan §4.5, SCP-D4, SCP-Q31) -- the monthly cycle's STEP TASKS: one PM task per
-- step and cycle (the report, planning, copy lock, artwork, client approval and scheduling, as the company's rules name them).
--
-- `pm_tasks` is a core table (0018_pm.sql): FORCE RLS on tenant_id, no module wall. Nothing here changes who can read a row. The
-- columns only describe a row:
--
--   linked_type  202610271410's column, widened: NULL, or 'social_post' | 'social_cycle' | 'social_cycle_step'.
--   linked_id    for 'social_cycle_step' the CYCLE (social_cycles.id), as for the content-month task. No foreign key, on purpose
--                (202610271410's header: a core table does not reference a walled one).
--   linked_step  NEW. The step key of the company's rules (`cycle.steps[].key`, BFF §63.30.1): set exactly when the type is
--                'social_cycle_step', NULL otherwise. The database cannot list the keys (each company sets its own), so it holds
--                their SHAPE only: '^[a-z][a-z0-9_]{0,39}$', the validator's own rule.
--
-- THE CHECKS, with their NULL cases written out (a CHECK passes on NULL, so each is written so that the NULL case is the one meant):
--   pm_tasks_linked_type_ck        (202610271410's, redeclared DROP and ADD in one ALTER) `linked_type IN (...)`: a NULL type passes,
--                                  which is the unlinked task every route writes. It is a single-column CHECK, so nothing else is
--                                  redeclared; pm_tasks_linked_pair_ck (type and id all or nothing) stays as it is.
--   pm_tasks_linked_step_ck        `(linked_type IS NOT DISTINCT FROM 'social_cycle_step') = (linked_step IS NOT NULL)`: both sides are
--                                  plain booleans, never NULL (IS NOT DISTINCT FROM answers false for a NULL type), so the check
--                                  is decided on every row: a step task without a step, and a step on any other row (another type,
--                                  or no type at all), are both refused.
--   pm_tasks_linked_step_value_ck  `linked_step IS NULL OR linked_step ~ '...'`: NULL is the no-step case the CHECK above already ruled
--                                  on; a present step must have the key's shape.
--
--   One task per step and cycle: a partial UNIQUE on (tenant_id, linked_id, linked_step) for the 'social_cycle_step' kind among live
--   rows. The content-month task's index (ux_pm_tasks_social_cycle, kind 'social_cycle') is untouched, and so is the lookup index
--   ix_pm_tasks_linked, which already covers every linked kind.
--
-- No social table changes: the steps are computed from the cycle, its posts, the allocation and the client's monthly report.
--
-- No DML: no row is read or written, so the RLS zero-row trap (an unset tenant GUC reads zero rows of a FORCE-RLS table) cannot bite,
-- and adding a NULL column with no default rewrites nothing. The closing DO block asserts the catalogue, never a row count.
--
-- Applies on its own with plain `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger) and again
-- without error: every statement is guarded.

ALTER TABLE pm_tasks
  ADD COLUMN IF NOT EXISTS linked_step text;

-- One ALTER per constraint group keeps the DROP and the ADD of a name together, so a re-run replaces and never stacks.
ALTER TABLE pm_tasks
  DROP CONSTRAINT IF EXISTS pm_tasks_linked_type_ck,
  ADD CONSTRAINT pm_tasks_linked_type_ck CHECK (linked_type IN ('social_post', 'social_cycle', 'social_cycle_step'));

ALTER TABLE pm_tasks
  DROP CONSTRAINT IF EXISTS pm_tasks_linked_step_ck,
  ADD CONSTRAINT pm_tasks_linked_step_ck CHECK ((linked_type IS NOT DISTINCT FROM 'social_cycle_step') = (linked_step IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS pm_tasks_linked_step_value_ck,
  ADD CONSTRAINT pm_tasks_linked_step_value_ck CHECK (linked_step IS NULL OR linked_step ~ '^[a-z][a-z0-9_]{0,39}$');

-- One task per step and cycle (live rows only: a deleted task does not hold its step).
CREATE UNIQUE INDEX IF NOT EXISTS ux_pm_tasks_social_cycle_step
  ON pm_tasks (tenant_id, linked_id, linked_step)
  WHERE linked_type = 'social_cycle_step' AND deleted_at IS NULL;

-- Assert what this file made: the column, the three CHECKs (with the widened type list), the index, the wall. Catalogue reads only.
DO $$
DECLARE
  n int;
  missing text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'pm_tasks' AND column_name = 'linked_step'
     AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301400: pm_tasks needs linked_step text NULL with no default';
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES ('pm_tasks_linked_type_ck'), ('pm_tasks_linked_pair_ck'), ('pm_tasks_linked_step_ck'), ('pm_tasks_linked_step_value_ck')) AS want(c)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass('pm_tasks') AND pc.conname = want.c AND pc.contype = 'c' AND pc.convalidated);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301400: missing or unvalidated constraints on pm_tasks: %', missing;
  END IF;

  -- The widened type CHECK admits all three kinds (the old two are still admitted).
  SELECT count(*) INTO n FROM pg_constraint pc
   WHERE pc.conrelid = to_regclass('pm_tasks') AND pc.conname = 'pm_tasks_linked_type_ck'
     AND pg_get_constraintdef(pc.oid) LIKE '%social_post%' AND pg_get_constraintdef(pc.oid) LIKE '%''social_cycle''%'
     AND pg_get_constraintdef(pc.oid) LIKE '%social_cycle_step%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301400: pm_tasks_linked_type_ck must admit social_post, social_cycle and social_cycle_step';
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema() AND tablename = 'pm_tasks'
     AND ((indexname = 'ux_pm_tasks_social_cycle_step' AND indexdef LIKE 'CREATE UNIQUE INDEX%'
           AND indexdef LIKE '%(tenant_id, linked_id, linked_step)%' AND indexdef LIKE '%social_cycle_step%' AND indexdef LIKE '%deleted_at IS NULL%')
       OR (indexname = 'ux_pm_tasks_social_cycle' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%(tenant_id, linked_id)%'
           AND indexdef LIKE '%''social_cycle''::text%' AND indexdef NOT LIKE '%social_cycle_step%'));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301400: ux_pm_tasks_social_cycle_step must exist with its key and predicate, and ux_pm_tasks_social_cycle must be untouched; found % of 2 right', n;
  END IF;

  -- The wall is untouched: pm_tasks still has RLS enabled and forced.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('pm_tasks') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301400: pm_tasks must keep RLS ENABLED and FORCED';
  END IF;
END $$;
