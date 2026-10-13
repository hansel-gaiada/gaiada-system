-- 202610140010_reports_period_kinds_quarter_semester_year.sql
-- DW-4a (docs/blueprints/tracker-reporting-foundation.md §15, "2026-10-13 (DW-4a, contract first)"):
-- `quarter`, `semester` and `year` become calendar report period kinds, so
-- `report_periods.period_kind` may hold the seven kinds
-- ('day','week','month','quarter','semester','year','custom').
--
-- 0067 declared `period_kind text NOT NULL CHECK (period_kind IN ('day','week','month','custom'))`
-- inline, so the constraint carries Postgres's auto-generated name. Nothing else changes:
-- `report_periods_calendar_uq` (0067) is a partial index on `period_kind <> 'custom'` and already
-- covers every non-custom kind, and `report_documents` has no kind column.
--
-- Widen-only. The constraint is found by its COLUMN SET, never by text (the 0083 lesson): a
-- text match on `period_kind` would also hit `report_periods_custom_needs_label`
-- (`CHECK (period_kind <> 'custom' OR label IS NOT NULL)`), whose column set is {label, period_kind}
-- and which must survive untouched. Only a constraint over exactly {period_kind} is dropped.
-- `DROP CONSTRAINT IF EXISTS` by the canonical name then covers a re-run and any name collision, so
-- running this twice is harmless.
DO $$
DECLARE cname text;
BEGIN
  FOR cname IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
     WHERE con.conrelid = 'report_periods'::regclass
       AND con.contype = 'c'
     GROUP BY con.conname
     -- `attname` is `name`, not `text`, so the cast is required — `name[] = text[]` has no operator.
    HAVING array_agg(att.attname::text ORDER BY att.attname::text) = ARRAY['period_kind']::text[]
  LOOP
    EXECUTE format('ALTER TABLE report_periods DROP CONSTRAINT %I', cname);
  END LOOP;
  -- Covers the re-run case and a name collision.
  ALTER TABLE report_periods DROP CONSTRAINT IF EXISTS report_periods_period_kind_check;

  ALTER TABLE report_periods
    ADD CONSTRAINT report_periods_period_kind_check
    CHECK (period_kind IN ('day','week','month','quarter','semester','year','custom'));
END $$;
