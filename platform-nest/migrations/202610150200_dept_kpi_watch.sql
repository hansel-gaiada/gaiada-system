-- DW-4j-1 (docs/FRONTEND-BFF-CONTRACT.md §43.3 and §43.5; plan docs/plans/2026-10-13-department-workspaces.md §5.5, "How the
-- HOD is made aware"): THE MEMORY OF THE KPI WATCH. The §40 engine computes a department's condition on read and
-- remembers nothing, so nothing could say "it changed". Two tables:
--
--   dept_kpi_conditions — the last condition the scheduled run saw, one row per (unit, KPI) plus one per unit for the
--                         department's own condition. It is a memory, not a history (the history is recomputed on read,
--                         as §41 does). The run reads it, decides what changed, and overwrites it.
--   dept_kpi_alerts     — the Needs-you source: one OPEN alert per (unit, KPI) while the KPI is off track. A state, not
--                         a change: the run opens it and resolves it. A head acknowledges it ("seen"), which does not
--                         close it. An alert is never deleted.
--
-- ── NOTES ─────────────────────────────────────────────────────────────────────────────────────
--   * `unit_node_id` is an org-blob node id (free text, no FK), the dept_kpi_targets convention.
--   * `kpi_key` of dept_kpi_conditions is the KPI's key, or the sentinel '*' for the department's own condition. It is NOT
--     NULL on purpose: a NULL defeats a UNIQUE constraint (memory null-defeats-unique-constraints), so a nullable key
--     would let two "department" rows for one unit coexist. The alerts' kpi_key is always a real KPI (CHECK <> '*').
--   * `condition` and `resolved_condition` use the engine's four codes (on_track, at_risk, off_track, unavailable);
--     `reason` is the engine's reason for an unavailable KPI (no_reader, no_data, no_target), NULL otherwise.
--   * `value` and `target` are the numbers the engine read when the row was written (a percent is a fraction, 0.85 = 85%);
--     NULL for the department row and for a KPI with no value or no target.
--   * `changed_at` moves only when the condition changes; `evaluated_at` moves on every run.
--   * Acknowledged and resolved are each whole or absent (CHECK): who and when together, the resolving condition and the
--     time together. A resolved alert may have been acknowledged or not; an unresolved one may be acknowledged.
--   * One open alert per (tenant, unit, KPI): the partial unique index. The run serialises under a per-tenant advisory
--     lock; the index is the database's backstop if a future writer forgets the lock.
--   * RLS: the `reports` third wall, exactly as dept_kpi_targets (202610140800): tenant_id in the request's tenant set AND
--     the `reports` module scope declared, on USING and WITH CHECK, FORCE RLS. `origin_site` has NO default.
--
-- Pure DDL. No Cerbos change (PERMISSION-CONTRACT §38b): the run reuses report_admin.recompute, the alerts reuse
-- dept_kpi_target.read.

CREATE TABLE IF NOT EXISTS dept_kpi_conditions (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  unit_node_id text NOT NULL CHECK (char_length(unit_node_id) > 0),
  kpi_key text NOT NULL CHECK (char_length(kpi_key) BETWEEN 1 AND 100),
  period_start date NOT NULL,
  condition text NOT NULL CHECK (condition IN ('on_track', 'at_risk', 'off_track', 'unavailable')),
  reason text CHECK (reason IS NULL OR reason IN ('no_reader', 'no_data', 'no_target')),
  value numeric,
  target numeric,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL,
  CONSTRAINT dept_kpi_conditions_uq UNIQUE (tenant_id, unit_node_id, kpi_key)
);

CREATE TABLE IF NOT EXISTS dept_kpi_alerts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  unit_node_id text NOT NULL CHECK (char_length(unit_node_id) > 0),
  kpi_key text NOT NULL CHECK (char_length(kpi_key) BETWEEN 1 AND 100 AND kpi_key <> '*'),
  opened_at timestamptz NOT NULL DEFAULT now(),
  period_start date NOT NULL,
  value numeric,
  target numeric,
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  ack_note text CHECK (ack_note IS NULL OR char_length(ack_note) <= 1000),
  resolved_at timestamptz,
  resolved_condition text CHECK (resolved_condition IS NULL OR resolved_condition IN ('on_track', 'at_risk', 'off_track', 'unavailable')),
  origin_site text NOT NULL,
  CONSTRAINT dept_kpi_alerts_ack_whole_ck CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL)),
  CONSTRAINT dept_kpi_alerts_resolved_whole_ck CHECK ((resolved_at IS NULL) = (resolved_condition IS NULL))
);

