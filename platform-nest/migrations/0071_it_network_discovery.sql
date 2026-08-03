-- IT-01 — network discovery + device registry, schema half.
-- Design: docs/superpowers/specs/2026-08-03-it-network-discovery-design.md
--
-- WHY: IT > Topology could never show the real network. `buildTopology()` grouped it_devices by two
-- FREE-TEXT strings (site, network) with no uplink data, and nothing ever populated the table —
-- codebase-wide grep for UniFi/SNMP/ARP/mDNS discovery returned zero hits, so the only rows were
-- 8 hand-seeded fictions on a 10.0.x.x range that does not exist in the office. Measured reality
-- (2026-08-03, office SSID GDA): 10.10.0.0/22, ~58 live hosts behind a UniFi OS gateway.
--
-- This migration adds the columns/tables discovery needs. The collector itself lives outside the
-- ERP (it-site-collector) because the ERP CANNOT REACH the controller: 10.10.0.1 is RFC1918 behind
-- office NAT and `curl` from gda-aicenter returns HTTP 000 (verified). Discovery is therefore
-- push-based, and this schema is written to be fed by an untrusted-network agent, not a poller.
--
-- ─── TWO MEASURED FACTS THAT DICTATE THE KEY CHOICES BELOW ───────────────────────────────────────
-- 1) MAC IS NOT A STABLE IDENTITY. ~60% of the 58 observed MACs have the locally-administered bit
--    set (iOS/Android/macOS private Wi-Fi randomization). Keying upserts on MAC would manufacture a
--    brand-new "device" every time a phone rotates its address, so the unique key below is
--    `external_id` (UniFi's own stable client id) and MAC is descriptive only. `mac` deliberately
--    gets NO unique constraint.
-- 2) ICMP UNDERCOUNTS 5×. Only 12 of 58 hosts answer ping. Liveness must come from the controller's
--    own client table (last_seen_at, §derived status), never from a reachability probe.

-- ─── 1) it_devices — additive columns ────────────────────────────────────────────────────────────
-- `status` intentionally keeps its existing CHECK and its 4 values. It becomes a DERIVED column
-- (computed from last_seen_at freshness by the reaper in src/modules/it/discovery.service.ts); the
-- collector never writes it directly. That is what fixes the "registered devices are permanently
-- unknown" dead-end — nothing ever called the heartbeat endpoint, so every manually-added row sat
-- at the DB default 'unknown' forever and rendered as a grey tile.
ALTER TABLE it_devices
  ADD COLUMN discovery_source text NOT NULL DEFAULT 'manual'
    CHECK (discovery_source IN ('manual', 'unifi')),
  -- Classification gate. Only 'infrastructure' + 'managed' are persisted as rows by the collector;
  -- 'byod' is reduced to an aggregate count on it_discovery_runs. This is a PRIVACY control, not a
  -- taxonomy nicety: ~25 of the 58 observed hosts are personal phones whose hostnames directly name
  -- staff (Ratihs-iPhone, A56-milik-Tini, iphone-claraay, ...), so persisting them with MAC plus
  -- per-poll timestamps would build a continuous presence log of named employees on their own
  -- devices. CLAUDE.md forbids ingesting real employee data before legal Gate 1, and legal/ carries
  -- the DPIA/LIA discipline this would trip. The column exists so a future opt-in has somewhere to
  -- land; the default posture is deny.
  ADD COLUMN device_class text NOT NULL DEFAULT 'managed'
    CHECK (device_class IN ('infrastructure', 'managed', 'byod')),
  ADD COLUMN external_id text,        -- UniFi stable client/device id. NOT the MAC (see fact 1).
  ADD COLUMN hostname text,           -- as reported by the controller; may differ from `name`
  ADD COLUMN is_wired boolean,
  ADD COLUMN ssid text,               -- NULL for wired clients and for infrastructure
  ADD COLUMN uplink_mac text,         -- parent AP/switch MAC as reported, before link resolution
  ADD COLUMN uplink_port integer,     -- switch port when wired
  ADD COLUMN first_seen_at timestamptz,
  ADD COLUMN last_seen_at timestamptz,
  -- Operator edits that must SURVIVE the next poll. A discovered row's descriptive columns are
  -- owned by the collector and rewritten every interval; without this layer any human correction
  -- would silently revert ~5 minutes later, which reads as "the edit button is broken".
  ADD COLUMN overrides jsonb NOT NULL DEFAULT '{}';

-- Upsert key for discovered rows. Partial so manual rows (external_id NULL) are unconstrained and
-- so a soft-deleted row does not block re-discovery of the same device.
CREATE UNIQUE INDEX it_devices_external_uniq
  ON it_devices (tenant_id, external_id)
  WHERE discovery_source = 'unifi' AND external_id IS NOT NULL AND deleted_at IS NULL;

