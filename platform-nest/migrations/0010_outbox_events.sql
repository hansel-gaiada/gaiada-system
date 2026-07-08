-- Event backbone outbox (WS1 sub-spec 2026-07-05-ws1-event-backbone.md). This table also
-- IS sync_outbox per the sync-engine revision (2026-07-06-ws1-sync-engine-revision.md §1) —
-- one table, two independent cursor-based readers (this relay, and the future sync engine).
CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  origin_site text NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  relayed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outbox_events_unrelayed ON outbox_events (created_at) WHERE relayed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_events_entity ON outbox_events (tenant_id, entity_type, entity_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON outbox_events';
  EXECUTE 'CREATE POLICY tenant_isolation ON outbox_events FOR ALL
    USING (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))
    WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))';
END $$;