-- One OPEN alert per (unit, KPI): the run's database backstop (see the header).
CREATE UNIQUE INDEX IF NOT EXISTS ux_dept_kpi_alerts_open
  ON dept_kpi_alerts (tenant_id, unit_node_id, kpi_key) WHERE resolved_at IS NULL;
-- The unit's alert history (newest first) and the Needs-you read (open alerts of a few units).
CREATE INDEX IF NOT EXISTS ix_dept_kpi_alerts_unit
  ON dept_kpi_alerts (tenant_id, unit_node_id, opened_at DESC);

ALTER TABLE dept_kpi_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dept_kpi_conditions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dept_kpi_conditions;
CREATE POLICY tenant_isolation ON dept_kpi_conditions FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports'));

ALTER TABLE dept_kpi_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dept_kpi_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dept_kpi_alerts;
CREATE POLICY tenant_isolation ON dept_kpi_alerts FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports'));

COMMENT ON TABLE dept_kpi_conditions IS
  'DW-4j-1 — the last KPI condition the scheduled watch saw (FRONTEND-BFF-CONTRACT §43.3): one row per (unit, KPI), '
  'kpi_key ''*'' for the department''s own condition. A memory, not a history. Third wall: reports module scope required.';
COMMENT ON TABLE dept_kpi_alerts IS
  'DW-4j-1 — off-track KPI alerts (FRONTEND-BFF-CONTRACT §43.5): opened and resolved by the scheduled watch, acknowledged '
  'by a head; one open alert per (unit, KPI); never deleted. Third wall: reports module scope required.';

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  n integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['dept_kpi_conditions', 'dept_kpi_alerts'] LOOP
    SELECT count(*) INTO n FROM pg_class WHERE relname = t AND relrowsecurity AND relforcerowsecurity;
    IF n <> 1 THEN
      RAISE EXCEPTION '202610150200: % must exist with RLS ENABLED and FORCED', t;
    END IF;
    SELECT count(*) INTO n FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation';
    IF n <> 1 THEN
      RAISE EXCEPTION '202610150200: % needs exactly one tenant_isolation policy, found %', t, n;
    END IF;
    SELECT count(*) INTO n FROM pg_policies
     WHERE tablename = t AND policyname = 'tenant_isolation'
       AND qual LIKE '%app_module_allowed(%reports%' AND with_check LIKE '%app_module_allowed(%reports%';
    IF n <> 1 THEN
      RAISE EXCEPTION '202610150200: % tenant_isolation must carry the reports module wall on USING and WITH CHECK', t;
    END IF;
    SELECT count(*) INTO n FROM information_schema.columns
     WHERE table_name = t AND column_name = 'origin_site' AND column_default IS NULL AND is_nullable = 'NO';
    IF n <> 1 THEN
      RAISE EXCEPTION '202610150200: %.origin_site must be NOT NULL with NO default', t;
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'dept_kpi_conditions'::regclass AND conname = 'dept_kpi_conditions_uq';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150200: dept_kpi_conditions_uq is missing';
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'dept_kpi_conditions' AND column_name = 'kpi_key' AND is_nullable = 'NO';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150200: dept_kpi_conditions.kpi_key must be NOT NULL (NULL defeats the unique key)';
  END IF;
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'dept_kpi_alerts' AND indexname IN ('ux_dept_kpi_alerts_open', 'ix_dept_kpi_alerts_unit');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610150200: expected both dept_kpi_alerts indexes, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'dept_kpi_alerts' AND indexname = 'ux_dept_kpi_alerts_open'
     AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%resolved_at IS NULL%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610150200: ux_dept_kpi_alerts_open must be a UNIQUE partial index WHERE resolved_at IS NULL';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'dept_kpi_alerts'::regclass AND conname IN ('dept_kpi_alerts_ack_whole_ck', 'dept_kpi_alerts_resolved_whole_ck');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610150200: expected both dept_kpi_alerts whole-half CHECKs, found %', n;
  END IF;
END $$;
