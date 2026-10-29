-- AIP-13b (docs/plans/2026-10-27-ai-plan.md §6.2 item 7, owner ruling AIP-D10: each department head edits their own department's
-- assistant preamble; docs/FRONTEND-BFF-CONTRACT.md §85 once numbered by the contract doc): THE DEPARTMENT'S OWN PREAMBLE.
--
--   assistant_dept_preambles - one row per (company, unit). The text a head wrote for their department's assistant. When there is a
--                              row, `resolvePreamble` (modules/assistant/department-context.ts) uses it INSTEAD of the registry default;
--                              with no row the default stands. Deleting the row is how a head goes back to the default (the PUT with an
--                              empty body deletes it), so there is no "enabled" flag and no history: one current text per unit.
--
-- ── NOTES ─────────────────────────────────────────────────────────────────────────────────────
--   * `unit_node_id` is an org-blob node id (free text, no FK): the `dept_notices.unit_node_id` / `dept_kpi_targets.unit_node_id`
--     convention. The application validates the id against the tenant's org tree (resolveDepartment) before it writes.
--   * 1 to 1,000 characters, the same cap as the registry defaults (PREAMBLE_MAX_CHARS). The service trims first, then the CHECK holds the
--     line for any other writer. `char_length` counts code points, as the service does.
--   * `updated_by` is the last editor; erasure (deleting a user) NULLS it (ON DELETE SET NULL) and keeps the text, which is the
--     company's and not the person's.
--   * Core table, no module: RLS is the single tenant isolation policy (`tenant_id = ANY(app_current_tenants())`, FORCE), the
--     `dept_notices` shape. No `app_module_allowed(..)` term, so no module declaration is needed to read it. The assistant reads it
--     under withTenants([tenant]) on every turn that carries a department.
--   * No `origin_site`: the row is a single current value edited in place, not an event, and the AIP-13b column list does not carry it.
--
-- ── THE CHECK, AND THE NULL TRAP ─────────────────────────────────────────────────────────────────
-- A CHECK passes when its expression is NULL. `body` is NOT NULL, so `char_length(body) BETWEEN 1 AND 1000` can never evaluate to
-- NULL on a row that should be refused.
--
-- Pure DDL. The Cerbos kind's permission seed is the NEXT migration (202610291510).

-- ── 1 · assistant_dept_preambles ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assistant_dept_preambles (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  unit_node_id text NOT NULL,
  body text NOT NULL CONSTRAINT assistant_dept_preambles_body_ck CHECK (char_length(body) BETWEEN 1 AND 1000),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, unit_node_id)
);

ALTER TABLE assistant_dept_preambles ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_dept_preambles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON assistant_dept_preambles;
CREATE POLICY tenant_isolation ON assistant_dept_preambles FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

COMMENT ON TABLE assistant_dept_preambles IS
  'AIP-13b — a department head''s own assistant preamble (one row per company and org unit, 1 to 1,000 characters). When a row exists '
  'the assistant uses it instead of the registry default; deleting the row restores the default. Core table, tenant RLS only.';

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = current_schema() AND c.relname = 'assistant_dept_preambles' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610291500: assistant_dept_preambles must have RLS enabled and FORCED (found % matching table)', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'assistant_dept_preambles'::regclass AND contype = 'c' AND conname = 'assistant_dept_preambles_body_ck';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610291500: expected the named body CHECK on assistant_dept_preambles, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'assistant_dept_preambles'::regclass AND contype = 'p';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610291500: expected the (tenant_id, unit_node_id) primary key on assistant_dept_preambles, found %', n;
  END IF;

  -- erasure: deleting a user nulls updated_by (it must not block the delete and must not delete the text)
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'assistant_dept_preambles'::regclass AND contype = 'f' AND confrelid = 'users'::regclass AND confdeltype = 'n';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610291500: updated_by must reference users ON DELETE SET NULL, found % matching foreign key(s)', n;
  END IF;

  RAISE NOTICE '202610291500: assistant_dept_preambles ready (RLS forced, body CHECK, primary key, updated_by ON DELETE SET NULL)';
END $$;
