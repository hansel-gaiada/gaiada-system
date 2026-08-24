-- IAM — grant `member` the `pm.task.create` permission, matching the Cerbos rule split made in
-- `cerbos/policies/resource_pm_task.yaml` in the same change.
--
-- ── THIS IS AN AUTHORIZATION WIDENING, NOT A DRIFT-NEUTRAL BUNDLE FIX ────────────────────────────
-- Same shape as 0099 (company_admin/reports.appraisal.read): the mirror is being brought into line
-- with a NEW Cerbos rule, not with one it had always disagreed about.
--
-- WHY. `pm_task`'s `create` used to share a rule with `delete` and `manage`, so only the five
-- department leads holding `manager` could raise a PM task — 14 of 19 staff could not file work
-- against the board their own department runs on. The general `/tasks` surface let them create a
-- CORE task instead, which is a dead end: `core.controller.ts`'s endpoint accepts only
-- title + customFields, writes no assignee/status/due date, fires no notification, and has no PATCH
-- sibling at all, so the task could never be assigned, scheduled or updated afterwards.
--
-- ── DELIBERATELY ONE PERMISSION ──────────────────────────────────────────────────────────────────
-- `member` gains `pm.task.create` and NOTHING else. `pm.task.delete` and `pm.task.manage` remain
-- leads/admins in Cerbos and are not inserted here — `manage` is the load-bearing half: it gates
-- every ownership change on PATCH and every tracker-suggestion confirm. Verify with:
--   SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
--     JOIN permissions p ON p.id = rp.permission_id
--   WHERE r.company_id IS NULL AND r.name = 'member' AND p.key LIKE 'pm.task.%';
-- should return exactly three rows: pm.task.create, pm.task.read, pm.task.update.
--
-- ⚠ THE GRANT ALONE IS NOT THE WHOLE DECISION, and the other half lives in application code.
-- `createTask` authorizes `create` and then applies the request payload's `assignee` verbatim, so
-- this row on its own would also have meant "any employee may assign work to any colleague" — a
-- different decision from "any employee may raise a task", and not the one that was made. The
-- create handler now demands `manage` when the payload names a responsible other than the caller,
-- mirroring the ownership-change check the PATCH path in that same controller has always applied.
-- If that guard is ever removed, this grant silently becomes the wider one.
--
-- ── METHOD (identical idiom to 0094/0098/0099) ───────────────────────────────────────────────────
-- Insert by JOINing on `permissions.key` (0093's catalog — `pm.task.create` already exists there as
-- a `grantable` row; `manager`/`company_admin`/`owner`/`platform_admin` hold it) and `roles.name`
-- (0094 already seeds `member` as a global role). `ON CONFLICT DO NOTHING` keeps this re-runnable.
--
-- ── NO RLS CONCERN ───────────────────────────────────────────────────────────────────────────────
-- `roles`/`permissions`/`role_permissions` are global reference data with no RLS policy. The
-- "NOBYPASSRLS with an unset tenant GUC -> silently matches zero rows" trap does not apply
-- structurally; the row count is asserted below anyway, per this family's discipline.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('member', 'pm.task.create')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- Assert the join actually matched. A missing role or catalog key would otherwise make this
-- migration a silent no-op that leaves the mirror disagreeing with Cerbos — the exact failure the
-- alignment suite exists to catch, caught here instead of a day later.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id AND r.company_id IS NULL AND r.name = 'member'
  JOIN permissions p ON p.id = rp.permission_id AND p.key = 'pm.task.create';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected member -> pm.task.create to exist exactly once, found %', n;
  END IF;
END $$;
