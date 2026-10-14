-- DW-4j-3 (docs/FRONTEND-BFF-CONTRACT.md §43.8; plan docs/plans/2026-10-13-department-workspaces.md §5.5, "A weekly digest"):
-- THE LEDGER OF THE WEEKLY KPI DIGEST. One row per (department, ISO week) the digest has been sent for, so a retried or
-- redelivered run never sends a week twice.
--
--   dept_kpi_digests — the run inserts the row for each department it is about to tell (ON CONFLICT DO NOTHING, under a
--                      per-tenant advisory lock) and sends only for the rows it actually inserted; then it commits and
--                      notifies. A crash between the commit and the send LOSES that notification rather than doubling it.
--
-- ── NOTES ─────────────────────────────────────────────────────────────────────────────────────
--   * `unit_node_id` is an org-blob node id (free text, no FK), the dept_kpi_targets / dept_kpi_conditions convention.
--   * `week_start` is the ISO week's Monday (CHECK: a Monday, so a stray date can never open a second row for one week).
--   * `recipients` is how many heads the notification was addressed to when it was sent (a count, never user ids).
--   * UNIQUE (tenant_id, unit_node_id, week_start): the database's backstop behind the advisory lock.
--   * RLS: the `reports` third wall, exactly as dept_kpi_conditions (202610150200): tenant_id in the request's tenant set AND
--     the `reports` module scope declared, on USING and WITH CHECK, FORCE RLS. `origin_site` has NO default.
--
-- Pure DDL. No Cerbos change (PERMISSION-CONTRACT §38b): the digest reuses report_admin.recompute, the drivers read reuses
-- dept_kpi_target.read.

CREATE TABLE IF NOT EXISTS dept_kpi_digests (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  unit_node_id text NOT NULL CHECK (char_length(unit_node_id) > 0),
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipients integer NOT NULL CHECK (recipients > 0),
  origin_site text NOT NULL,
  CONSTRAINT dept_kpi_digests_uq UNIQUE (tenant_id, unit_node_id, week_start)
);

ALTER TABLE dept_kpi_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dept_kpi_digests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dept_kpi_digests;
CREATE POLICY tenant_isolation ON dept_kpi_digests FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports'));

COMMENT ON TABLE dept_kpi_digests IS
  'DW-4j-3 — the weekly KPI digest ledger (FRONTEND-BFF-CONTRACT §43.8): one row per (department, ISO week) sent, so a retried '
  'run never sends twice. Third wall: reports module scope required.';

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_class WHERE relname = 'dept_kpi_digests' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150400: dept_kpi_digests must exist with RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'dept_kpi_digests' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150400: dept_kpi_digests needs exactly one tenant_isolation policy, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'dept_kpi_digests' AND policyname = 'tenant_isolation'
     AND qual LIKE '%app_module_allowed(%reports%' AND with_check LIKE '%app_module_allowed(%reports%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150400: dept_kpi_digests tenant_isolation must carry the reports module wall on USING and WITH CHECK';
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'dept_kpi_digests' AND column_name = 'origin_site' AND column_default IS NULL AND is_nullable = 'NO';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150400: dept_kpi_digests.origin_site must be NOT NULL with NO default';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'dept_kpi_digests'::regclass AND conname = 'dept_kpi_digests_uq';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150400: dept_kpi_digests_uq is missing';
  END IF;
END $$;
