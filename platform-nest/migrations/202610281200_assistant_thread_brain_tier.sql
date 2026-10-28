-- AIP-08a (docs/plans/2026-10-27-ai-plan.md, phase 2) -- a thread remembers the brain TIER its owner picked (Fast / Standard / Strong).
--
-- assistant_threads.brain_tier   text NULL. NULL means Auto: no tier is sent and the gateway uses the tier of the task. Otherwise one of
--                                'fast', 'standard', 'strong' (the gateway's closed tier vocabulary); every reply in the thread sends it to
--                                the AI gateway as `tier`. At the gateway a named provider beats a tier, and a tier beats the task's tier.
--
-- ONE PICKER, ONE CHOICE: a thread holds a tier or a named provider (brain_provider), never both. The second CHECK says so, so no code
-- path can store both. Every existing row has brain_tier NULL and passes.
--
-- No backfill, no DML. No grant change: the app role holds table-level privileges on assistant_threads (0079), so the new column is covered.
-- No RLS change: the policies are table-level. The closing DO block asserts the catalogue, never a row count (the unset-GUC zero-row trap).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; each constraint is dropped and re-added by fixed name.

ALTER TABLE assistant_threads ADD COLUMN IF NOT EXISTS brain_tier text;

ALTER TABLE assistant_threads DROP CONSTRAINT IF EXISTS assistant_threads_brain_tier_check;
ALTER TABLE assistant_threads
  ADD CONSTRAINT assistant_threads_brain_tier_check
  CHECK (brain_tier IS NULL OR brain_tier IN ('fast', 'standard', 'strong'));

ALTER TABLE assistant_threads DROP CONSTRAINT IF EXISTS assistant_threads_brain_one_choice_check;
ALTER TABLE assistant_threads
  ADD CONSTRAINT assistant_threads_brain_one_choice_check
  CHECK (brain_tier IS NULL OR brain_provider IS NULL);

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'assistant_threads'
     AND column_name = 'brain_tier' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610281200: assistant_threads needs brain_tier text NULL with no default';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = to_regclass('assistant_threads') AND contype = 'c'
     AND conname IN ('assistant_threads_brain_tier_check', 'assistant_threads_brain_one_choice_check');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610281200: assistant_threads needs both brain_tier CHECK constraints';
  END IF;
END
$$;
