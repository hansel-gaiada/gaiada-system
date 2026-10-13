-- PV-D31 (D21, owner ruling 2026-10-13) — the OPERATOR ROOT marker.
--
-- Ruling (docs/plans/2026-10-10-three-perspectives.md, decision log PV-D31): Platform's owner arm is
-- limited to the operator's own root. The operator root is named by ONE setting — data, never a
-- hard-coded id (PV-D13) — and only owners of THAT root get the Platform area and the system
-- controls (bots, AI gateway, MCP hub, automation, observability). `platform_admin` is unchanged.
-- Owners of any other root get none of it. This narrows PV-D18's "owner of ANY root" arm, which was
-- harmless while one root existed and would hand a future customer root's owner our whole
-- deployment's consoles the day that root is created.
--
-- ── WHY A DEDICATED COLUMN AND NOT A `companies.settings` KEY ────────────────────────────────────
-- 1. `companies.settings` is a SHARED jsonb that a company_admin can already write through
--    PATCH /api/admin/companies/:id (D14-07's approvalRetry key). Today that PATCH merges one
--    validated path only, but the column's whole purpose is "company-editable preferences", and a
--    privilege marker living in it is one careless generic merge away from a company_admin
--    promoting their own root to the operator. A column that NO route writes cannot drift that way.
-- 2. A column can be CONSTRAINED, and a jsonb key cannot (not without an expression index and a
--    CHECK over a cast): a partial unique index makes "at most one operator root" a property of the
--    schema, and a CHECK makes "only a root can be the operator root" one too. Same idiom as
--    `companies.is_training` + `ux_companies_one_training` (202608241550), the repo's precedent for
--    "exactly one company plays this role".
-- 3. `isPlatformOperator` reads it with one indexed primary-key lookup it already made.
--
-- ── WHAT THIS FILE DOES TO DATA ──────────────────────────────────────────────────────────────────
-- It marks the root ONLY when exactly one non-deleted root exists (`id = root_company_id`, which the
-- MON-00a trigger maintains). With two or more it RAISES: in a multi-root estate a human must decide
-- which root is ours, and a guess here hands a customer our consoles. With ZERO roots (a fresh
-- database, which is every test database: `initTestDb` migrates an empty schema) it marks nothing and
-- says so; whoever creates the first root marks it deliberately (a follow-up for the seeds, not
-- invented here). The live estate has exactly one root, the holding.
--
-- `companies` is a core GLOBAL table with no RLS (0001), so the plain UPDATE below sees every row
-- even under the migrator's NOBYPASSRLS role; the assertion at the end proves the count anyway.
--
-- Additive: one column (default false), one partial unique index, one CHECK, one guarded UPDATE.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_operator_root boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.is_operator_root IS
  'PV-D31. TRUE for the single OPERATOR root: the root company whose owners get the Platform area and '
  'the system controls (bots, AI gateway, MCP hub, automation, observability). Owners of any other '
  'root get none of it; platform_admin is unaffected. Data, never a hard-coded id (PV-D13). No API '
  'route writes it: set it by migration or by an operator with database access, deliberately.';

-- At most ONE operator root among live companies. `((true))` is the whole-table singleton idiom
-- under a WHERE (ux_companies_one_training).
CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_one_operator_root
  ON companies ((true)) WHERE is_operator_root AND deleted_at IS NULL;

-- Only a ROOT can be the operator root. IS NOT DISTINCT FROM, not `=`: a NULL root_company_id would
-- make `=` NULL and a CHECK passes on NULL, which is the wrong way round for a privilege marker.
-- The MON-00a trigger refuses a cross-root re-parent, so a marked root cannot quietly stop being one.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_operator_root_is_root;
ALTER TABLE companies ADD CONSTRAINT companies_operator_root_is_root
  CHECK (NOT is_operator_root OR root_company_id IS NOT DISTINCT FROM id);

DO $$
DECLARE
  roots  integer;
  marked integer;
BEGIN
  SELECT count(*) INTO roots
    FROM companies WHERE id = root_company_id AND deleted_at IS NULL;
  SELECT count(*) INTO marked
    FROM companies WHERE is_operator_root AND deleted_at IS NULL;

  -- Already marked: only possible when a human pre-marked it (the multi-root path below says how).
  IF marked = 1 THEN
    RAISE NOTICE 'PV-D31: an operator root is already marked; leaving it as it is.';
  ELSIF roots = 0 THEN
    RAISE NOTICE 'PV-D31: no root company exists (a fresh database). Nothing marked; mark the operator root when it is created.';
  ELSIF roots = 1 THEN
    UPDATE companies SET is_operator_root = true, updated_at = now()
     WHERE id = root_company_id AND deleted_at IS NULL;
  ELSE
    RAISE EXCEPTION
      'PV-D31: % root companies exist, so the operator root cannot be chosen automatically. A human must '
      'decide which root is the operator and mark it before this migration can run (ALTER TABLE companies '
      'ADD COLUMN IF NOT EXISTS is_operator_root boolean NOT NULL DEFAULT false; UPDATE companies SET '
      'is_operator_root = true WHERE id = <root>); guessing would hand a customer root''s owners the '
      'system consoles.',
      roots;
  END IF;
END $$;

-- Assert the result, so a silent no-op (or a second marked row) cannot ship as success: exactly one
-- live operator root whenever any root exists, and it is a root.
DO $$
DECLARE
  roots  integer;
  marked integer;
  bad    integer;
BEGIN
  SELECT count(*) INTO roots
    FROM companies WHERE id = root_company_id AND deleted_at IS NULL;
  SELECT count(*) INTO marked
    FROM companies WHERE is_operator_root AND deleted_at IS NULL;
  SELECT count(*) INTO bad
    FROM companies WHERE is_operator_root AND deleted_at IS NULL AND id IS DISTINCT FROM root_company_id;

  IF roots > 0 AND marked <> 1 THEN
    RAISE EXCEPTION 'PV-D31 assertion: % root(s) exist but % operator root(s) are marked; expected exactly 1.', roots, marked;
  END IF;
  IF roots = 0 AND marked <> 0 THEN
    RAISE EXCEPTION 'PV-D31 assertion: no root exists but % operator root(s) are marked.', marked;
  END IF;
  IF bad <> 0 THEN
    RAISE EXCEPTION 'PV-D31 assertion: % marked operator root(s) are not roots.', bad;
  END IF;
END $$;
