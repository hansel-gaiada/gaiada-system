-- P2-06 — Recurring tasks (pm-console-ux-design-spec.md §8, §0).
-- `recurrence` carries the per-task recurrence rule; a task that transitions
-- INTO an is_done status (P2-04 flag-driven, never a literal id) with a
-- recurrence set spawns the next occurrence server-side (pm.controller.ts).
--
-- `recurrence_spawned_from` links a spawned child back to its parent — used
-- as a defensive idempotency check (no second child for the same parent +
-- next-due-date pair) alongside the primary guard, which is the not-done→done
-- EDGE detected under a `SELECT ... FOR UPDATE` row lock in the same PATCH
-- transaction (serializes concurrent completions of the same task).
ALTER TABLE pm_tasks ADD COLUMN recurrence jsonb;              -- { freq, until? } | null
ALTER TABLE pm_tasks ADD COLUMN recurrence_spawned_from uuid REFERENCES pm_tasks(id);
CREATE INDEX pm_tasks_recurrence_spawned_from_idx ON pm_tasks (recurrence_spawned_from) WHERE recurrence_spawned_from IS NOT NULL;
