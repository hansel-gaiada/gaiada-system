-- IT department subsystem (BFF §6, platform-ui lib/it.ts): device registry + status events.
-- Devices are readable by any member; register/edit is elevated / IT-role only (Cerbos is the
-- boundary). Heartbeat ingest (agents → POST .../heartbeat) is backend-only; the UI reads.

CREATE TABLE it_devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'other'
    CHECK (kind IN ('cctv','printer','server','workstation','network','sensor','iot','other')),
  status text NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('online','offline','degraded','unknown')),
  site text,
  network text,
  ip text,
  mac text,
  vendor text,
  model text,
  firmware text,
  labels text[] NOT NULL DEFAULT '{}',
  heartbeats integer[] NOT NULL DEFAULT '{}', -- recent reachability/latency series (sparkline)
  last_heartbeat_at timestamptz,
  uptime_sec bigint,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), -- registeredAt
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX it_devices_tenant_idx ON it_devices (tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE it_device_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  device_id uuid NOT NULL REFERENCES it_devices(id),
  type text NOT NULL
    CHECK (type IN ('registered','online','offline','degraded','alert','heartbeat')),
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','critical')),
  message text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL
);
CREATE INDEX it_device_events_device_idx ON it_device_events (device_id, occurred_at DESC);
CREATE INDEX it_device_events_tenant_idx ON it_device_events (tenant_id, occurred_at DESC);

-- FORCE RLS + authorized-tenant-set isolation (mirrors 0001/0011/0017/0018).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['it_devices','it_device_events'] LOOP
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
