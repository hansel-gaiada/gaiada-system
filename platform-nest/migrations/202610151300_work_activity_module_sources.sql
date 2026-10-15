-- 202610151300_work_activity_module_sources.sql — DW-4h-1 (docs/FRONTEND-BFF-CONTRACT.md §44.1): the activity series counts all work.
-- The audit-log bridge writes work_activity rows for every module's human actions, so the `source` CHECK widens from
-- pm, pipeline, github, google_drive, claude, manual, system to also accept webdesk, social, seo, creatives, finance, hr,
-- learning, time and checkins. Meetings need no source of their own: the outbox consumer's `system` / `meeting_recording` rows are the meetings kind. No data changes: every existing row already satisfies the wider set.
--
-- The CHECK was created inline and unnamed in 0030, so Postgres named it work_activity_source_check. This looks the real
-- name up in pg_constraint anyway (a database that was ever hand-edited keeps working), drops whatever CHECK constrains
-- `source`, then adds the named one. Idempotent: a re-run lands on the same constraint.

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'work_activity'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%source = ANY%'
  LOOP
    EXECUTE format('ALTER TABLE work_activity DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE work_activity DROP CONSTRAINT IF EXISTS work_activity_source_check;
ALTER TABLE work_activity ADD CONSTRAINT work_activity_source_check
  CHECK (source IN (
    'pm', 'pipeline', 'github', 'google_drive', 'claude', 'manual', 'system',
    'webdesk', 'social', 'seo', 'creatives', 'finance', 'hr', 'learning', 'time', 'checkins'
  ));

DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'work_activity'::regclass AND conname = 'work_activity_source_check';
  IF def IS NULL OR def NOT LIKE '%webdesk%' OR def NOT LIKE '%checkins%' OR def NOT LIKE '%google_drive%' THEN
    RAISE EXCEPTION '202610151300: work_activity_source_check must allow the module sources, found %', def;
  END IF;
END $$;
