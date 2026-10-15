-- 202610151740_client_report_summary.sql
-- PV7-07 (docs/FRONTEND-BFF-CONTRACT.md §56; plan docs/plans/2026-10-15-pv7-performance-views-tickets.md, ticket PV7-07):
-- the monthly account summary lives in `client_reports` (migration 202610151720) as a row with source = 'account_summary'.
-- This file adds what such a row needs that a social or search report does not:
--   1. four columns: the frozen `snapshot` (jsonb), the editable `narrative_md`, who wrote it (`narrative_source`), and
--      when the snapshot was read (`generated_at`);
--   2. CHECKs: an account summary carries all four (and sits on one whole calendar month), any other source carries
--      none; one live summary per client and month;
--   3. a trigger: once a report leaves `draft`, its snapshot and narrative never change (frozen), as a conversation
--      message is permanent (202610132145, PV-D34, the precedent this guard follows).
--
-- ── NULL CANNOT SLIP THROUGH ─────────────────────────────────────────────────────────────────────────
-- A CHECK passes on NULL. `source` is NOT NULL, and every other conjunct below is an `IS [NOT] NULL` test or a comparison
-- on a NOT NULL column, so no arm can evaluate to NULL and let a half-filled summary through. `jsonb_typeof(snapshot)` is
-- only reached when `snapshot IS NOT NULL` has already held.
--
-- ── THE FREEZE TRIGGER ───────────────────────────────────────────────────────────────────────────────
-- BEFORE UPDATE, row level, refuses a change to snapshot / narrative_md / narrative_source / generated_at unless BOTH the
-- old and the new status are 'draft'. So the publish UPDATE (draft -> published) may not smuggle a changed narrative in
-- with it, and a published or withdrawn row is never rewritten. IS DISTINCT FROM, so a NULL-to-value change counts.
-- SQLSTATE 'PD056' (a custom class like PD034: it collides with no standard code and none the app maps). Created ENABLE
-- (origin), not ALWAYS, for the reason 202610132145 gives (a replication apply worker must be able to apply an upstream
-- row as it is). A superuser can disable it: the same trust boundary as every guard trigger in this schema.
--
-- ── EXISTING DATA ────────────────────────────────────────────────────────────────────────────────────
-- NO DML. No account summary can exist before this file (no route made one), so the new CHECKs validate every existing
-- row against the "any other source carries none" arm, which they satisfy (the columns are new and NULL).
--
-- ── ROLLOUT ──────────────────────────────────────────────────────────────────────────────────────────
-- Additive. Four nullable columns (no rewrite), two CHECKs and a partial unique index over a small table, one trigger.
-- Brief SHARE ROW EXCLUSIVE lock on client_reports. Ship with the PV7-07 code (before it nothing writes the columns).
-- Reverse (before any summary exists): DROP TRIGGER trg_client_reports_summary_frozen ON client_reports;
--   DROP FUNCTION client_reports_summary_frozen_guard(); DROP INDEX ux_client_reports_live_summary_period;
--   ALTER TABLE client_reports DROP CONSTRAINT client_reports_summary_content, DROP CONSTRAINT client_reports_summary_month,
--   DROP CONSTRAINT client_reports_narrative_source_check, DROP COLUMN snapshot, DROP COLUMN narrative_md,
--   DROP COLUMN narrative_source, DROP COLUMN generated_at.
-- No secrets; no company names or ids.

ALTER TABLE client_reports
  ADD COLUMN snapshot         jsonb,
  ADD COLUMN narrative_md     text,
  ADD COLUMN narrative_source text,
  ADD COLUMN generated_at     timestamptz;

ALTER TABLE client_reports
  ADD CONSTRAINT client_reports_narrative_source_check
    CHECK (narrative_source IS NULL OR narrative_source IN ('ai', 'human', 'deterministic'));

