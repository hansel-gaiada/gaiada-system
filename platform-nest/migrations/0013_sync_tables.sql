-- Sync-engine tables (sync-engine-revision 2026-07-06 §2/§3). Applied against the SAME database
-- as platform-nest (they FK companies(id)); owned operationally by sync-engine-go but kept in
-- this one migration history so there is a single runner (src/db/migrate.ts). outbox_events
-- already exists (0010) + carries the hlc column (0012) — those ARE sync_outbox (D7).

-- Per-peer sync progress. Independent of outbox_events.relayed_at, which is the event-backbone
-- relay's cursor — the two readers never share a cursor (D7). HLC values are the padded
-- "%013d.%010d" text form, so `hlc > last_*_hlc` comparisons are correct as plain text.
CREATE TABLE IF NOT EXISTS sync_cursors (
  node_id text NOT NULL,             -- this node's identity (its mTLS client-cert CN)
  peer_id text NOT NULL,             -- the other side ('central' or a node id)
  last_pushed_hlc text,
  last_pulled_hlc text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, peer_id)
);

-- Replay-dedup ledger (D3 fix #1): idempotency is a lookup on (origin_site, event_id), NEVER a
-- comparison against any row's stored clock. A re-delivered push/pull is a no-op recorded here
-- BEFORE any conflict logic runs. Distinct from relayed_at (G2 fix in the build plan).
CREATE TABLE IF NOT EXISTS sync_applied_events (
  origin_site text NOT NULL,
  event_id uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (origin_site, event_id)
);

-- Every LWW resolution, conflict-queue enqueue, and failover drop lands here — no silent loss
-- (D3 fix #7). Both versions retained. Tenant-scoped -> FORCE RLS like the rest of the schema.
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  field_name text,                   -- null for whole-row conflicts
  resolution text NOT NULL,          -- 'lww' | 'conflict-queue' | 'numeric-merge' | 'max' | 'min' | 'failover-drop'
  winning_event_id uuid,
  losing_event_id uuid,
  winning_payload jsonb,
  losing_payload jsonb,
  reviewed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_unreviewed ON sync_conflicts (tenant_id) WHERE reviewed = false;

-- Events that could not be applied (unknown entity_type, malformed payload, exhausted retries).
CREATE TABLE IF NOT EXISTS sync_dead_letter (
  id uuid PRIMARY KEY,
  outbox_event_id uuid NOT NULL,
  reason text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Central-authoritative, node-immutable ACL (D5): which tenants a node may push/pull, keyed to
-- its mTLS CN — not self-declared by the node. Enforced server-side on every batch. This table
-- IS the authorization source, so it is intentionally NOT under tenant RLS (a node's whole
-- point is to be authorized for a SET of tenants); writes are elevated/central-operator only.
CREATE TABLE IF NOT EXISTS site_subscriptions (
  node_id text NOT NULL,             -- matches the node's mTLS client-cert CN
  tenant_id uuid NOT NULL REFERENCES companies(id),
  PRIMARY KEY (node_id, tenant_id)
);

-- FORCE RLS on the tenant-scoped sync table, mirroring 0010's outbox_events policy exactly.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE sync_conflicts ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE sync_conflicts FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON sync_conflicts';
  EXECUTE 'CREATE POLICY tenant_isolation ON sync_conflicts FOR ALL
    USING (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))
    WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))';
END $$;
