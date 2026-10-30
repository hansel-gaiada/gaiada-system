-- 202610301201_social_settings_onboarding.sql — SCP-5h / W5-C3: the company's client-onboarding template on social_settings.
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §63.29.2 ("<prefix+6>_social_settings_onboarding.sql"). Plan:
-- docs/plans/2026-10-15-social-content-pipeline.md §7 row W5-C3; owner rulings SCP-Q35, SCP-Q36 and SCP-Q41.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────────────────────────────
--   social_settings.onboarding_template_id   uuid NULL → pm_templates (id). NULL is "no template chosen" (the default for every
--                                            company, and the state `PUT settings` with `onboardingTemplateId: null` returns
--                                            to). The FK is SINGLE-COLUMN, as the contract says: the route (W5-C4) checks the
--                                            template is a live `project` template of the same company before it writes, since
--                                            a single-column FK can prove neither the company nor the kind. pm_templates is
--                                            soft-deleted only, so the FK never blocks a delete; a soft-deleted template reads
--                                            as "not set" at the route.
--
-- social_settings keeps its own wall (202610271000); nothing here touches a policy. A referential check is not filtered by row
-- security, so the module-walled settings row may reference the core-walled pm_templates row.
--
-- ── NO DML ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- A nullable column with no default: existing rows read NULL with no rewrite and no row is read or written (the 0050 trap
-- cannot bite). The closing DO block asserts the catalogue, never a row count.
--
-- ── RE-RUNNABLE ───────────────────────────────────────────────────────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD. Applies on its own with plain `psql -f` and again without error.
--
-- ── ROLLOUT ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Additive, metadata-only (no default, so no table rewrite); the FK validates against a column that is NULL everywhere.
-- Lands after 202610301200 (filename order), which this file does not depend on beyond pm_templates itself (0041).

ALTER TABLE social_settings
  ADD COLUMN IF NOT EXISTS onboarding_template_id uuid;

ALTER TABLE social_settings
  DROP CONSTRAINT IF EXISTS fk_social_settings_onboarding_template,
  ADD CONSTRAINT fk_social_settings_onboarding_template FOREIGN KEY (onboarding_template_id) REFERENCES pm_templates (id);

COMMENT ON COLUMN social_settings.onboarding_template_id IS
  'SCP-5h (BFF §63.29.2): the company''s client-onboarding PM project template, or NULL for none. Single-column FK: the route '
  'checks it is a live project template of the same company.';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_settings' AND column_name = 'onboarding_template_id'
     AND data_type = 'uuid' AND is_nullable = 'YES' AND column_default IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301201: social_settings.onboarding_template_id must be uuid NULL with no default';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint pc
   WHERE pc.conrelid = to_regclass('social_settings') AND pc.conname = 'fk_social_settings_onboarding_template'
     AND pc.contype = 'f' AND pc.convalidated AND pc.confrelid = to_regclass('pm_templates')
     AND array_length(pc.conkey, 1) = 1;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301201: fk_social_settings_onboarding_template must be a validated single-column FK to pm_templates';
  END IF;

  -- The settings table keeps its wall.
  SELECT count(*) INTO n FROM pg_class WHERE oid = to_regclass('social_settings') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301201: social_settings must keep RLS ENABLED and FORCED';
  END IF;
END $$;
