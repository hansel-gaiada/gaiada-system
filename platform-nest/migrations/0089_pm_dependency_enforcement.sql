-- P4-H1 / P4-I1-I3 (PM Repsona Parity Phase 4, workstreams H + I —
-- 2026-08-04-pm-repsona-parity-phase4-plan.md) — project time range + enforced chained tasks.
--
-- NUMBERING: `ls migrations | sort | tail` at implementation time showed the real head as
-- `0088_webdev_change_requests.sql` (a concurrent session's migration — `0087_pm_task_
-- assignment_events.sql`'s own header warned this ledger moves fast). `0089` was genuinely free.
--
-- ─────────────────────────── WHAT THIS ADDS ───────────────────────────
-- P4-H1 needs NO new column: the base `projects` row already has `start_date` (0001_core.sql) and
-- `due_date` — this migration's only job for H1 would have been a backfill, and there is none to
-- do (both columns already exist and are simply now SELECTed/PATCHed by pm.controller.ts). What
-- IS new here is entirely for workstream I:
--
--   1. `pm_tasks.block_reason` (text, nullable) — decision 17's system-vs-human distinguisher for
--      the Blocked status. NULL = SYSTEM-set (an open dependency; "which one" is served live off
--      `openDependencies()` at read time, never stored here — a stored blocker id would drift the
--      moment that blocker itself changes project). Non-null = HUMAN-set (a required, free-text
--      external-wait reason, e.g. "waiting on the client"). No CHECK enforcing "non-null only when
--      isBlocked" — `isBlocked` is a per-project, possibly-custom status FLAG (pm_project_statuses,
--      0038), not a fixed enum this table's own CHECK could see; the invariant is enforced
--      app-side (pm.controller.ts's `enforceStartGate`/explicit-transition handling), the same
--      trust boundary every other flag-driven PM rule in this module already relies on (is_done/
--      is_blocked themselves have no cross-table CHECK either).
--   2. `pm_project_meta.dependency_enforcement` (boolean, NOT NULL DEFAULT true) — decision 14's
--      per-project override. Hard-enforced by default; a project may explicitly turn it off. This
--      IS the "explicit, audited override" the decision calls for — audited for free because it is
--      written through `patchProject`'s existing "manage"-gated, event+activity-logged path, never
--      a second, separately-audited mechanism.
--
-- Both columns are ADDITIVE and NULLABLE-or-defaulted, so every existing row is valid the instant
-- this migration commits — no backfill DML is needed for either, and the migration-backfill-RLS
-- lint (`lint:migration-rls`) has nothing to flag here (a plain `ALTER TABLE ... ADD COLUMN ...
-- DEFAULT`/`ADD COLUMN` is metadata-only against existing rows, not a `SELECT`-driven backfill).
--
-- Enforcement (I1/I2/I3) itself is pure application logic in `pm.controller.ts`
-- (`openDependencies`, `enforceStartGate`, `clearedStatusIfReady`, `promoteClearedDependents`) —
-- there is no new DAG/"chain" table, per the plan's own recommendation: the existing `depends_on`
-- uuid[] (0018_pm.sql) IS the chain; a second overlapping model would need its own cycle guard.

ALTER TABLE pm_tasks ADD COLUMN block_reason text;
COMMENT ON COLUMN pm_tasks.block_reason IS
  'P4-I decision 17 — non-NULL only for a HUMAN-set Blocked (a required external-wait reason). '
  'NULL while the task''s status is isBlocked-flagged means SYSTEM-set (an open dependency); the '
  'blocker itself is never stored here, only computed live via openDependencies() on read.';

ALTER TABLE pm_project_meta ADD COLUMN dependency_enforcement boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN pm_project_meta.dependency_enforcement IS
  'P4-I3/decision 14 — true (default) = hard-enforced chained-task gate (I1); false = the '
  'project has explicitly opted out (an audited override via PATCH .../pm/projects/:id, never a '
  'silent "warn" mode — that option was rejected).';
