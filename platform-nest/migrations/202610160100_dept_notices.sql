-- DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57.1; plan docs/plans/2026-10-13-department-workspaces.md §11.4 and §12.1, row 10a;
-- owner ruling DW-D32): THE DEPARTMENT NOTICE BOARD.
--
--   dept_notices - one row per notice. A notice is posted to ONE unit of the company's org tree (scope = 'unit', unit_node_id
--                  set) or to the whole company (scope = 'company', unit_node_id NULL). There is NO delete: a notice is
--                  WITHDRAWN (withdrawn_at / withdrawn_by, set once and never cleared by the service) and the row stays for the
--                  record. A notice is CURRENT while it is not withdrawn and ends_on is NULL or on or after the company's report
--                  day; the service decides that (todayIsoInTz), not a column.
--
-- ── NOTES ─────────────────────────────────────────────────────────────────────────────────────
--   * `unit_node_id` is an org-blob node id (free text, no FK): the `dept_kpi_targets.unit_node_id` convention. The org tree
--     lives in the `company_org_structure` blob, so the application validates the id against the tenant's tree before it
--     writes, and the tree's ROOT is refused there (company-wide is `scope = 'company'`).
--   * Core table, no module: RLS is the single tenant isolation policy (`tenant_id = ANY(app_current_tenants())`, FORCE), the
--     `calendar_events` shape. There is no `app_module_allowed(..)` term, so no module declaration is needed to read it.
--   * `origin_site` has NO default (the sync rule: every writer states its site).
--
-- ── THE CHECKS, AND THE NULL TRAP ────────────────────────────────────────────────────────────────
-- A CHECK passes when its expression is NULL. Each rule below is written so it can never evaluate to NULL on a row that should
-- be refused: the scope/unit pairing is a pair of IS [NOT] NULL tests joined with the (NOT NULL) scope, the length checks run on
-- NOT NULL columns, and the withdrawn pairing compares two booleans that are never NULL (IS NULL tests).
--
-- Pure DDL. The Cerbos kind's permission seed is the NEXT migration (202610160110).

-- ── 1 · dept_notices ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dept_notices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  scope text NOT NULL CHECK (scope IN ('unit', 'company')),
  unit_node_id text,
  title text NOT NULL,
  body text NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  ends_on date,
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  edited_by uuid REFERENCES users(id),
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  CONSTRAINT dept_notices_scope_unit_ck CHECK (
    (scope = 'unit' AND unit_node_id IS NOT NULL AND char_length(unit_node_id) > 0)
    OR (scope = 'company' AND unit_node_id IS NULL)
  ),
  CONSTRAINT dept_notices_title_ck CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT dept_notices_body_ck CHECK (char_length(body) BETWEEN 1 AND 4000),
  CONSTRAINT dept_notices_withdrawn_ck CHECK ((withdrawn_by IS NULL) = (withdrawn_at IS NULL))
);

-- A unit's board (and, through the closure, the notices of every unit above it): newest first, live rows only.
CREATE INDEX IF NOT EXISTS ix_dept_notices_unit
  ON dept_notices (tenant_id, unit_node_id, created_at DESC) WHERE withdrawn_at IS NULL;
-- The company-wide board.
CREATE INDEX IF NOT EXISTS ix_dept_notices_company
  ON dept_notices (tenant_id, created_at DESC) WHERE scope = 'company' AND withdrawn_at IS NULL;

ALTER TABLE dept_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE dept_notices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dept_notices;
CREATE POLICY tenant_isolation ON dept_notices FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

COMMENT ON TABLE dept_notices IS
  'DW-10a — department notice board (FRONTEND-BFF-CONTRACT §57). A unit notice (scope unit, unit_node_id an org-tree node) or '
  'a company-wide one (scope company, no unit). Never deleted: withdrawn_at/withdrawn_by mark a withdrawal. Core table, tenant RLS only.';

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = current_schema() AND c.relname = 'dept_notices' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610160100: dept_notices must have RLS enabled and FORCED (found % matching table)', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'dept_notices'::regclass AND contype = 'c'
     AND conname IN ('dept_notices_scope_unit_ck', 'dept_notices_title_ck', 'dept_notices_body_ck', 'dept_notices_withdrawn_ck');
  IF n <> 4 THEN
    RAISE EXCEPTION '202610160100: expected the 4 named CHECKs on dept_notices, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'dept_notices' AND indexname IN ('ix_dept_notices_unit', 'ix_dept_notices_company');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610160100: expected the 2 partial indexes on dept_notices, found %', n;
  END IF;

  RAISE NOTICE '202610160100: dept_notices ready (RLS forced, 4 CHECKs, 2 indexes)';
END $$;
