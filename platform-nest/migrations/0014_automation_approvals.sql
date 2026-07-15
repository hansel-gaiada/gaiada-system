-- WS4 §3 / D14: automation approvals suspension surface. When the mcp-hub write gate refuses a
-- medium+/unclassified write for an n8n automation principal (policy.ts returns a `suspend:` reason),
-- the workflow records the intended action here instead of performing it. A human then decides it
-- from the platform-ui approvals inbox. This is the durable artifact of the "suspend for human
-- approval" rule — a dedicated store (NOT the agency_approvals table, which is campaign/asset-bound).
--
-- Resumption (re-driving the approved tool call) is deliberately out of v1's n8n scope — it is a
-- Temporal/durable-workflow concern (spec §1 defers Temporal). v1 delivers the auditable record +
-- decision; the approved row is what a future resume step reads.

CREATE TABLE automation_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  workflow_id text NOT NULL,                 -- the OBO external id, e.g. 'wf:new-client-seed'
  tool_name text NOT NULL,                    -- the hub tool the workflow was refused (e.g. 'money.transfer')
  tool_args jsonb NOT NULL DEFAULT '{}',      -- the arguments it intended to call with
  impact text NOT NULL DEFAULT 'unclassified' CHECK (impact IN ('medium','high','unclassified')),
  reason text,                                -- the hub's `suspend:` reason (why it needs a human)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid REFERENCES users(id),     -- the automation service user (from the OBO principal)
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX automation_approvals_pending_idx ON automation_approvals (tenant_id, status) WHERE deleted_at IS NULL;

-- FORCE RLS + authorized-tenant-set isolation (mirrors 0001 / 0011).
ALTER TABLE automation_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_approvals FOR ALL
  USING (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')::uuid[]));
