-- 0103 — HIER-3: retire `team_lead`, the `team`/`record` scope_type values, and the `teams` /
-- `team_memberships` tables (docs/superpowers/plans/2026-08-10-hierarchy-consolidation.md,
-- docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md §HIER-3, owner-locked 2026-08-10).
--
-- THIS IS THE CONTRACT HALF of the expand/contract migration 0100 started. 0100 (HIER-1) added
-- `org_unit` and widened `scope_id` to text, but — after its own first draft could not land
-- (three write paths still minted `scope_type='team'` grants) — was amended to EXPAND-ONLY: it
-- left `team`/`record` in both CHECK constraints and downgraded its own count-assert guards from
-- `RAISE EXCEPTION` to `RAISE NOTICE`, with an explicit instruction in its header: "HIER-3 must
-- restore these as hard `RAISE EXCEPTION` assertions, where they are correct again because the
-- drop is real." This migration is that restoration, PLUS removing every writer that could ever
-- produce a `team`/`record`-scoped grant in the same change (0103's ticket-level constraint,
-- learned the hard way on HIER-1: values and writers come out together, or not at all):
--
--   - `core/teams.controller.ts` (promote-to-lead minted `user_roles(team_lead, scope=team:<id>)`,
--     and lazily created the global `team_lead` roles row) — DELETED outright in this same change
--     (controller + module wiring + its own test file), per the consolidation plan's finding that
--     it has zero UI callers, zero live rows, and zero other backend importers.
--   - `src/testing/personas.ts` / `src/seed/personas.ts` (the `team_lead` persona, `scope: "team"`)
--     — reworked to `org_unit_lead` (HIER-2's replacement) in the same change.
--
-- With both writers gone, this migration can now safely:
--   1. COUNT-ASSERT ZERO `team`/`record` rows in `user_roles` — ABORT (hard exception) if not.
--   2. Narrow `user_roles.scope_type` CHECK to EXACTLY `('global','company','org_unit','project')`.
--   3. Narrow the per-scope shape CHECK to match (drop the `team`/`record` branch of the uuid rule).
--   4. COUNT-ASSERT ZERO rows in `teams`/`team_memberships` — ABORT if not — then DROP both tables.
--   5. Delete the global `team_lead` roles row (cascades its `role_permissions` bundle rows via
--      `role_permissions.role_id ... ON DELETE CASCADE`, 0001) and re-assert it is gone.
--   6. Delete the 4 `core.team.*` permission catalog rows (`permissions` table; cascades any
--      remaining `role_permissions` references — company_admin/manager/member/viewer's own
--      `core.team.*` bundle rows from 0094 — via `role_permissions.permission_id ... ON DELETE
--      CASCADE`), matching `permission-catalog.json`'s own removal of the same 4 entries
--      (230 -> 226 pairs, 215 -> 211 grantable, 61 -> 60 kinds — the `team` Cerbos kind and its
--      policy file, `resource_team.yaml`, are deleted in the same change as this migration).
--
-- RLS NOTE (migration-backfill-rls-trap.md): does not apply. `user_roles`, `roles`,
-- `role_permissions`, `permissions` carry no RLS (0092's own header; re-confirmed by every prior
-- migration in this family). `teams`/`team_memberships` DO carry RLS, but this migration only
-- COUNTS them (via the owner/migrator connection, which is not subject to FORCE RLS the way the
-- least-privilege app role is) before dropping the tables outright — there is no tenant-scoped
-- WHERE clause here that could silently match zero rows for the wrong reason.
--
-- Idempotent / re-runnable in spirit: every ADD CONSTRAINT is guarded by an existence check exactly
-- like 0100's; DROP TABLE IF EXISTS and the roles/permissions DELETEs are naturally re-runnable
-- (a second run finds nothing left to delete and no violation to raise).

-- ═══════════════════ (1) COUNT-ASSERT ZERO team/record rows — HARD ABORT ═══════════════════
-- Restores 0100's own downgraded guards as hard exceptions (its header's explicit instruction).
-- Live-verified 2026-08-10 (`gaiada_platform` @ gda-aicenter): team/project/record = 0/0/0.
DO $$
DECLARE
  team_count int;
  record_count int;
BEGIN
  SELECT count(*) INTO team_count FROM user_roles WHERE scope_type = 'team';
  IF team_count > 0 THEN
    RAISE EXCEPTION '0103: % user_roles row(s) still carry scope_type=''team'' — ABORT rather than silently orphan a live grant. Every known writer (teams.controller.ts, the team_lead persona seeds) is removed in this same change; a surviving row means an UNKNOWN writer exists and must be found before this migration can proceed.', team_count;
  END IF;

  SELECT count(*) INTO record_count FROM user_roles WHERE scope_type = 'record';
  IF record_count > 0 THEN
    RAISE EXCEPTION '0103: % user_roles row(s) still carry scope_type=''record'' — ABORT rather than silently orphan a live grant. ''record'' scope has zero known writers anywhere in the codebase (docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md §2.1); a surviving row is unexplained and must be investigated before this migration can proceed.', record_count;
  END IF;
END $$;

-- ═══════════════════ (2) scope_type CHECK: drop team/record for real ═══════════════════
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_type_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_roles_scope_type_check' AND conrelid = 'user_roles'::regclass
  ) THEN
    ALTER TABLE user_roles
      ADD CONSTRAINT user_roles_scope_type_check
      CHECK (scope_type IN ('global', 'company', 'org_unit', 'project'));
  END IF;
