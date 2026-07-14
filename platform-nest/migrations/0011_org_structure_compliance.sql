-- Phase B admin backend: per-company org structure (JSON blob) + compliance-gate status.
-- Both tenant-scoped with FORCE RLS on the authorized-tenant-set (D5), like 0001's tables.

-- One org-structure blob per company (company → departments → teams/roles/people).
-- Sanitized/validated at the app layer (bounded node-count + depth); stored as JSONB.
CREATE TABLE company_org_structure (
  tenant_id uuid PRIMARY KEY REFERENCES companies(id),
  structure jsonb NOT NULL,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Per-tenant status of the launch compliance gates (template lives in the app layer;
-- only status + evidence override is persisted, keyed by the stable gate key).
CREATE TABLE compliance_gates (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  key text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','passed','waived')),
  evidence_url text,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- FORCE RLS + authorized-tenant-set isolation (mirrors 0001).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_org_structure','compliance_gates'] LOOP
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
