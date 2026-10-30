-- AIP-18 (docs/plans/2026-10-27-ai-plan.md §6.3 item 9; rulings AIP-D8, AIP-D9; docs/FRONTEND-BFF-CONTRACT.md §66.11) -- a hand-off made
-- while its owner is soft-stopped starts no agent run: it is stored with the new status `held`, no goal id yet, and why. It starts (the goal is
-- posted and its id stored) when the owner is no longer stopped, or its owner cancels it.
--
-- WHAT THIS CHANGES ON assistant_handoffs (0084)
--   status             the CHECK gains `held`. It is REDECLARED WHOLE: 0084 declared it inline (so Postgres named it
--                      `assistant_handoffs_status_check`) and NO later migration touched it (`git log -S assistant_handoffs -- migrations`:
--                      0084 creates the table, 0085 only references it). The live list is therefore exactly 0084's eight values, every one
--                      of them carried forward here, plus `held`:
--                        queued, running, ok, suspended, budget_exhausted, failed, interrupted, cancelled, held
--                      (the DROP+ADD-on-a-shared-CHECK trap: a redeclared list drops whatever its author forgot; the self-check below asserts
--                      every value is in the new definition rather than trusting the ALTER).
--   goal_id            NOT NULL is dropped: a held hand-off has no goal at the runner yet. ck_assistant_handoffs_goal_id keeps the old rule for
--                      every row that was never held: a goal id is missing ONLY on a row that was held (hold_kind set) and is still held, was
--                      cancelled while held, or failed to start (the runner refused it or the agent left the roster).
--   hold_kind          'allowance' | 'department': why it was held. Kept after it starts (a record of the wait).
--   hold_unit_node_id  the stopped unit, for a 'department' hold only (an org node id, 1 to 120 characters like every other node label).
--   held_at            when it was held.
--   ix_assistant_handoffs_held  the release job's scan: the held rows of one company, oldest first.
--
-- A CHECK PASSES ON NULL: ck_assistant_handoffs_hold_shape is one CHECK with one branch per shape, each branch written so a NULL in it makes the
-- branch false (never NULL), so a half-filled hold is refused. `status` is NOT NULL, so ck_assistant_handoffs_held_has_hold cannot pass on NULL.
--
-- RLS is unchanged (0084's composed tenant_isolation policy, mod = 'assistant'). No DML anywhere in this file: existing rows already satisfy
-- every new CHECK (hold_kind NULL, goal_id NOT NULL), and the self-check reads the catalogue only. Applies twice without error.
--
-- To undo (only once no row is held or lacks a goal id): DROP INDEX ix_assistant_handoffs_held; ALTER TABLE assistant_handoffs DROP CONSTRAINT
-- ck_assistant_handoffs_goal_id, DROP CONSTRAINT ck_assistant_handoffs_held_has_hold, DROP CONSTRAINT ck_assistant_handoffs_hold_shape,
-- DROP COLUMN held_at, DROP COLUMN hold_unit_node_id, DROP COLUMN hold_kind, ALTER COLUMN goal_id SET NOT NULL; then put 0084's eight-value
-- status CHECK back.

DO $$
BEGIN
  IF to_regclass('assistant_handoffs') IS NULL THEN
    RAISE EXCEPTION '202610301420: assistant_handoffs is missing (0084)';
  END IF;
END $$;

ALTER TABLE assistant_handoffs ADD COLUMN IF NOT EXISTS hold_kind text;
ALTER TABLE assistant_handoffs ADD COLUMN IF NOT EXISTS hold_unit_node_id text;
ALTER TABLE assistant_handoffs ADD COLUMN IF NOT EXISTS held_at timestamptz;
ALTER TABLE assistant_handoffs ALTER COLUMN goal_id DROP NOT NULL;

-- The status CHECK, redeclared whole: 0084's eight values, every one kept, plus 'held'.
ALTER TABLE assistant_handoffs
  DROP CONSTRAINT IF EXISTS assistant_handoffs_status_check,
  DROP CONSTRAINT IF EXISTS ck_assistant_handoffs_status,
  ADD CONSTRAINT ck_assistant_handoffs_status CHECK (
    status IN ('queued', 'running', 'ok', 'suspended', 'budget_exhausted', 'failed', 'interrupted', 'cancelled', 'held')
  );

ALTER TABLE assistant_handoffs
  DROP CONSTRAINT IF EXISTS ck_assistant_handoffs_hold_shape,
  ADD CONSTRAINT ck_assistant_handoffs_hold_shape CHECK (
    (hold_kind IS NULL AND hold_unit_node_id IS NULL AND held_at IS NULL)
    OR (hold_kind IS NOT NULL AND hold_kind = 'allowance' AND hold_unit_node_id IS NULL AND held_at IS NOT NULL)
    OR (hold_kind IS NOT NULL AND hold_kind = 'department' AND hold_unit_node_id IS NOT NULL
        AND length(hold_unit_node_id) BETWEEN 1 AND 120 AND held_at IS NOT NULL)
  );

ALTER TABLE assistant_handoffs
  DROP CONSTRAINT IF EXISTS ck_assistant_handoffs_held_has_hold,
  ADD CONSTRAINT ck_assistant_handoffs_held_has_hold CHECK (status <> 'held' OR hold_kind IS NOT NULL);

ALTER TABLE assistant_handoffs
  DROP CONSTRAINT IF EXISTS ck_assistant_handoffs_goal_id,
  ADD CONSTRAINT ck_assistant_handoffs_goal_id CHECK (
    goal_id IS NOT NULL OR (hold_kind IS NOT NULL AND status IN ('held', 'cancelled', 'failed'))
  );

CREATE INDEX IF NOT EXISTS ix_assistant_handoffs_held ON assistant_handoffs (tenant_id, created_at) WHERE status = 'held';

COMMENT ON COLUMN assistant_handoffs.hold_kind IS
  'AIP-18: why this hand-off was held while its owner was soft-stopped (allowance | department); kept after it starts. NULL: never held.';
COMMENT ON COLUMN assistant_handoffs.hold_unit_node_id IS 'AIP-18: the stopped unit (org node id), for a department hold only.';
COMMENT ON COLUMN assistant_handoffs.held_at IS 'AIP-18: when the hand-off was held.';

-- ══ self-check: catalogue reads only ═════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  def text;
  v text;
  n int;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'assistant_handoffs'::regclass AND conname = 'ck_assistant_handoffs_status' AND contype = 'c' AND convalidated;
  IF def IS NULL THEN
    RAISE EXCEPTION '202610301420: ck_assistant_handoffs_status is missing or not validated';
  END IF;
  FOREACH v IN ARRAY ARRAY['queued', 'running', 'ok', 'suspended', 'budget_exhausted', 'failed', 'interrupted', 'cancelled', 'held'] LOOP
    IF position(quote_literal(v) IN def) = 0 THEN
      RAISE EXCEPTION '202610301420: the status CHECK lost the value % (definition: %)', v, def;
    END IF;
  END LOOP;

  -- No second CHECK may still constrain the status list (0084's inline one must be gone, or `held` would be refused by it).
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'assistant_handoffs'::regclass AND contype = 'c'
     AND conname NOT IN ('ck_assistant_handoffs_status', 'ck_assistant_handoffs_held_has_hold', 'ck_assistant_handoffs_goal_id')
     AND pg_get_constraintdef(oid) LIKE '%status%';
  IF n <> 0 THEN
    RAISE EXCEPTION '202610301420: % other CHECK(s) on assistant_handoffs still constrain status', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'assistant_handoffs'::regclass AND contype = 'c' AND convalidated
     AND conname IN ('ck_assistant_handoffs_hold_shape', 'ck_assistant_handoffs_held_has_hold', 'ck_assistant_handoffs_goal_id');
  IF n <> 3 THEN
    RAISE EXCEPTION '202610301420: the three hold CHECKs must exist and be validated, found % of 3', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'assistant_handoffs' AND column_name = 'goal_id' AND is_nullable = 'YES';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301420: assistant_handoffs.goal_id must be nullable';
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema() AND tablename = 'assistant_handoffs' AND indexname = 'ix_assistant_handoffs_held'
     AND indexdef LIKE '%(tenant_id, created_at)%' AND indexdef LIKE '%status = ''held''%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301420: ix_assistant_handoffs_held is missing';
  END IF;

  SELECT count(*) INTO n FROM pg_class WHERE oid = 'assistant_handoffs'::regclass AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301420: assistant_handoffs must keep RLS ENABLED and FORCED';
  END IF;
END $$;
