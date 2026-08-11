-- 0092 — close the NULL-defeats-UNIQUE hole on user_roles' GLOBAL-scope grants (IAM-01c-2 / Finding
-- F, docs/superpowers/plans/2026-08-10-iam-phase1-tickets.md §6).
--
-- THE BUG. `user_roles` has carried `UNIQUE (user_id, role_id, scope_type, scope_id)` since 0001.
-- For every scope OTHER than global, scope_id is a real (NOT NULL-in-practice) company/team/
-- project/record id and the constraint works. For GLOBAL grants, `scope_id` is NULL by design (the
-- column comment says so: "NULL for global scope") — and in SQL, two NULLs are never equal for
-- uniqueness purposes, so `(u, r, 'global', NULL)` never collides with `(u, r, 'global', NULL)`.
-- Every global grant is exempt from the very constraint that appears to protect it, exactly the same
-- bug class 0073_dedupe_global_roles.sql fixed on `roles.name` — 0073 could not touch this table
-- because it dedupes ROLE rows, not USER_ROLES rows, and left this constraint deliberately
-- unchanged (see 0026_service_layer.sql's A2 note: "the existing user_roles
-- UNIQUE(user_id,role_id,scope_type,scope_id) ... left unchanged").
--
-- CONFIRMED LIVE 2026-08-10 (`gaiada_platform` @ gda-aicenter, SELECT-only): both real elevated
-- accounts carry duplicate global grants —
--   exec@gaiada.test  | group_executive | scope_type=global | 2 rows (ids …bcca, …e29f)
--   hansel@gaiada.com | platform_admin  | scope_type=global | 2 rows (ids …4960, …38c4)
-- All four rows have managed_by IS NULL. The most likely mechanism: `src/seed/agency.ts`'s
-- `grantRole(users.exec, roleExec, 'global', null)` / `grantRole(users.superadmin, rolePlatform,
-- 'global', null)` (seed:agency) is re-run across deploys; `testing/fixtures.ts`'s `grantRole()`
-- issues a bare `ON CONFLICT DO NOTHING` (no target — Postgres treats that as a catch-all over EVERY
-- unique constraint on the table), so it has always been silently safe to re-run for non-global
-- scopes and silently UNSAFE for global ones, because the only constraint that could catch it never
-- fires on NULL. This migration does not change `grantRole()` (out of this ticket's file scope —
-- see the migration's own follow-up note at the bottom and the ticket report) but the mechanics
-- explain the recurrence 0073's header already predicted for this exact table.
--
-- WHY THIS MATTERS NOW. The IAM permission-catalog program (IAM-01/02/03) is moving authorization
-- from role-NAME matching to resolving a principal's PERMISSIONS from their grants. A duplicated
-- grant resolves the same permission set twice — harmless for a boolean `hasRole()` check, not
-- harmless for anything that COUNTS grants, DIFFS them, or renders them in the forthcoming
-- role-assignment UI (IAM-05b/06). This must land before IAM-02a/03a start resolving bundles from
-- `user_roles` rows.
--
-- OTHER GRANT-SHAPED TABLES CHECKED (per this ticket's instruction) — none share the hole:
--   * `roles` — UNIQUE(company_id, name), company_id nullable — WAS the same bug, ALREADY closed by
--     0073's `roles_global_name_uniq` partial index. Not touched again here.
--   * `company_memberships` — UNIQUE(tenant_id, user_id); both columns are NOT NULL (tenant_id and
--     user_id are `NOT NULL REFERENCES ...` in 0001). No nullable column in the key → the NULL-
--     defeats-UNIQUE trap cannot occur here. Confirmed by reading 0001_core.sql's DDL directly, not
--     inferred.
--   * `team_memberships` — UNIQUE(tenant_id, user_id, team_id), all three NOT NULL. Same reasoning,
--     clean.
--   * `identity_links` — UNIQUE(provider, external_id), both NOT NULL. Clean.
--   * `service_grant_claims` — its two partial unique indexes (`ux_claims_membership`,
--     `ux_claims_user_role`) were ALREADY built as `WHERE <col> IS NOT NULL` partials specifically to
--     avoid this exact trap (0026's own header calls it out: "NULLs are distinct in a plain UNIQUE
--     and would let duplicate claims through"). Already correct, nothing to do.
-- So `user_roles` was the one remaining hole; this migration is scoped to it alone.
--
-- THE CRITICAL-TRAP CHECK THIS LEDGER HAS BEEN BURNED BY TWICE (0050/0051, memory
-- `migration-backfill-rls-trap`): migrations run as `platform_owner`, which is deliberately
-- NOBYPASSRLS, so an UPDATE/DELETE against a FORCE-RLS table with `app.current_tenant_ids` unset
-- silently matches ZERO rows and still reports success. It DOES NOT APPLY HERE: `user_roles` is one
-- of 0001's own "Global tables (no tenant_id; app-layer guarded)" — verified live 2026-08-10 via
-- `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'user_roles'` → both
-- `f` (false). There is no RLS policy in this table's path at all, so there is no GUC to forget.
-- The dedupe DELETE below is asserted by row-count anyway (not assumed), per the ticket's own
-- instruction to prove it rather than trust it.
--
-- service_grant_claims.user_role_id is a plain (non-cascading) FK to user_roles(id). If a duplicate
-- row being deleted below were ever referenced by a claim, the DELETE would fail LOUDLY with a
-- foreign-key violation (the lint script's own header calls this the SAFE failure mode — a hard
-- error that rolls back the whole transaction — as opposed to the silent-zero-rows class above).
-- No repoint step is written for that table because it is structurally impossible under the current
-- write path: `service-reconciler.ts` is the only minter of `service_grant_claims` rows, and it
-- always inserts `user_roles` with `scope_type = 'company'` and a real `scope_id` (the served
-- tenant) — never `'global'`. Confirmed live 2026-08-10: zero `service_grant_claims` rows reference
-- any `user_roles` row with `scope_id IS NULL`. If this ever becomes nonzero, the loud FK error is
-- the correct outcome, not something to migrate around silently.
--
-- Canonical winner = the OLDEST row, chosen by id (UUIDv7 ids are creation-ordered, so this is
-- deterministic and re-runnable rather than dependent on physical row order) — same convention as
-- 0073.

BEGIN;

-- (1) Map every duplicate GLOBAL-scope grant (scope_id IS NULL) to its canonical survivor.
CREATE TEMP TABLE user_roles_global_dedupe_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT id, user_id, role_id, scope_type, managed_by,
         first_value(id) OVER (
           PARTITION BY user_id, role_id, scope_type ORDER BY id
         ) AS keep_id
  FROM user_roles
  WHERE scope_id IS NULL
)
SELECT id AS dup_id, keep_id, managed_by AS dup_managed_by
FROM ranked
WHERE id <> keep_id;

-- (2) Fail loudly rather than silently overwrite: if a duplicate carries a managed_by that
-- DISAGREES with its survivor's own (already non-null, different) managed_by, that is a genuine
-- data conflict needing a human decision, not something this mechanical dedupe should resolve by
-- picking a side. (Not expected to fire — see the header: today's 4 live duplicates all have
-- managed_by NULL — but this is defensive against future data, not reactive to today's.)
DO $$
DECLARE
  conflicting int;
BEGIN
  SELECT count(*) INTO conflicting
  FROM user_roles_global_dedupe_map m
  JOIN user_roles keep ON keep.id = m.keep_id
  WHERE m.dup_managed_by IS NOT NULL
    AND keep.managed_by IS NOT NULL
    AND keep.managed_by <> m.dup_managed_by;
  IF conflicting > 0 THEN
    RAISE EXCEPTION
      '0092: % duplicate global grant(s) carry a managed_by that conflicts with their survivor''s '
      'own managed_by — needs a human decision, not a silent dedupe', conflicting;
  END IF;
END $$;

-- (3) Preserve managed_by: promote a duplicate's managed_by onto the survivor when the survivor
-- doesn't already carry one, so the reconciler-owned marker (0026 §D) is never lost to a delete.
UPDATE user_roles keep
SET managed_by = m.dup_managed_by
FROM user_roles_global_dedupe_map m
WHERE keep.id = m.keep_id
  AND keep.managed_by IS NULL
  AND m.dup_managed_by IS NOT NULL;

-- (4) Delete the losers — asserted by row count, not assumed.
DO $$
DECLARE
  expected int;
  affected int;
BEGIN
  SELECT count(*) INTO expected FROM user_roles_global_dedupe_map;

  DELETE FROM user_roles ur
  USING user_roles_global_dedupe_map m
  WHERE ur.id = m.dup_id;
  GET DIAGNOSTICS affected = ROW_COUNT;

  RAISE NOTICE '0092: deleted % duplicate global-scope user_roles row(s) (expected %)', affected, expected;
  IF affected <> expected THEN
    RAISE EXCEPTION
      '0092: DELETE affected % row(s) but the dedupe map had % — mismatch, aborting rather than '
      'committing a partial dedupe', affected, expected;
  END IF;
END $$;

-- (5) Make it impossible to recur: the partial unique index the original 4-column constraint was
-- reaching for, applied exactly to the slice where NULL-distinctness had disabled enforcement.
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_global_scope_uniq
  ON user_roles (user_id, role_id, scope_type)
  WHERE scope_id IS NULL;

-- (6) Fail loudly if anything above left the table inconsistent, rather than committing a
-- half-deduped table (same discipline as 0073's own closing assertion).
DO $$
DECLARE
  dupes int;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT user_id, role_id, scope_type
    FROM user_roles
    WHERE scope_id IS NULL
    GROUP BY user_id, role_id, scope_type
    HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION '0092: % global-scope grant(s) still duplicated after dedupe', dupes;
  END IF;
END $$;

COMMIT;

-- FOLLOW-UP FLAGGED, NOT FIXED HERE (out of this ticket's file-ownership scope — migration + a new
-- test file + the ticket report only): `admin-identity.controller.ts`'s `assignRole` handler inserts
-- with a TARGETED `ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING` — a targeted
-- arbiter only suppresses a violation detected via THAT exact index. For a repeat grant of an
-- already-held GLOBAL role, the named 4-column arbiter still never fires (same NULL reason as
-- always), so the INSERT now hits the NEW partial index above instead — which is NOT the named
-- arbiter — and raises a real, unhandled 23505 unique-violation instead of the endpoint's current
-- graceful "already granted, adopt if reconciler-managed" flow. `testing/fixtures.ts`'s `grantRole()`
-- (used by `seed:agency` and most test fixtures) is UNAFFECTED — its `ON CONFLICT DO NOTHING` has NO
-- target, which Postgres treats as a catch-all over every unique constraint on the table. The
-- `assignRole` endpoint needs a follow-up (branch the ON CONFLICT target on `scopeType === 'global'`,
-- or drop to an untargeted `ON CONFLICT DO NOTHING` there too) before a role-assignment UI drives
-- repeat global grants through it. Reported to the ticket coordinator; not this migration's file to
-- change.
