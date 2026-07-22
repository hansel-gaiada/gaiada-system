-- ORG-CORE ORG-1 / amendment A15 — RLS empty-set hardening.
--
-- Renumbered from 0023 by WS0-1 (2026-07-22): 0023 was consumed out-of-band by
-- 0023_meeting_recordings.sql and 0024 by 0024_module_backfill.sql, both merged before this
-- ticket started (see migrations/README.md).
--
-- PROBLEM (5b.4 class, re-introduced by post-0004 migrations): a tenant_isolation policy written
-- as `current_setting('app.current_tenant_ids', true)::…` casts the empty string to uuid[] when the
-- GUC is unset OR is COMPUTED to empty (the org-core feature introduces computed, possibly-empty
-- tenant sets). `''` → cast error, which fails the whole query instead of returning zero rows.
-- The 0004 fix wrapped the setting in NULLIF(...,'') so empty → NULL → string_to_array(NULL) → NULL
-- → `= ANY(NULL)` → false → zero rows (fail-closed). Migrations 0011/0014/0017 shipped WITHOUT that
-- guard; 0018_pm/0019/0021 shipped WITH an inline NULLIF already (the design doc's "verified missing"
-- note for those three is stale — see the completion report). This migration unifies ALL SIX behind
-- ONE helper so the guard can never drift per-table again (A15 / C-graft).
--
-- A15 constraints honored:
--   * app_current_tenants() is LANGUAGE sql STABLE PARALLEL SAFE returning uuid[] → inlinable, and
--     (no-arg STABLE) evaluated once per scan, never per row.
--   * EXECUTE granted to PUBLIC so every runtime role (platform_app, sync_app, test roles) can use
--     it — sync-engine-go sets the same GUC through its own withTenants port under sync_app.
--   * Re-points ONLY the six named migrations' tables. Legacy-correct policies (0001/0004/0013) are
--     left untouched to avoid an estate-wide policy churn shared with the sync engine.
-- Additive + idempotent: DROP POLICY IF EXISTS then CREATE; safe to re-run, no behavior change for
-- any current single-tenant call site.

-- ── The single source of truth for the authorized-tenant set ────────────────────────────────────
CREATE OR REPLACE FUNCTION app_current_tenants() RETURNS uuid[]
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]
  $$;
COMMENT ON FUNCTION app_current_tenants() IS
  'Authorized-tenant-set from the app.current_tenant_ids GUC, empty/unset -> NULL (fail-closed). '
  'Inlinable STABLE helper shared by every tenant_isolation policy created from 0025 onward, and by '
  'the sync engine (same GUC contract).';
-- Explicit even though SQL functions default to PUBLIC EXECUTE — makes the sync_app dependency
-- (A15) an on-purpose, reviewable grant rather than an implicit default.
GRANT EXECUTE ON FUNCTION app_current_tenants() TO PUBLIC;

-- ── Re-point the six NULLIF-missing migrations' tenant_isolation policies at the helper ───────────
-- 0011: company_org_structure, compliance_gates   (shipped WITHOUT the guard)
-- 0014: automation_approvals                       (shipped WITHOUT the guard)
-- 0017: pipeline_runs, pipeline_stages, pipeline_gates, scope_signoffs (shipped WITHOUT the guard)
-- 0018_pm: pm_project_meta, pm_milestones, pm_tasks, pm_docs, pm_suggestions (had inline NULLIF)
-- 0019: it_devices, it_device_events               (had inline NULLIF)
-- 0021: invoices                                    (had inline NULLIF)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company_org_structure','compliance_gates',
    'automation_approvals',
    'pipeline_runs','pipeline_stages','pipeline_gates','scope_signoffs',
    'pm_project_meta','pm_milestones','pm_tasks','pm_docs','pm_suggestions',
    'it_devices','it_device_events',
    'invoices'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()))
         WITH CHECK (tenant_id = ANY(app_current_tenants()))',
        t
      );
    END IF;
  END LOOP;
END $$;
