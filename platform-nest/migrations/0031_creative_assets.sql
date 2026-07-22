-- Creative Image Studio — persisted graded assets. Each row is one asset exported from
-- the client-side grading pipeline (platform-ui components/creative + lib/imaging). The
-- finished (graded) bytes live in the storage backend keyed by graded_key; the ORIGINAL
-- bytes are kept (original_key) and the exact grade parameters (the Grade JSON) are stored
-- inline. That combination is the point: any correction is fully REPRODUCIBLE and
-- REVERSIBLE — the non-destructive, auditable contract an ERP needs (re-render the original
-- through the stored grade to get the exact same result; drop the grade to get the original
-- back). Only metadata + the small grade JSON live in Postgres; pixels live in storage,
-- exactly like the files table.
--
-- FORCE RLS composed from the app_current_tenants() helper (0025) — the current house idiom
-- for a core tenant-scoped table (mirrors 0026/0028/0030). No app_module_allowed() wall:
-- the studio is a core creative-department tool, not a gated module.

CREATE TABLE creative_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  uploader_id uuid REFERENCES users(id),
  department_id text,                        -- org-node id (free text, matches projects.department_id / work_activity_links)
  name text NOT NULL,
  content_type text NOT NULL DEFAULT 'image/webp',
  width int,
  height int,
  preset_id text,                            -- 'vivid-warm' | 'product-clean' | 'auto' | 'custom' | ...
  grade jsonb NOT NULL,                      -- the Grade params — the reproducibility record
  original_key text,                         -- storage key of the ORIGINAL (nullable — caller may opt out)
  original_content_type text,
  original_byte_size bigint NOT NULL DEFAULT 0,
  graded_key text NOT NULL,                  -- storage key of the exported graded image
  graded_byte_size bigint NOT NULL DEFAULT 0,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_creative_assets_tenant_created ON creative_assets (tenant_id, created_at DESC);
CREATE INDEX ix_creative_assets_dept ON creative_assets (tenant_id, department_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE creative_assets ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE creative_assets FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON creative_assets FOR ALL
     USING (tenant_id = ANY(app_current_tenants()))
     WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;
