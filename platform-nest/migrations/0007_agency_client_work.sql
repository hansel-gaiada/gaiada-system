-- Agency client-work entities (5c.2): the agency bills client work, so it needs clients,
-- deliverables owed to those clients, and time logged against deliverables. Money is minor
-- units (D12); billable minutes feed the utilization rollup (5c.5). Tables are agency-owned
-- (schema applies globally; ACCESS gated by companies.enabled_modules).

-- A client is an EXTERNAL customer of the agency tenant — not a platform company/tenant.
CREATE TABLE IF NOT EXISTS agency_clients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  contact_email text,
  status text NOT NULL DEFAULT 'active',   -- active | archived
  custom_fields jsonb NOT NULL DEFAULT '{}',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agency_clients_tenant ON agency_clients (tenant_id, status);

-- A deliverable is a billable unit of work owed to a client, optionally tied to a campaign.
CREATE TABLE IF NOT EXISTS agency_deliverables (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES agency_clients(id),
  campaign_id uuid REFERENCES agency_campaigns(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'todo',      -- todo | in_progress | delivered | accepted
  due_date date,
  rate_minor bigint,                        -- billing rate in minor units (D12)
  currency text,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agency_deliverables_client ON agency_deliverables (tenant_id, client_id, status);
CREATE INDEX IF NOT EXISTS idx_agency_deliverables_campaign ON agency_deliverables (tenant_id, campaign_id);

-- Time logged against a deliverable by a user. Owned by the logger (Cerbos `owns`).
CREATE TABLE IF NOT EXISTS agency_time_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  deliverable_id uuid NOT NULL REFERENCES agency_deliverables(id),
  user_id uuid NOT NULL REFERENCES users(id),
  minutes integer NOT NULL,
  billable boolean NOT NULL DEFAULT true,
  note text NOT NULL DEFAULT '',
  spent_on date NOT NULL DEFAULT current_date,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agency_time_deliverable ON agency_time_entries (tenant_id, deliverable_id);
CREATE INDEX IF NOT EXISTS idx_agency_time_user ON agency_time_entries (tenant_id, user_id, spent_on);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agency_clients','agency_deliverables','agency_time_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
       USING (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))
       WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))',
      t
    );
  END LOOP;
END $$;
