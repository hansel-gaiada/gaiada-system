-- PV7-02 (docs/FRONTEND-BFF-CONTRACT.md §54.4; plan docs/plans/2026-10-15-pv7-performance-views-tickets.md, finding 7):
-- WHEN A MILESTONE WAS COMPLETED.
--
--   pm_milestones carried a mutable `status` and a `due_date` and nothing else, so "done on time" could only
--   mean "done today, and due in the range": a milestone finished weeks late but still `done` read as a hit
--   (the known limitation written above computeMilestoneHitRate in src/modules/reports/report-rollups.ts).
--   This adds the missing instant.
--
-- ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────────
--   completed_at is set when a milestone's status ENTERS the done set and cleared when it LEAVES it.
--   The done set is the one computeMilestoneHitRate uses: `status = 'done'` (the column is free text, 0018).
--   If that set ever grows, change it here and in the rollup together (the trigger test pins both).
--     * INSERT, status = 'done'         completed_at = the row's own value if it names one, else now().
--     * INSERT, any other status        completed_at = NULL.
--     * UPDATE, status becomes 'done'   completed_at = now().
--     * UPDATE, status stays 'done'     untouched. Not re-stamped, so an unrelated edit never moves it, and an
--                                       old done row that has no completed_at (see below) stays NULL.
--     * UPDATE, status leaves 'done'    completed_at = NULL.
--   A trigger, not application code, because milestones are written from several places (the PM controller,
--   project clone, seeds, imports) and a rule that lives in only one of them is a rule that is missing from the rest.
--
-- ── NO BACK-FILL, AND WHY ────────────────────────────────────────────────────────────────────────────
--   Nothing in the table says when an already-done milestone was finished; updated_at moves on every edit, so using
--   it would fabricate a completion time. Existing done rows keep completed_at NULL. The client-health payload
--   therefore carries `onTimeKnownSince` (this migration's applied time): "done on time" is only judgeable from then on.
--
-- Pure DDL on a table that already has its tenant RLS (0018); the column adds no policy. New function name, so the
-- function-drift lint has nothing to compare it with.

ALTER TABLE pm_milestones ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE OR REPLACE FUNCTION pm_milestones_stamp_completed_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'done' THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
    ELSE
      NEW.completed_at := NULL;
    END IF;
  ELSIF NEW.status = 'done' THEN
    IF OLD.status IS DISTINCT FROM 'done' THEN
      NEW.completed_at := now();
    END IF;
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pm_milestones_stamp_completed_at ON pm_milestones;
CREATE TRIGGER trg_pm_milestones_stamp_completed_at
  BEFORE INSERT OR UPDATE ON pm_milestones
  FOR EACH ROW EXECUTE FUNCTION pm_milestones_stamp_completed_at();