-- An account summary carries all four, a non-blank narrative and an object snapshot; every other source carries none.
ALTER TABLE client_reports
  ADD CONSTRAINT client_reports_summary_content CHECK (
    (source = 'account_summary'
       AND snapshot IS NOT NULL AND jsonb_typeof(snapshot) = 'object'
       AND narrative_md IS NOT NULL AND btrim(narrative_md) <> ''
       AND narrative_source IS NOT NULL
       AND generated_at IS NOT NULL)
    OR
    (source <> 'account_summary'
       AND snapshot IS NULL AND narrative_md IS NULL AND narrative_source IS NULL AND generated_at IS NULL)
  );

-- An account summary is for ONE whole calendar month: it starts on the 1st and ends on the last day of that month.
ALTER TABLE client_reports
  ADD CONSTRAINT client_reports_summary_month CHECK (
    source <> 'account_summary'
    OR (period_start = date_trunc('month', period_start::timestamp)::date
        AND period_end = (date_trunc('month', period_start::timestamp) + interval '1 month' - interval '1 day')::date)
  );

-- One live summary per client and month. A withdrawn one does not block a corrected re-draft. Partial on the source:
-- the social and search reports have their own per-source unique index (ux_client_reports_live_source).
CREATE UNIQUE INDEX ux_client_reports_live_summary_period
  ON client_reports (tenant_id, client_id, period_start)
  WHERE source = 'account_summary' AND status <> 'withdrawn';

CREATE FUNCTION client_reports_summary_frozen_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.status <> 'draft' OR NEW.status <> 'draft')
     AND (NEW.snapshot IS DISTINCT FROM OLD.snapshot
          OR NEW.narrative_md IS DISTINCT FROM OLD.narrative_md
          OR NEW.narrative_source IS DISTINCT FROM OLD.narrative_source
          OR NEW.generated_at IS DISTINCT FROM OLD.generated_at) THEN
    RAISE EXCEPTION 'a published account summary is frozen (PV7-07)'
      USING ERRCODE = 'PD056',
            HINT = 'Withdraw the report and draft a new one; the snapshot and narrative of a report that left draft never change.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_client_reports_summary_frozen
  BEFORE UPDATE ON client_reports
  FOR EACH ROW EXECUTE FUNCTION client_reports_summary_frozen_guard();

COMMENT ON COLUMN client_reports.snapshot IS
  'PV7-07: the frozen account-summary snapshot (BFF §56.1). NULL for every source but account_summary. Never changes once the report leaves draft.';
COMMENT ON COLUMN client_reports.narrative_md IS
  'PV7-07: the account summary''s narrative, Markdown. Editable while draft (narrative_source becomes human); frozen after.';
COMMENT ON FUNCTION client_reports_summary_frozen_guard() IS
  'PV7-07: refuses a change to snapshot / narrative_md / narrative_source / generated_at once a client report is not a draft. SQLSTATE PD056.';

-- ── self-assertion: the trigger exists, is a row-level BEFORE UPDATE trigger, and is enabled; both CHECKs and the index exist ──
-- pg_trigger.tgtype bits: 1 = ROW, 2 = BEFORE, 16 = UPDATE. tgenabled 'O' = enabled (origin).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'client_reports'::regclass AND tgname = 'trg_client_reports_summary_frozen'
                    AND NOT tgisinternal AND tgenabled = 'O' AND tgtype = 1 + 2 + 16
                    AND tgfoid = 'client_reports_summary_frozen_guard()'::regprocedure) THEN
    RAISE EXCEPTION '202610151740: trigger trg_client_reports_summary_frozen is missing, disabled or of the wrong kind';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'client_reports'::regclass
         AND conname IN ('client_reports_summary_content', 'client_reports_summary_month', 'client_reports_narrative_source_check')) <> 3 THEN
    RAISE EXCEPTION '202610151740: a client_reports CHECK is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'client_reports' AND indexname = 'ux_client_reports_live_summary_period') THEN
    RAISE EXCEPTION '202610151740: ux_client_reports_live_summary_period is missing';
  END IF;
END $$;
