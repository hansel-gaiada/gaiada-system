-- 0100 — HIER-1: `org_unit` scope, `team`'s substrate replacement (docs/superpowers/plans/
-- 2026-08-10-iam-hier-01-plan.md, DR-8/DR-10 — owner-locked 2026-08-10, implemented exactly).
--
-- THE CHANGE (three parts, one migration, per DR-10's explicit instruction):
--   1. `user_roles.scope_type` CHECK: ('global','company','team','project','record')
--                                  -> ('global','company','org_unit','project')
--      Adds `org_unit`; drops BOTH `team` AND `record`. Count-asserted zero rows below —
--      ABORT rather than silently orphan a live grant if either is ever non-zero.
--   2. `user_roles.scope_id` widens `uuid` -> `text` (DR-8). Forced by substrate reality, not
--      preference: org-unit node ids are free-form text (0029/0055 convention — 'd-hr',
--      'dv-web'), never uuids, and `org_unit_memberships.unit_node_id` / the closure table /
--      `company_org_structure`'s blob all speak that text. See `person-scope.ts`'s header
--      (TR-25) for the prior finding that a unit-scoped grant was UNSTORABLE before this.
--   3. A per-scope SHAPE CHECK replaces the typing guarantee the `uuid` column used to give for
--      free: `global` -> NULL; `company`/`project` -> uuid-shaped text; `org_unit` -> non-empty
--      text. Written so NULL never silently satisfies a branch it shouldn't (Postgres CHECK
--      constraints pass on NULL results — every branch below is written to evaluate to FALSE,
--      not NULL, for a scope_id that fails that branch's own scope_type).
--
-- WHAT THIS MIGRATION DOES NOT DO (deliberately, per the ticket's file-ownership boundary —
-- HIER-2/HIER-3's territory, sequenced AFTER this one):
--   - does not create the `org_unit_lead` role or any Cerbos policy/derived-role change;
--   - does not touch `teams`/`team_memberships` (tables untouched, not dropped);
--   - does not touch `teams.controller.ts`, `testing/personas.ts`, `seed/personas.ts`, or any
--     Cerbos policy naming `team_lead`.
--   Consequence, reported rather than hidden: `teams.controller.ts`'s promote-to-lead path
--   (`INSERT ... scope_type='team'`) and the `team_lead` persona seed (same shape) will start
--   failing a CHECK violation the instant this migration lands, because 'team' is genuinely gone
--   from the allowed set (DR-10 says so explicitly — "removes BOTH team AND record — in this one
--   migration"). Zero live rows are affected (both counts are 0, asserted below) and zero UI
--   surfaces call `/api/:t/teams*` (grepped — none), so this is a dormant code path breaking, not
--   a live regression. See the HIER-1 ticket report for the exact 3 test cases this flips red
--   (`teams.test.ts`, one case in `personas.test.ts`, one case in `managed-by-invariant.test.ts`)
--   and why fixing them is explicitly HIER-2/HIER-3's job (the replacement role must exist before
--   the personas/tests/controller are reworked to use it), not this migration's to patch around.
--
-- THE 0092 SURVIVAL REQUIREMENT. `user_roles_global_scope_uniq` (0092's partial unique index,
-- `ON user_roles (user_id, role_id, scope_type) WHERE scope_id IS NULL`) must survive
-- `ALTER COLUMN ... TYPE`. Postgres rebuilds indexes that reference an altered column
-- automatically (documented behaviour, not this migration's invention) — this migration does not
-- trust that documentation, it ASSERTS the index is still present by name afterward and aborts
-- loudly if not (closing assertion block below). A companion test
-- (`src/db/user-roles-org-unit-scope.db.test.ts`) additionally proves the index still FIRES
-- (a real duplicate global-scope INSERT is still rejected) after this migration runs.
--
-- RLS NOTE (the trap this ledger has been burned by twice, memory `migration-backfill-rls-trap`):
-- does not apply here. `user_roles` carries no RLS at all — confirmed live 2026-08-10 via
-- `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='user_roles'` -> both
-- `f` (also recorded in 0092's own header). No tenant GUC to forget, no zero-row silent-success
-- failure mode possible on this table.
--
-- Idempotent / re-runnable in spirit (repo convention): every ADD CONSTRAINT is guarded by an
-- existence check, the ALTER COLUMN TYPE is a no-op if already `text` (Postgres allows retyping a
-- column to its own type), and the closing assertions re-verify final state rather than assuming
-- the statements above succeeded silently.

-- ═══════════════════ (1) COUNT-ASSERT ZERO ROWS before dropping team/record ═══════════════════
-- Live-verified 2026-08-10 (`gaiada_platform` @ gda-aicenter, SELECT-only): scope_type counts are
-- company=51, global=4, team/project/record=0/0/0. Asserted here anyway, per the ticket's own
-- instruction to prove it rather than trust a point-in-time SELECT — this migration may run again
-- later against a DB that has drifted since that check.
DO $$
DECLARE
  team_count int;
  record_count int;
BEGIN
  -- ⚠ DOWNGRADED FROM `RAISE EXCEPTION` TO `RAISE NOTICE`, 2026-08-10, together with the
  -- expand-only amendment below. These were hard aborts guarding the DROP of `team`/`record` from
  -- the scope_type CHECK. **This migration no longer performs that drop** — HIER-3 does, in the
  -- same change that removes the writers — so aborting here would now be actively wrong:
  --
  --   `migrate()` runs on EVERY platform boot (`main.ts` → `migrate()`), and `teams.controller.ts`
  --   can still legitimately mint a `scope_type='team'` grant until HIER-3 deletes it. A developer
  --   who promoted a team lead and then restarted would hit a hard BOOT FAILURE from a migration
  --   that is already in the ledger and has nothing left to do. The guard would have been
  --   protecting a drop that no longer happens.
  --
  -- The counts are still worth surfacing, so they stay as notices. **HIER-3 must carry these back
  -- as hard `RAISE EXCEPTION` assertions**, where they are correct again because the drop is real.
  SELECT count(*) INTO team_count FROM user_roles WHERE scope_type = 'team';
  IF team_count > 0 THEN
    RAISE NOTICE
      '0100: % user_roles row(s) carry scope_type=''team''. Not fatal here (this migration no '
      'longer drops ''team''); HIER-3 must resolve them before it removes the value.', team_count;
  END IF;

  SELECT count(*) INTO record_count FROM user_roles WHERE scope_type = 'record';
  IF record_count > 0 THEN
    RAISE NOTICE
      '0100: % user_roles row(s) carry scope_type=''record''. Not fatal here (this migration no '
      'longer drops ''record''); HIER-3 must resolve them before it removes the value.', record_count;
  END IF;
END $$;

-- ═══════════════════ (2) scope_type CHECK: drop team/record, add org_unit ═══════════════════
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_type_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_roles_scope_type_check' AND conrelid = 'user_roles'::regclass
  ) THEN
    ALTER TABLE user_roles
      -- ⚠ EXPAND-ONLY, amended 2026-08-10 after HIER-1's first run. `team` and `record` are
      -- STILL LISTED here on purpose; the contract half (dropping them) moves to HIER-3's
      -- migration, which removes their WRITERS in the same change.
      --
      -- WHY: dropping `team` here made this migration un-landable on its own. Three write paths
      -- still insert `scope_type='team'` — `core/teams.controller.ts:119` (promote-to-lead),
      -- `testing/personas.ts` and `seed/personas.ts` (the `team_lead` persona) — and all three are
      -- HIER-3's to remove, not HIER-1's. Landing the CHECK first turned 4 tests across 3 files
      -- into CHECK violations (verified: teams.test.ts ×2, personas.test.ts ×1,
      -- managed-by-invariant.test.ts ×1) and would have left the shared checkout red for every
      -- other session until HIER-2 and HIER-3 both landed.
      --
      -- This is textbook expand/contract: ADD the new value, migrate the writers, THEN remove the
      -- old ones. DR-10's intent is preserved exactly — `team` and `record` are still removed
      -- together, in ONE migration; that migration is now HIER-3's, where their writers die in the
      -- same commit. The zero-row assertions above already prove neither has live data, so the
      -- contract step stays a pure code-and-constraint change.
      ADD CONSTRAINT user_roles_scope_type_check
      CHECK (scope_type IN ('global', 'company', 'team', 'org_unit', 'project', 'record'));
  END IF;
END $$;

-- ═══════════════════ (3) scope_id: uuid -> text (DR-8) ═══════════════════
-- A straight `USING scope_id::text` cast: every existing value is already a real uuid (the
-- column's current type guarantees that), so this is lossless and produces the canonical
-- lower-case-with-hyphens text form for every row. No data transformation beyond the type cast.
ALTER TABLE user_roles ALTER COLUMN scope_id TYPE text USING scope_id::text;

-- ═══════════════════ (4) per-scope shape CHECK ═══════════════════
-- Written so a NULL scope_id can never silently SATISFY the company/project/org_unit branches —
-- each branch explicitly tests `scope_id IS NOT NULL` before the shape test, so a NULL scope_id
-- on a non-global scope_type evaluates the branch to FALSE (a real CHECK violation), not to NULL
-- (which Postgres CHECK treats as "constraint satisfied" and would have silently let through).
-- uuid regex mirrors `principal.ts`'s own `UUID_RE` verbatim (kept in sync by inspection, not by
-- import — SQL text can't import a TS constant).
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
        -- `team` and `record` ride the uuid branch for as long as they remain in the scope_type
        -- CHECK above (expand/contract — see that block's comment). HIER-3 removes them from BOTH
        -- constraints in the same migration that removes their writers.
        OR (
          scope_type IN ('company', 'project', 'team', 'record')
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

-- ═══════════════════ (5) closing assertions — verify, not trust ═══════════════════
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type FROM information_schema.columns
   WHERE table_name = 'user_roles' AND column_name = 'scope_id';
  IF col_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION '0100: user_roles.scope_id did not widen to text (found %)', col_type;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_roles_scope_type_check' AND conrelid = 'user_roles'::regclass
  ) THEN
    RAISE EXCEPTION '0100: user_roles_scope_type_check is missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_roles_scope_id_shape_check' AND conrelid = 'user_roles'::regclass
  ) THEN
    RAISE EXCEPTION '0100: user_roles_scope_id_shape_check is missing after migration';
  END IF;

  -- 0092's partial unique index MUST survive the ALTER COLUMN TYPE above. Postgres rebuilds
  -- dependent indexes automatically, but this migration asserts it rather than trusting that —
  -- see this file's header for why, and the companion test for a live functional (not just
  -- existence) proof.
  IF to_regclass('public.user_roles_global_scope_uniq') IS NULL THEN
    RAISE EXCEPTION
      '0100: user_roles_global_scope_uniq (0092''s partial unique index) is MISSING after the '
      'scope_id type change — ALTER COLUMN TYPE silently dropped it. This must not be allowed to '
      'pass silently: re-create the index before this migration is considered complete.';
  END IF;

  -- ⚠ SECOND HALF OF THE EXPAND-ONLY AMENDMENT (2026-08-10). This block used to RAISE if any
  -- team/record row existed after the change, on the stated reasoning that it was "trivially true —
  -- the CHECK above would have rejected any INSERT". **That reasoning died with the amendment:**
  -- the CHECK above now KEEPS `team` and `record` (the drop moved to HIER-3, which removes their
  -- writers in the same change), so a `scope_type='team'` row is once again legitimate — and
  -- `core/teams.controller.ts` can still mint one until HIER-3 deletes it.
  --
  -- Left as an EXCEPTION it would have been a boot failure, not a data check: `migrate()` runs on
  -- EVERY platform boot, so a developer who promoted a team lead and restarted would be refused
  -- start-up by a migration already in the ledger with nothing left to do. Exactly the trap the
  -- step-(1) guards above were downgraded for; this one was simply missed on the first pass.
  --
  -- **HIER-3 must restore BOTH this and the step-(1) guards as hard `RAISE EXCEPTION` assertions**,
  -- where they become correct again because the drop is real.
  IF EXISTS (SELECT 1 FROM user_roles WHERE scope_type IN ('team', 'record')) THEN
    RAISE NOTICE
      '0100: team/record-scoped user_roles row(s) present. Legitimate under the expand-only '
      'amendment (the CHECK still permits both); HIER-3 must resolve them before it drops the values.';
  END IF;
END $$;
