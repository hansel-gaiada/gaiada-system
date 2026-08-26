-- WSK-00 - the tenancy wall, minimal but shaped exactly like design v1.1 section 04.
-- Roles mirror the estate DB-topology doctrine: owner / migrator / app(NOBYPASSRLS).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'webdesk_migrator') THEN
    CREATE ROLE webdesk_migrator LOGIN PASSWORD 'spike_migrator_pw' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'webdesk_app') THEN
    CREATE ROLE webdesk_app LOGIN PASSWORD 'spike_app_pw' NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS tenants (
  id   uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS content_items (
  id        uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title     text NOT NULL
);

-- FORCE so even the table owner is subject to the policy.
ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON content_items;
CREATE POLICY tenant_isolation ON content_items
  USING      (tenant_id = nullif(current_setting('webdesk.tenant_ctx', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('webdesk.tenant_ctx', true), '')::uuid);
-- current_setting(..., true) returns NULL when unset -> comparison is NULL -> ZERO ROWS.
-- That is the fail-closed property. It must never raise instead of returning empty.

GRANT USAGE ON SCHEMA public TO webdesk_app, webdesk_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON content_items TO webdesk_app;
GRANT SELECT ON tenants TO webdesk_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO webdesk_migrator;

-- seed: two tenants, two rows each
INSERT INTO tenants (id, slug) VALUES
  ('11111111-1111-1111-1111-111111111111', 'acme'),
  ('22222222-2222-2222-2222-222222222222', 'globex')
ON CONFLICT DO NOTHING;

INSERT INTO content_items (id, tenant_id, title) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'ACME page one'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'ACME page two'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'GLOBEX page one'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'GLOBEX page two')
ON CONFLICT DO NOTHING;
