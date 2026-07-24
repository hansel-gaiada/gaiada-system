-- P2-01 — PM Tags: schema for a per-project tag registry (pm-console-ux-design-spec.md §6, §0).
-- Additive, backward-compatible: a fresh table + one new column with a default, no existing data
-- is touched. Mirrors the pm_* table shape from 0018_pm.sql (origin_site, created/updated/deleted_at)
-- and is FORCE-RLS'd directly off the 0025 app_current_tenants() helper (same pattern as every
-- pm_* table after the 0025 re-point) — no separate re-point migration needed for a brand-new table.

-- Per-project tag registry. `color` is a closed slug set (the UI's 8-swatch palette from the
-- design spec) — NOT a hex value, so re-theming the palette later is a UI-only change.
CREATE TABLE pm_project_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  label text NOT NULL,
  color text NOT NULL CHECK (color IN ('bronze','champagne','olive','slate','clay','moss','dust','ink')),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX pm_project_tags_project_idx ON pm_project_tags (project_id) WHERE deleted_at IS NULL;

-- Task <-> tag membership. References tag ids WITHIN THE SAME PROJECT; enforced app-side on
-- PATCH (pm.controller.ts validates every incoming id against this project's pm_project_tags
-- before persisting — no DB FK on array elements, same convention as pm_tasks.depends_on).
-- Additive: existing tasks get '{}' via the column default, nothing to backfill.
ALTER TABLE pm_tasks ADD COLUMN tags uuid[] NOT NULL DEFAULT '{}';

-- FORCE RLS + tenant_isolation, composed from app_current_tenants() (0025 helper) — same pattern
-- as every other pm_* table and integration_connections (0033).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE pm_project_tags ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE pm_project_tags FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON pm_project_tags FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;
