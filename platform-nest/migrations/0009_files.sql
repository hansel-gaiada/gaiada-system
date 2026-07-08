-- Files / attachments (5c.4). Polymorphic (target_entity_type/id) so any entity — project,
-- task, deliverable, campaign, creative asset — can carry attachments. Bytes live in a
-- storage backend (local-first dir now; object store later) keyed by storage_key; only
-- metadata is in Postgres. scrubbed records whether the day-one PII scrub touched the bytes.
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  uploader_id uuid REFERENCES users(id),
  target_entity_type text NOT NULL,
  target_entity_id uuid NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  byte_size bigint NOT NULL DEFAULT 0,
  storage_key text NOT NULL,
  scrubbed boolean NOT NULL DEFAULT false,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_files_target ON files (tenant_id, target_entity_type, target_entity_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE files ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE files FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON files';
  EXECUTE 'CREATE POLICY tenant_isolation ON files FOR ALL
    USING (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))
    WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))';
END $$;
