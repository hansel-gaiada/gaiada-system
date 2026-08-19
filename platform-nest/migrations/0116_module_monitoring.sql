-- MON-10 — the `monitoring` module: PLANE B, the tenant's own websites and services.
-- Design: docs/blueprints/monitoring-program.md §3. Contract: docs/FRONTEND-BFF-CONTRACT.md §20.
--
-- ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────────────────────
-- NOT platform observability. Prometheus/Grafana/Loki/Tempo watch OUR infrastructure, are staff-only,
-- and were relocated to the SumoPod VPS on 2026-08-18. Nothing in this schema touches that. Plane A
-- and Plane B never merge (§8.1); Gaia Nexus merged them and that is exactly why its dashboard was
-- fiction. These tables describe CLIENT properties: tenant-scoped, Cerbos-gated, and sellable.
--
-- ── CONVENTIONS (mirrors 0034_module_search.sql) ───────────────────────────────────────────────────
-- origin_site default 'central'; soft-delete `deleted_at` on user-facing entities; append-only
-- time-series carry created_at only. Runtime DML grants come from the owner's ALTER DEFAULT
-- PRIVILEGES + the external RUNTIME_GRANTS_SQL pass (migrations/README.md) — NO in-migration GRANTs.
-- Additive, CREATE-only.
--
-- ── TENANCY IS THREE-LEVEL, NOT TWO ────────────────────────────────────────────────────────────────
-- company (tenant) -> client -> property. Every table carries BOTH tenant_id and client_id, matching
-- search_properties. The owner ruling of 2026-08-13 makes DnA Holding the root company with operating
-- businesses beneath it, and the platform is being adapted for unrelated SaaS tenants — so a monitor
-- with no client has nowhere to hang its billing, engagement scope or status page. `client_id` is
-- therefore NOT NULL even for a tenant's own properties (they get an `internal` client row).
--
-- ⚠ MON-00 REMAINS OPEN AND GATES THE CROSS-CLIENT SURFACE. This module adds the first genuinely
-- cross-client aggregate board ("all properties, all clients, one status view"). Hierarchy-aware
-- rollups already traverse upward; the moment a root company can roll up its children, the mechanism
-- to roll up ACROSS roots exists and only a correct scope predicate prevents it. RLS below is
-- per-tenant and does NOT itself traverse the hierarchy — deliberately. Any future rollup over these
-- tables must carry the MON-00 boundary rule plus a test that fails on a foreign root's row.

