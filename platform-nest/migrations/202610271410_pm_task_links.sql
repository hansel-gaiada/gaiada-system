-- SCP-1n (docs/FRONTEND-BFF-CONTRACT.md §63.1 item 5, §63.13; plan §8 row 1n) -- a PM task can point at a social post, and
-- the content-month task of a cycle points at its cycle.
--
-- `pm_tasks` is a core table (0018_pm.sql): FORCE RLS on tenant_id, no module wall. Nothing here changes who can read a row. The
-- two columns only describe a row:
--
--   linked_type  NULL, or 'social_post' | 'social_cycle'.
--   linked_id    NULL, or the id of that row. The pair is all-or-nothing (a CHECK), so a type with no id, or an id with no
--                type, cannot exist.
--
-- NO FOREIGN KEY, on purpose: the linked row is a `social_*` row behind its own module wall (0105's third wall), and a core
-- table does not reference a walled one. The routes validate the post (it exists in the company); the pipeline owns the
-- cycle link.
--
--   One content-month task per cycle: a partial UNIQUE on (tenant_id, linked_id) for the 'social_cycle' kind among live
--   rows. A post may have any number of tasks pointing at it, so there is no such index for 'social_post'; its index is the
--   lookup the post read and the task drawer use.
--
-- No DML: no row is read or written, so the RLS zero-row trap (an unset tenant GUC reads zero rows of a FORCE-RLS table)
-- cannot bite. The closing DO block asserts the catalogue, never a row count.
--
-- Applies on its own with plain `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger) and
-- again without error: every statement is guarded.

ALTER TABLE pm_tasks
  ADD COLUMN IF NOT EXISTS linked_type text,
  ADD COLUMN IF NOT EXISTS linked_id uuid;

-- One ALTER per constraint group keeps the DROP and the ADD of a name together, so a re-run replaces and never stacks.
-- A CHECK passes on NULL, so each is written so that the NULL case is the one that is meant.
ALTER TABLE pm_tasks
  DROP CONSTRAINT IF EXISTS pm_tasks_linked_type_ck,
  ADD CONSTRAINT pm_tasks_linked_type_ck CHECK (linked_type IN ('social_post', 'social_cycle')),
  DROP CONSTRAINT IF EXISTS pm_tasks_linked_pair_ck,
  ADD CONSTRAINT pm_tasks_linked_pair_ck CHECK ((linked_type IS NULL) = (linked_id IS NULL));

-- One content-month task per cycle (live rows only: a deleted task does not hold the cycle).
CREATE UNIQUE INDEX IF NOT EXISTS ux_pm_tasks_social_cycle
  ON pm_tasks (tenant_id, linked_id)
  WHERE linked_type = 'social_cycle' AND deleted_at IS NULL;

-- The lookup: the tasks that point at one row (the post read's `tasks`, the drawer).
CREATE INDEX IF NOT EXISTS ix_pm_tasks_linked
  ON pm_tasks (tenant_id, linked_type, linked_id)
  WHERE linked_type IS NOT NULL AND deleted_at IS NULL;

-- Assert what this file made: the columns, the two CHECKs, the two indexes. Catalogue reads only.
DO $$
DECLARE
  n int;
  missing text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'pm_tasks' AND is_nullable = 'YES' AND column_default IS NULL
     AND ((column_name = 'linked_type' AND data_type = 'text') OR (column_name = 'linked_id' AND data_type = 'uuid'));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610271410: pm_tasks needs linked_type text NULL and linked_id uuid NULL, found % of 2 right', n;
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES ('pm_tasks_linked_type_ck'), ('pm_tasks_linked_pair_ck')) AS want(c)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass('pm_tasks') AND pc.conname = want.c AND pc.contype = 'c' AND pc.convalidated);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610271410: missing or unvalidated constraints on pm_tasks: %', missing;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema() AND tablename = 'pm_tasks'
     AND ((indexname = 'ux_pm_tasks_social_cycle' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%(tenant_id, linked_id)%'
           AND indexdef LIKE '%social_cycle%' AND indexdef LIKE '%deleted_at IS NULL%')
       OR (indexname = 'ix_pm_tasks_linked' AND indexdef NOT LIKE 'CREATE UNIQUE%' AND indexdef LIKE '%(tenant_id, linked_type, linked_id)%'
           AND indexdef LIKE '%linked_type IS NOT NULL%' AND indexdef LIKE '%deleted_at IS NULL%'));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610271410: ux_pm_tasks_social_cycle and ix_pm_tasks_linked must exist with their keys and predicates, found % of 2 right', n;
  END IF;

  -- The wall is untouched: pm_tasks still has RLS enabled and forced.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('pm_tasks') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271410: pm_tasks must keep RLS ENABLED and FORCED';
  END IF;
END $$;
