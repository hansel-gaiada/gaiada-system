-- P3-01 — pm_templates: reusable task/doc templates for the PM console.
-- A tenant-scoped registry of two payload kinds, validated app-side by
-- pm.controller.ts's validateTemplatePayload():
--   kind='task' -> {title, description?, priority?, estimateMinutes?, subtasks?: string[], tagLabels?: string[]}
--   kind='doc'  -> {title, body}
-- Mirrors the pm_* table shape (origin_site, created/updated/deleted_at) and is FORCE-RLS'd
-- directly off the 0025 app_current_tenants() helper — same pattern as pm_project_tags (0036) /
-- pm_project_statuses (0038) / pm_progress_snapshots (0040). Brand-new table, no re-point needed.
CREATE TABLE pm_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL CHECK (kind IN ('task', 'doc')),
  name text NOT NULL,
  payload jsonb NOT NULL,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX pm_templates_tenant_kind_idx ON pm_templates (tenant_id, kind) WHERE deleted_at IS NULL;

-- FORCE RLS + tenant_isolation, composed from app_current_tenants() (0025 helper).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE pm_templates ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE pm_templates FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON pm_templates FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;
