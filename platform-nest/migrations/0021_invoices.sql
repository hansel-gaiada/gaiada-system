-- Billing / invoicing (BFF §4, platform-ui lib/billing.ts): turn billable time into invoices.
-- An invoice is generated for a client over a period at an hourly rate; its line items are
-- computed at creation from billable time_entries on that client's projects and frozen as JSONB.
CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid REFERENCES clients(id),
  period_start date,
  period_end date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','void')),
  currency text NOT NULL DEFAULT 'USD',
  lines jsonb NOT NULL DEFAULT '[]',   -- InvoiceLine[] {description,hours,rate,amount}
  total numeric NOT NULL DEFAULT 0,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX invoices_tenant_idx ON invoices (tenant_id) WHERE deleted_at IS NULL;

-- FORCE RLS + authorized-tenant-set isolation (mirrors 0001/0011/0017/0018/0019).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices'] LOOP
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