END $$;

-- ═══════════════════ (3) per-scope shape CHECK: drop the team/record uuid branch ═══════════════════
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_id_shape_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_roles_scope_id_shape_check' AND conrelid = 'user_roles'::regclass
  ) THEN
    ALTER TABLE user_roles
      ADD CONSTRAINT user_roles_scope_id_shape_check
      CHECK (
        (scope_type = 'global' AND scope_id IS NULL)
        OR (
          scope_type IN ('company', 'project')
          AND scope_id IS NOT NULL
          AND scope_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        )
        OR (
          scope_type = 'org_unit'
          AND scope_id IS NOT NULL
          AND btrim(scope_id) <> ''
        )
      );
  END IF;
END $$;

-- ═══════════════════ (4) COUNT-ASSERT ZERO teams/team_memberships rows, then DROP both ═══════════════════
DO $$
DECLARE
  teams_count int;
  memberships_count int;
BEGIN
  SELECT count(*) INTO teams_count FROM teams;
  IF teams_count > 0 THEN
    RAISE EXCEPTION '0103: % row(s) still exist in teams — ABORT rather than silently drop live data. Verified 0 live on gda-aicenter 2026-08-10; a surviving row means the table is not actually vestigial and this migration must not proceed.', teams_count;
  END IF;

  SELECT count(*) INTO memberships_count FROM team_memberships;
  IF memberships_count > 0 THEN
    RAISE EXCEPTION '0103: % row(s) still exist in team_memberships — ABORT rather than silently drop live data.', memberships_count;
  END IF;
END $$;

DROP TABLE IF EXISTS team_memberships;
DROP TABLE IF EXISTS teams;

-- ═══════════════════ (5) delete the global team_lead role (cascades its role_permissions bundle) ═══════════════════
DELETE FROM roles WHERE company_id IS NULL AND name = 'team_lead';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM roles WHERE company_id IS NULL AND name = 'team_lead') THEN
    RAISE EXCEPTION '0103: team_lead role row still present after DELETE — this should be structurally impossible';
  END IF;
  IF EXISTS (
    SELECT 1 FROM role_permissions rp
    LEFT JOIN roles r ON r.id = rp.role_id
    WHERE r.id IS NULL
  ) THEN
    RAISE EXCEPTION '0103: orphaned role_permissions row(s) found with no matching role — the ON DELETE CASCADE on role_permissions.role_id did not fire as expected';
  END IF;
END $$;

-- ═══════════════════ (6) delete the 4 core.team.* permission catalog rows ═══════════════════
-- Cascades any remaining role_permissions references (company_admin/manager/member/viewer's own
-- core.team.* bundle rows from 0094 — team_lead's own were already removed by step 5's cascade).
DELETE FROM permissions WHERE key IN ('core.team.create', 'core.team.read', 'core.team.update', 'core.team.delete');

DO $$
DECLARE
  leftover int;
BEGIN
  SELECT count(*) INTO leftover FROM permissions WHERE key LIKE 'core.team.%';
  IF leftover > 0 THEN
    RAISE EXCEPTION '0103: % core.team.* permission row(s) still present after DELETE', leftover;
  END IF;

  SELECT count(*) INTO leftover
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key LIKE 'core.team.%';
  IF leftover > 0 THEN
    RAISE EXCEPTION '0103: % role_permissions row(s) still reference a core.team.* permission — the ON DELETE CASCADE on role_permissions.permission_id did not fire as expected', leftover;
  END IF;
END $$;

-- ═══════════════════ (7) closing assertions — verify, not trust ═══════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_roles_scope_type_check' AND conrelid = 'user_roles'::regclass
  ) THEN
    RAISE EXCEPTION '0103: user_roles_scope_type_check is missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_roles_scope_id_shape_check' AND conrelid = 'user_roles'::regclass
  ) THEN
    RAISE EXCEPTION '0103: user_roles_scope_id_shape_check is missing after migration';
  END IF;

  IF EXISTS (SELECT 1 FROM user_roles WHERE scope_type IN ('team', 'record')) THEN
    RAISE EXCEPTION '0103: team/record-scoped user_roles row(s) present after the CHECK was narrowed — this should be structurally impossible (the constraint itself now rejects the value)';
  END IF;

  IF to_regclass('public.teams') IS NOT NULL THEN
    RAISE EXCEPTION '0103: teams table still exists after DROP TABLE';
  END IF;

  IF to_regclass('public.team_memberships') IS NOT NULL THEN
    RAISE EXCEPTION '0103: team_memberships table still exists after DROP TABLE';
  END IF;

  -- 0092's partial unique index is untouched by this migration (no ALTER COLUMN TYPE here), but
  -- re-verified anyway per this family's own "assert, don't assume" discipline.
  IF to_regclass('public.user_roles_global_scope_uniq') IS NULL THEN
    RAISE EXCEPTION '0103: user_roles_global_scope_uniq (0092''s partial unique index) is unexpectedly missing';
  END IF;

  RAISE NOTICE '0103: team_lead/team/record retired — scope_type is now (global,company,org_unit,project), teams/team_memberships dropped, core.team.* removed from the permission catalog';
END $$;