-- ── (1) monitors — the definition a human authors. ────────────────────────────────────────────────
-- A monitor written here by a verified human IS the standing authorization for the platform to probe
-- that target on a schedule (§4.3). It is NOT authorization to act ON the target; anything that
-- changes a client system belongs behind a D14 approval, never behind this row.
CREATE TABLE monitors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  client_id      uuid NOT NULL REFERENCES clients(id),
  -- Nullable: a monitor may watch something that is not a registered SEO property (an API endpoint,
  -- a scheduled job). When set, it is what the egress allowlist is resolved from.
  property_id    uuid REFERENCES search_properties(id),
  name           text NOT NULL,
  -- Free text, NOT an enum: the driver registry is the authority on which kinds can actually run
  -- (§3.2), and a DB enum would force a migration to add a driver — turning "register a driver" into
  -- "ship a schema change". An unknown kind must fail loudly at dispatch, not be unstorable.
  kind           text NOT NULL,
  -- Driver-specific. Holds secret REFERENCES only, never secrets: a webhook URL with an embedded
  -- token IS a credential, and `monitoring.read` is a broad grant.
  config         jsonb NOT NULL DEFAULT '{}',
  target         text,
  interval_sec   integer NOT NULL DEFAULT 60 CHECK (interval_sec >= 20),
  severity       text NOT NULL DEFAULT 'ticket' CHECK (severity IN ('page','ticket','info')),
  enabled        boolean NOT NULL DEFAULT true,
  tags           text[] NOT NULL DEFAULT '{}',
  -- Denormalised current state, maintained by the runner. The authoritative history is
  -- monitor_results; these exist so the board does not aggregate a partitioned time-series per row.
  -- NULL last_checked_at means NEVER CHECKED and must render as "never" — never as healthy.
  status         text NOT NULL DEFAULT 'unknown'
                 CHECK (status IN ('up','down','degraded','maintenance','unknown')),
  last_checked_at timestamptz,
  last_latency_ms integer,
  cert_expires_at timestamptz,
  domain_expires_at timestamptz,
  created_by     uuid REFERENCES users(id),
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (tenant_id, client_id, name)
);
CREATE INDEX ix_monitors_client ON monitors (tenant_id, client_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_monitors_enabled ON monitors (tenant_id, enabled) WHERE deleted_at IS NULL;

-- ── (2) monitor_assertions — what "healthy" means beyond a 200. ───────────────────────────────────
-- A hacked WordPress serves 200 with pharma spam; a PHP fatal serves 200 with a blank page. Status
-- alone calls both healthy. The backend validates `type` against the driver's declared capabilities
-- and REFUSES an assertion the kind cannot evaluate — a silently-ignored assertion would make a
-- monitor report "up" for a condition it never actually checked.
CREATE TABLE monitor_assertions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  client_id   uuid NOT NULL REFERENCES clients(id),
  monitor_id  uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  type        text NOT NULL,
  expr        text NOT NULL,
  negate      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_monitor_assertions_monitor ON monitor_assertions (tenant_id, monitor_id);

-- ── (3) monitor_results — append-only time series, PARTITIONED. ───────────────────────────────────
-- The only table here with unbounded growth. Partitioned by range on checked_at so retention is a
-- DETACH/DROP of a partition rather than a bulk DELETE that bloats the heap and then has to be
-- vacuumed on a box that is already disk-constrained.
-- `detail` is driver output and is NOT public-safe (it can quote the assertion string, which encodes
-- what we treat as a compromise signature) — the public status page field allowlist excludes it.
CREATE TABLE monitor_results (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  client_id   uuid NOT NULL REFERENCES clients(id),
  monitor_id  uuid NOT NULL,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL CHECK (status IN ('up','down','degraded','maintenance','unknown')),
  latency_ms  integer,
  detail      text,
  PRIMARY KEY (id, checked_at)
) PARTITION BY RANGE (checked_at);
CREATE INDEX ix_monitor_results_monitor ON monitor_results (tenant_id, monitor_id, checked_at DESC);

-- Seed partitions. A missing partition makes the INSERT fail outright, which would take the runner
-- down rather than lose a row quietly — the right failure direction, but it still needs a scheduled
-- job to roll them forward (MON-12). Named by month so that job is trivially idempotent.
DO $$
DECLARE
  m date := date_trunc('month', now())::date;
  i int;
  s date; e date;
BEGIN
  FOR i IN 0..3 LOOP
    s := (m + (i || ' month')::interval)::date;
    e := (m + ((i+1) || ' month')::interval)::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS monitor_results_%s PARTITION OF monitor_results FOR VALUES FROM (%L) TO (%L)',
      to_char(s, 'YYYYMM'), s, e);
  END LOOP;
END $$;

-- ── (4) monitor_incidents — a fact with a required response. ──────────────────────────────────────
-- This is the row agents and automation bind to (§4.3): opened/closed/acknowledged are the published
-- event taxonomy. Append-only in spirit; `closed_at`/`acknowledged_at` are the only mutations.
CREATE TABLE monitor_incidents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  client_id       uuid NOT NULL REFERENCES clients(id),
  monitor_id      uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  cause           text,
  severity        text NOT NULL DEFAULT 'ticket' CHECK (severity IN ('page','ticket','info')),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- At most ONE open incident per monitor. Without this a flapping check opens an incident per failed
-- probe and buries the operator — alert fatigue by way of the data model.
CREATE UNIQUE INDEX ux_monitor_incidents_open ON monitor_incidents (monitor_id) WHERE closed_at IS NULL;
CREATE INDEX ix_monitor_incidents_tenant ON monitor_incidents (tenant_id, opened_at DESC);

