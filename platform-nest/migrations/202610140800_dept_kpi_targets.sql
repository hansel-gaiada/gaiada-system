-- DW-4e-1 (docs/FRONTEND-BFF-CONTRACT.md §40.2; plan docs/plans/2026-10-13-department-workspaces.md §5.5, owner ruling
-- DW-Q4): DEPARTMENT KPI TARGETS. The head proposes a target for one of their unit's KPIs from a month on; the approver
-- approves or rejects it. Only an APPROVED row is ever in force, so a newer proposal changes nothing until it is
-- approved ("last period's target stays in force"), and a KPI with no approved row reads "no target".
--
--   dept_kpi_targets — one row per proposal. Its lifecycle: proposed -> approved | rejected; an approved row becomes
--                      superseded when a later approval takes over from the same effective_from on.
--
-- ── NOTES ─────────────────────────────────────────────────────────────────────────────────────
--   * `unit_node_id` is an org-blob node id (free text, no FK): the `projects.department_id` / `work_requests.to_unit_id`
--     convention. The application validates it against the tenant's org tree before writing.
--   * `kpi_key` is a key of the unit's workspace KPI set in src/modules/reports/dept-kpis.ts (the catalogue lives in
--     code, not in a table); the application validates it.
--   * Targets are LEVELS (a rate, or a point-in-time count), so one row applies to a month, a quarter, a semester or a
--     year alike: no per-period-kind targets. A percent target is a fraction (0.85 = 85%), the scale of the report
--     document's own `value`.
--   * `effective_from` is always a month start (CHECK). In force for a period: the latest `approved` row for
--     (unit, KPI) whose effective_from is on or before the period's start.
--   * At most one APPROVED row per (tenant, unit, KPI, effective_from): the partial unique index is the database's
--     backstop for the approve path, which supersedes inside one transaction under a row lock on the (unit, KPI)
--     family.
--   * `decided_by` / `decided_at` record the approval or rejection; a superseded row keeps its own approval's. A
--     proposed row has neither (CHECK).
--   * RLS: the `reports` third wall, exactly as report_periods / report_documents (0067): tenant_id in the request's
--     tenant set AND the `reports` module scope declared, on USING and WITH CHECK. `origin_site` has NO default.
--
-- Pure DDL. The Cerbos kind's permission seed is the NEXT migration (202610140810).

CREATE TABLE IF NOT EXISTS dept_kpi_targets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  unit_node_id text NOT NULL CHECK (char_length(unit_node_id) > 0),
  kpi_key text NOT NULL CHECK (char_length(kpi_key) BETWEEN 1 AND 100),
  effective_from date NOT NULL CHECK (extract(day FROM effective_from) = 1),
  target numeric NOT NULL,
  tolerance numeric NOT NULL CHECK (tolerance >= 0),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded')),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  proposed_by uuid NOT NULL REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  origin_site text NOT NULL,
  CONSTRAINT dept_kpi_targets_decided_ck CHECK ((status = 'proposed') = (decided_at IS NULL))
);

-- The in-force lookup and the targets screen: every row of a unit's KPI, newest month first.
CREATE INDEX IF NOT EXISTS ix_dept_kpi_targets_unit_kpi
  ON dept_kpi_targets (tenant_id, unit_node_id, kpi_key, effective_from DESC);
-- One approved row per month: the approve path's database backstop (see the header).
CREATE UNIQUE INDEX IF NOT EXISTS ux_dept_kpi_targets_approved
  ON dept_kpi_targets (tenant_id, unit_node_id, kpi_key, effective_from) WHERE status = 'approved';

ALTER TABLE dept_kpi_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dept_kpi_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dept_kpi_targets;
CREATE POLICY tenant_isolation ON dept_kpi_targets FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports'));

COMMENT ON TABLE dept_kpi_targets IS
  'DW-4e-1 — department KPI targets (FRONTEND-BFF-CONTRACT §40.2). The head proposes, the approver approves or '
  'rejects; only an approved row is in force (the latest approved row whose effective_from is on or before the '
  'period start). Percent targets are fractions. Third wall: reports module scope required.';

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_class WHERE relname = 'dept_kpi_targets' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140800: dept_kpi_targets must exist with RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'dept_kpi_targets' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140800: dept_kpi_targets needs exactly one tenant_isolation policy, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'dept_kpi_targets' AND policyname = 'tenant_isolation'
     AND qual LIKE '%app_module_allowed(%reports%' AND with_check LIKE '%app_module_allowed(%reports%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140800: dept_kpi_targets tenant_isolation must carry the reports module wall on USING and WITH CHECK';
  END IF;
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'dept_kpi_targets' AND indexname IN ('ix_dept_kpi_targets_unit_kpi', 'ux_dept_kpi_targets_approved');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610140800: expected both dept_kpi_targets indexes, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'dept_kpi_targets'::regclass AND conname = 'dept_kpi_targets_decided_ck';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140800: dept_kpi_targets_decided_ck is missing';
  END IF;
END $$;
