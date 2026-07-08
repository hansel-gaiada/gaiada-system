-- Digital-agency module entities (WS1 sub-spec §6). Owned by @modules/agency;
-- schema applies globally, ACCESS is gated by companies.enabled_modules.

CREATE TABLE agency_campaigns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active', -- active | paused | completed
  budget_minor bigint, -- money in minor units (D12 discipline everywhere)
  currency text,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX idx_agency_campaigns_tenant ON agency_campaigns (tenant_id, status);

CREATE TABLE agency_briefs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  campaign_id uuid NOT NULL REFERENCES agency_campaigns(id),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE agency_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  campaign_id uuid NOT NULL REFERENCES agency_campaigns(id),
  subject text NOT NULL, -- what is being approved (creative, budget, brief)
  status text NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  requested_by uuid REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX idx_agency_approvals_pending ON agency_approvals (tenant_id, status) WHERE status = 'pending';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agency_campaigns','agency_briefs','agency_approvals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
       USING (tenant_id = ANY(string_to_array(current_setting(''app.current_tenant_ids'', true), '','')::uuid[]))
       WITH CHECK (tenant_id = ANY(string_to_array(current_setting(''app.current_tenant_ids'', true), '','')::uuid[]))',
      t
    );
  END LOOP;
END $$;
