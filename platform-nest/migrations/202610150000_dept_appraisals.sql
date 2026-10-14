-- DW-4e-3 (docs/FRONTEND-BFF-CONTRACT.md §41.2; plan docs/plans/2026-10-13-department-workspaces.md §5.3 and §5.5, owner
-- ruling DW-Q4): THE DEPARTMENT APPRAISAL PER CYCLE. For one appraisal cycle and one department: the head's commentary
-- and the GM's assessment (with the GM's own judged condition). Everything else the appraisal shows (the KPIs over the
-- cycle, the condition history, the people aggregate) is computed on read from the §40 engine and report_appraisals;
-- nothing is snapshotted here.
--
--   dept_appraisals — one row per (tenant, cycle, unit), created on the FIRST write (a read with no row returns null
--                     commentary and assessment). The head's half (hod_*) and the GM's half (gm_*) are written by
--                     different people at different times, so each half carries its own author and time.
--
-- ── NOTES ─────────────────────────────────────────────────────────────────────────────────────
--   * `unit_node_id` is an org-blob node id (free text, no FK): the dept_kpi_targets / projects.department_id
--     convention. The application validates it against the tenant's org tree before writing.
--   * `cycle_id` is a TENANT-SCOPED composite FK to report_appraisal_cycles (0068 declares UNIQUE (id, tenant_id) on it),
--     so a row can never carry tenant A's tenant_id against tenant B's cycle. ON DELETE CASCADE, as report_appraisals.
--   * `gm_condition` is the GM's JUDGEMENT, shown beside the computed condition and never replacing it. Three values
--     (the engine's non-unavailable conditions), nullable until the GM writes.
--   * Each half is all-or-nothing: the text with its author and time, or none of them (CHECK). `gm_assessment` and
--     `gm_condition` come together.
--   * Writes end when the cycle is `closed` (409 `cycle_closed`): that is the service's rule, not a constraint, because
--     the cycle's status lives on another table and changes after the rows are written.
--   * `id` is the row's identity for the activity log; the contract's natural key is the unique (tenant, cycle, unit).
--   * RLS: the `reports` third wall, exactly as dept_kpi_targets (202610140800): tenant_id in the request's tenant set
--     AND the `reports` module scope declared, on USING and WITH CHECK. `origin_site` has NO default (0068 ruling 1).
--
-- Pure DDL. The two actions' permission seed is the NEXT migration (202610150100).

CREATE TABLE IF NOT EXISTS dept_appraisals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  cycle_id uuid NOT NULL,
  unit_node_id text NOT NULL CHECK (char_length(unit_node_id) > 0),
  hod_commentary text CHECK (hod_commentary IS NULL OR char_length(hod_commentary) BETWEEN 1 AND 4000),
  hod_by uuid REFERENCES users(id),
  hod_at timestamptz,
  gm_assessment text CHECK (gm_assessment IS NULL OR char_length(gm_assessment) BETWEEN 1 AND 4000),
  gm_condition text CHECK (gm_condition IS NULL OR gm_condition IN ('on_track', 'at_risk', 'off_track')),
  gm_by uuid REFERENCES users(id),
  gm_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dept_appraisals_cycle_unit_uq UNIQUE (tenant_id, cycle_id, unit_node_id),
  CONSTRAINT fk_dept_appraisals_cycle_tenant
    FOREIGN KEY (cycle_id, tenant_id) REFERENCES report_appraisal_cycles (id, tenant_id) ON DELETE CASCADE,
  -- each half is whole or absent: text + author + time together
  CONSTRAINT dept_appraisals_hod_whole_ck
    CHECK ((hod_commentary IS NULL) = (hod_by IS NULL) AND (hod_commentary IS NULL) = (hod_at IS NULL)),
  CONSTRAINT dept_appraisals_gm_whole_ck
    CHECK ((gm_assessment IS NULL) = (gm_condition IS NULL) AND (gm_assessment IS NULL) = (gm_by IS NULL)
           AND (gm_assessment IS NULL) = (gm_at IS NULL))
);

ALTER TABLE dept_appraisals ENABLE ROW LEVEL SECURITY;
ALTER TABLE dept_appraisals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dept_appraisals;
CREATE POLICY tenant_isolation ON dept_appraisals FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports'));

COMMENT ON TABLE dept_appraisals IS
  'DW-4e-3 — the department appraisal per cycle (FRONTEND-BFF-CONTRACT §41.2): the head''s commentary and the GM''s '
  'assessment for one (cycle, unit). Numbers are computed on read, never stored here. Writes end when the cycle is '
  'closed. Third wall: reports module scope required.';

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_class WHERE relname = 'dept_appraisals' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150000: dept_appraisals must exist with RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'dept_appraisals' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150000: dept_appraisals needs exactly one tenant_isolation policy, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'dept_appraisals' AND policyname = 'tenant_isolation'
     AND qual LIKE '%app_module_allowed(%reports%' AND with_check LIKE '%app_module_allowed(%reports%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150000: dept_appraisals tenant_isolation must carry the reports module wall on USING and WITH CHECK';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'dept_appraisals'::regclass
     AND conname IN ('dept_appraisals_cycle_unit_uq', 'fk_dept_appraisals_cycle_tenant',
                     'dept_appraisals_hod_whole_ck', 'dept_appraisals_gm_whole_ck');
  IF n <> 4 THEN
    RAISE EXCEPTION '202610150000: expected the unique, the tenant-scoped cycle FK and both whole-half CHECKs, found % of 4', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'dept_appraisals'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%on_track%'
     AND pg_get_constraintdef(oid) LIKE '%at_risk%' AND pg_get_constraintdef(oid) LIKE '%off_track%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150000: dept_appraisals.gm_condition CHECK (on_track|at_risk|off_track) is missing';
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'dept_appraisals' AND column_name = 'origin_site' AND column_default IS NULL AND is_nullable = 'NO';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150000: dept_appraisals.origin_site must be NOT NULL with NO default';
  END IF;
END $$;