-- Drives the stale-reaper sweep and the "last seen" sort in the devices table.
CREATE INDEX it_devices_last_seen_idx
  ON it_devices (tenant_id, last_seen_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX it_devices_class_idx
  ON it_devices (tenant_id, device_class)
  WHERE deleted_at IS NULL;

-- ─── 2) it_device_links — the real topology edge set ─────────────────────────────────────────────
-- Edges are stored as rows rather than derived from uplink_mac at read time so the graph survives
-- MAC randomization, hostname churn and IP reassignment: the link points at resolved device ids.
-- One uplink per child (a client is attached to exactly one AP or switch port at a time), hence the
-- unique index on child rather than on the pair.
CREATE TABLE it_device_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  child_device_id uuid NOT NULL REFERENCES it_devices(id),
  parent_device_id uuid NOT NULL REFERENCES it_devices(id),
  port integer,
  medium text NOT NULL DEFAULT 'unknown' CHECK (medium IN ('wired', 'wireless', 'unknown')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL,
  CONSTRAINT it_device_links_no_self CHECK (child_device_id <> parent_device_id)
);
CREATE UNIQUE INDEX it_device_links_child_uniq ON it_device_links (tenant_id, child_device_id);
CREATE INDEX it_device_links_parent_idx ON it_device_links (tenant_id, parent_device_id);

-- ─── 3) it_discovery_runs — audit + staleness signal ─────────────────────────────────────────────
-- Without this table a dead collector is INDISTINGUISHABLE from an empty network: both render an
-- empty map. The UI reads the latest row to show "last synced N min ago" and to raise a stale
-- banner, so silence is never mistaken for "no devices". byod_count is how BYOD is surfaced at all
-- under the §privacy posture above — an aggregate, with no per-device row.
CREATE TABLE it_discovery_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  source text NOT NULL DEFAULT 'unifi' CHECK (source IN ('unifi')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok boolean NOT NULL DEFAULT false,
  devices_seen integer NOT NULL DEFAULT 0,
  devices_upserted integer NOT NULL DEFAULT 0,
  byod_count integer NOT NULL DEFAULT 0,
  error text,
  origin_site text NOT NULL
);
CREATE INDEX it_discovery_runs_tenant_idx ON it_discovery_runs (tenant_id, started_at DESC);

-- ─── 4) FORCE RLS on the new tables ─────────────────────────────────────────────────────────────
-- Matches the shape 0025_rls_empty_set_hardening.sql left it_devices/it_device_events in:
-- app_current_tenants() (which NULLIFs the empty string, so an unset GUC yields the empty set
-- rather than a NULL comparison), no module gate — consistent with its siblings.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['it_device_links', 'it_discovery_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()))
         WITH CHECK (tenant_id = ANY(app_current_tenants()))',
      t
    );
  END LOOP;
END $$;

-- ─── 5) Backfill: classify + seed the freshness clock on existing rows ──────────────────────────
--
-- RLS: THIS BLOCK MUST STAY WRAPPED PER TENANT. Migrations run as platform_owner
-- (MIGRATE_DATABASE_URL), which deliberately has NO BYPASSRLS (db-topology-roles). it_devices
-- carries FORCE ROW LEVEL SECURITY (0019, rewritten by 0025), and app.current_tenant_ids is UNSET
-- during a migration — so an unwrapped UPDATE here would match ZERO rows, raise no error, and still
-- be recorded as applied. 0050_pm_short_codes.sql shipped exactly that bug. scripts/
-- lint-migration-rls.mjs enforces the wrapping for 0052+; do not remove the set_config call.
--
-- The rule: `kind = 'network'` is the switch/router/AP tier, so it classifies as infrastructure;
-- everything else stays 'managed' (the column default), which is correct for the existing rows —
-- all of them are hand-registered company assets, and the collector is the only thing that will
-- ever write 'byod'. last_seen_at is seeded from the best evidence already on the row so the
-- IT-03 reaper has a defined starting point instead of sweeping every legacy row to 'offline' on
-- its first pass; COALESCE to created_at because last_heartbeat_at is NULL for anything registered
-- through the UI (the heartbeat endpoint was never called by anything).
DO $$
DECLARE co RECORD;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    UPDATE it_devices
       SET device_class  = CASE WHEN kind = 'network' THEN 'infrastructure' ELSE 'managed' END,
           first_seen_at = COALESCE(first_seen_at, created_at),
           last_seen_at  = COALESCE(last_seen_at, last_heartbeat_at, created_at),
           updated_at    = now()
     WHERE deleted_at IS NULL;
  END LOOP;
END $$;
