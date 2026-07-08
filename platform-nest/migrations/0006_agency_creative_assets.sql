-- Agency module completeness (5c.1): creative assets + brief body fields. Creative assets
-- are the reviewable deliverables of a campaign (designs, copy, video), each moving through
-- a review state that the approval workflow acts on.
CREATE TABLE IF NOT EXISTS agency_creative_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  campaign_id uuid NOT NULL REFERENCES agency_campaigns(id),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'design',       -- design | copy | video | other
  media_ref text,                             -- storage ref (files service, 5c.4)
  review_status text NOT NULL DEFAULT 'draft', -- draft | in_review | approved | rejected
  custom_fields jsonb NOT NULL DEFAULT '{}',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agency_assets_campaign ON agency_creative_assets (tenant_id, campaign_id, review_status);

-- Approvals can target a specific creative asset (nullable keeps existing subject-only rows valid).
ALTER TABLE agency_approvals ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES agency_creative_assets(id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agency_creative_assets') THEN
    EXECUTE 'ALTER TABLE agency_creative_assets ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE agency_creative_assets FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON agency_creative_assets';
    EXECUTE 'CREATE POLICY tenant_isolation ON agency_creative_assets FOR ALL
      USING (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))
      WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))';
  END IF;
END $$;
