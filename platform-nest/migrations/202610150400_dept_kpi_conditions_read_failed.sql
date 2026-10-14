-- 202610150400_dept_kpi_conditions_read_failed.sql — DW-6n0 (docs/FRONTEND-BFF-CONTRACT.md §40.5.1): a department KPI whose module
-- reader throws reads `unavailable` with the new reason `read_failed`. The §43 watch stores every KPI's reason in
-- dept_kpi_conditions.reason (202610150200_dept_kpi_watch.sql), whose CHECK knows only no_reader / no_data / no_target, so the
-- watch's upsert would fail on the first failed reader. This widens the CHECK to add 'read_failed'. No data changes: every
-- existing row already satisfies the wider set.
--
-- The CHECK was created inline and unnamed, so Postgres named it dept_kpi_conditions_reason_check. Idempotent: DROP ... IF EXISTS
-- then ADD, so a re-run lands on the same constraint.

ALTER TABLE dept_kpi_conditions DROP CONSTRAINT IF EXISTS dept_kpi_conditions_reason_check;
ALTER TABLE dept_kpi_conditions ADD CONSTRAINT dept_kpi_conditions_reason_check
  CHECK (reason IS NULL OR reason IN ('no_reader', 'no_data', 'no_target', 'read_failed'));

DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'dept_kpi_conditions'::regclass AND conname = 'dept_kpi_conditions_reason_check';
  IF def IS NULL OR def NOT LIKE '%read_failed%' THEN
    RAISE EXCEPTION '202610150400: dept_kpi_conditions_reason_check must allow read_failed, found %', def;
  END IF;
END $$;