-- ── (5) monitor_maintenance — K7, and not optional polish. ────────────────────────────────────────
-- Without windows, planned client work pages someone every time and alerting gets muted at the
-- source, which is how an alerting system dies. Suppresses BOTH notification and SLA math, or the
-- uptime figure punishes the client for scheduled work.
CREATE TABLE monitor_maintenance (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES companies(id),
  client_id  uuid REFERENCES clients(id),
  monitor_id uuid REFERENCES monitors(id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- An open-ended window is indistinguishable from "alerting off forever"; the API rejects it too,
  -- but the constraint is what makes that true regardless of which caller writes the row.
  CONSTRAINT monitor_maintenance_range CHECK (ends_at > starts_at)
);
CREATE INDEX ix_monitor_maintenance_active ON monitor_maintenance (tenant_id, starts_at, ends_at);

-- ── (6) monitor_channels / (7) monitor_routes — delivery, not a second alerting system. ───────────
-- Alerts are emitted to the platform outbox first (§4.1) so automation and agents see the same event
-- a person does. These rows only describe where a notification is delivered.
CREATE TABLE monitor_channels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  kind           text NOT NULL,
  name           text NOT NULL,
  -- Secret REFERENCES only. Never an inline token: `monitoring.read` is broad, and a webhook URL
  -- carrying a bearer is a credential sitting in a column half the company can select.
  config         jsonb NOT NULL DEFAULT '{}',
  -- Display-safe, truncated summary for the console ("ops@…", "#alerts", "https://host/hook/abc…").
  destination    text,
  enabled        boolean NOT NULL DEFAULT true,
  last_delivery_at timestamptz,
  last_delivery_ok boolean,
  -- CONSECUTIVE failures, reset to 0 on success. The UI escalates on this rather than a boolean,
  -- because a channel that exists and is enabled while quietly failing is worse than no channel —
  -- it looks like coverage.
  failure_count  integer NOT NULL DEFAULT 0,
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (tenant_id, name)
);

CREATE TABLE monitor_routes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  channel_id      uuid NOT NULL REFERENCES monitor_channels(id) ON DELETE CASCADE,
  -- All three NULL = matches everything. Legal (a catch-all pager) and usually an accident that
  -- floods one channel; the console flags it rather than the schema forbidding it.
  match_client_id uuid REFERENCES clients(id),
  match_severity  text CHECK (match_severity IS NULL OR match_severity IN ('page','ticket','info')),
  match_kind      text,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_monitor_routes_channel ON monitor_routes (tenant_id, channel_id);

-- ── (8) monitor_heartbeats — K1, the highest-value driver. ────────────────────────────────────────
-- A job pings a URL; no ping within grace ⇒ alert. This closes the class of failure that has bitten
-- this estate TWICE in production, both silently: n8n event flows darkened by an unset env var, and
-- mcp-hub serving zero tools for days. A dead scheduled job is currently invisible.
CREATE TABLE monitor_heartbeats (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  client_id    uuid NOT NULL REFERENCES clients(id),
  monitor_id   uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  -- HASH, never the token. The ingest endpoint is unauthenticated by design — the URL token IS the
  -- credential, so a cron job or n8n flow can curl it with no session. Storing it in clear would
  -- make a DB read equivalent to forging any job's liveness.
  token_hash   text NOT NULL UNIQUE,
  grace_sec    integer NOT NULL DEFAULT 300 CHECK (grace_sec >= 30),
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_monitor_heartbeats_monitor ON monitor_heartbeats (tenant_id, monitor_id);

-- ── (9) status_pages — K6, a billable deliverable and the ERP's ONLY public read surface. ─────────
-- Because it is unauthenticated, exposure is opt-in and audited: default private, and publishing is
-- gated on `status_page.publish`. The served field allowlist lives in the API, not here — but the
-- default below is what makes "forgot to think about it" mean private rather than public.
CREATE TABLE status_pages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES companies(id),
  client_id  uuid NOT NULL REFERENCES clients(id),
  slug       text NOT NULL UNIQUE,
  title      text,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  theme      jsonb NOT NULL DEFAULT '{}',
  published_at timestamptz,
  published_by uuid REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_status_pages_client ON status_pages (tenant_id, client_id) WHERE deleted_at IS NULL;

-- ── RLS: one loop, one predicate, no per-table drift. ─────────────────────────────────────────────
-- Byte-identical `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('monitoring')` on
-- BOTH USING (reads) and WITH CHECK (writes) for every table, exactly as 0034 does for search.
-- Policies on the partitioned parent apply to every partition, so monitor_results is covered as it
-- rolls forward without anyone remembering to re-apply anything.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'monitors','monitor_assertions','monitor_results','monitor_incidents',
    'monitor_maintenance','monitor_channels','monitor_routes','monitor_heartbeats','status_pages'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''monitoring''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''monitoring''))',
      t
    );
  END LOOP;
END $$;
