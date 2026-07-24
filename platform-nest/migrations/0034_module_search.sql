-- SM-01 — search-marketing module ('search') schema + THE THIRD RLS WALL (module-sliced RLS).
--
-- Implements docs/blueprints/seo-sem-design.md §04 (the 18 tenant-scoped search_* tables), §05
-- (search_provider_calls ledger + search_data_cache), and §11 (trust & security: RLS rules incl.
-- the single no-RLS exemption). Conventions taken byte-for-byte from the newest third-wall module
-- migration, 0028_module_hr.sql, and the 0025 fail-closed empty-set helpers.
--
-- ── THE THIRD WALL (reused from 0028, NOT redefined here) ──────────────────────────────────────────
-- Every search_* TENANT table carries the identical composed policy predicate
--   tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')
-- on BOTH USING (reads) and WITH CHECK (writes), so a request that reaches a search_* table WITHOUT
-- declaring the 'search' module scope (the app.scopes GUC, set by withTenants(t,{modules:['search']}))
-- reads/writes ZERO rows even with a correct tenant set — fail-closed, in-process, defence-in-depth
-- behind Cerbos (wall 1) and the withTenants choke-point (wall 2). app_current_tenants() (0025) and
-- app_module_allowed() (0028) already exist as PUBLIC-EXECUTE inlinable STABLE helpers; this migration
-- only composes them into the search_* policies. Empty/unset GUC -> NULL -> `= ANY(NULL)` -> false.
--
-- ── THE SINGLE, DELIBERATE NO-RLS EXEMPTION (owner-ratified D-4, design §05/§11) ────────────────────
-- search_data_cache is a SHARED, CROSS-TENANT market-data cache (public-world SERP/volume/backlink
-- data — the cross-tenant reuse IS the cost model). It has NO tenant_id and DELIBERATELY carries NO
-- RLS: it must be readable with no tenant GUC set (the provider layer reads it before any tenant
-- context exists). It stores NO client identifiers and NO client-private data; results are copied
-- onto tenant rows, never serialized raw to a tenant API. "Provider-layer-only" is a service-layer
-- invariant (not a grant-enforced one in v1). This is THE one exemption from the estate-wide
-- FORCE-RLS rule and is flagged security-relevant. Every OTHER search_* table is FORCE-RLS'd below.
--
-- ── CONVENTIONS ────────────────────────────────────────────────────────────────────────────────────
-- origin_site default 'central'; soft-delete deleted_at on user-facing entities; append-only
-- time-series / ledger tables carry created_at only. Money: client-facing money = minor-unit bigint +
-- currency; PROVIDER cost = numeric(12,6) USD (DataForSEO unit prices reach $0.00012 — minor-unit
-- integers cannot hold them). Runtime DML grants come from the owner's ALTER DEFAULT PRIVILEGES +
-- the external RUNTIME_GRANTS_SQL pass (migrations/README.md) — NO in-migration GRANTs, and NO
-- sync_app grants (search tables do not sync in v1). Additive, CREATE-only.
--
-- ── DUAL-MODE EMBEDDING (design §07 pgvector note; mirrors ai-agents/src/knowledge/store.ts) ─────────
-- search_keywords.embedding is an OPERATIONAL clustering feature column (not a retrieval store —
-- retrieval-shaped RAG stays in WS8). It is added dual-mode: vector(768) WHEN the `vector` extension
-- is present, double precision[] fallback otherwise, so the migration applies on plain Postgres
-- (the extension is created at provisioning by a superuser — the owner role cannot CREATE it, so we
-- only DETECT it, never create it). See the guarded ADD COLUMN block after the table.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) search_properties — the client web property; anchor for crawls, ranks, GEO, analytics.
CREATE TABLE search_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  domain text NOT NULL,                              -- registrable domain; crawl-allowlist source
  site_url text NOT NULL,                            -- canonical origin
  targets jsonb NOT NULL DEFAULT '[]',               -- [{engine,device,locale,location_code}]
  umami_site_id text,                                -- Zone B analytics binding (nullable)
  gsc_connection_id uuid REFERENCES integration_connections(id),   -- P4
  ga4_connection_id uuid REFERENCES integration_connections(id),   -- P4
  ads_connection_id uuid REFERENCES integration_connections(id),   -- P4
  verified_at timestamptz,                           -- crawl-consent checkpoint (activation checklist)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, client_id, domain)
);
CREATE INDEX ix_search_properties_client ON search_properties (tenant_id, client_id) WHERE deleted_at IS NULL;

-- (2) search_engagements — the outcome-tracked engagement (foundation §3).
CREATE TABLE search_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  project_id uuid REFERENCES projects(id),           -- optional: ties into PM/time/deliverables
  name text NOT NULL,
  scope_preset text CHECK (scope_preset IN ('light','standard','heavy','custom')),
      -- label only: presets SEED tool_scope; enforcement never reads it (design §04)
  tool_scope jsonb NOT NULL DEFAULT '{}',
      -- THE per-engagement tool/scope config (owner decision D-11): a human enables each tool / paid
      -- pull per client. Every scheduled flow and every paid dispatch consults it (design §04/§05).
  provider_budget_usd numeric(12,6) NOT NULL DEFAULT 10.0,   -- monthly data-spend cap (stop-loss)
  media_budget_minor bigint,                          -- SEM ad-spend plan (client money, minor units)
  media_currency text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','closed')),
  owner_id uuid REFERENCES users(id),
  starts_on date,
  ends_on date,
  custom_fields jsonb NOT NULL DEFAULT '{}',          -- D17 target (search_engagement)
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_engagements_client ON search_engagements (tenant_id, client_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_search_engagements_property ON search_engagements (tenant_id, property_id) WHERE deleted_at IS NULL;

-- (3) search_kpi_targets — committed outcomes per engagement (reports measure against these).
CREATE TABLE search_kpi_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL REFERENCES search_engagements(id),
  metric_key text NOT NULL,          -- canonical: organic_sessions|top10_keywords|conversions|cpa_minor|roas_ratio|ai_citations|...
  baseline_value numeric,
  target_value numeric NOT NULL,
  due_period text,                   -- e.g. '2026-Q3' / '2026-08' (free-form period label)
  direction text NOT NULL DEFAULT 'up' CHECK (direction IN ('up','down')),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_kpi_targets_engagement ON search_kpi_targets (tenant_id, engagement_id) WHERE deleted_at IS NULL;

-- (4) search_keyword_sets — per engagement.
CREATE TABLE search_keyword_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL REFERENCES search_engagements(id),
  name text NOT NULL,
  source text NOT NULL DEFAULT 'client' CHECK (source IN ('client','gsc','research','ai')),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_keyword_sets_engagement ON search_keyword_sets (tenant_id, engagement_id) WHERE deleted_at IS NULL;

-- (5) search_keywords — embedding column added dual-mode AFTER the table (guarded block below).
CREATE TABLE search_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  set_id uuid NOT NULL REFERENCES search_keyword_sets(id),
  keyword text NOT NULL,
  locale text NOT NULL DEFAULT 'id-ID',
  intent text CHECK (intent IN ('informational','commercial','transactional','navigational')),
  cluster_id uuid,                    -- clustering-job output; not a table -> no FK (design §04)
  cluster_label text,
  volume integer,
  difficulty numeric(5,2),
  cpc_usd numeric(12,6),
  metrics_fetched_at timestamptz,     -- cache stamp: no provider re-query inside the window
  is_tracked boolean NOT NULL DEFAULT false,   -- tracked = rank-pulled on schedule (costs money)
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, set_id, keyword, locale)
);
CREATE INDEX ix_search_keywords_set ON search_keywords (tenant_id, set_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_search_keywords_cluster ON search_keywords (tenant_id, cluster_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_search_keywords_tracked ON search_keywords (tenant_id, is_tracked) WHERE is_tracked AND deleted_at IS NULL;

-- Dual-mode embedding column: vector(768) if the extension exists, else double precision[] fallback.
-- DETECT-only (owner role cannot CREATE the extension); ADD COLUMN IF NOT EXISTS keeps it re-runnable.
DO $$
DECLARE has_vector boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') INTO has_vector;
  IF has_vector THEN
    EXECUTE 'ALTER TABLE search_keywords ADD COLUMN IF NOT EXISTS embedding vector(768)';
  ELSE
    EXECUTE 'ALTER TABLE search_keywords ADD COLUMN IF NOT EXISTS embedding double precision[]';
  END IF;
END $$;

-- (6) search_provider_calls — the metering ledger (§05). APPEND-ONLY (created_at only). Created
--     before rank/ai-visibility so those can FK provider_call_id.
CREATE TABLE search_provider_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid REFERENCES search_engagements(id),
  property_id uuid REFERENCES search_properties(id),
  provider text NOT NULL,
  endpoint text NOT NULL,                              -- e.g. 'serp.google.organic.task_post'
  items integer NOT NULL DEFAULT 1,
  cost_usd numeric(12,6) NOT NULL,                     -- estimated at dispatch, trued-up on completion
  cache_hit boolean NOT NULL DEFAULT false,            -- hits logged at cost 0 (visibility of savings)
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','completed','failed')),
  requested_by uuid REFERENCES users(id),              -- human or the automation OBO user
  correlation_id text,                                 -- n8n run / MCP call id
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_search_provider_calls_ledger ON search_provider_calls (tenant_id, engagement_id, created_at DESC);

-- (7) search_rank_snapshots — append-only time series (keyword x engine x day).
CREATE TABLE search_rank_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  keyword_id uuid NOT NULL REFERENCES search_keywords(id),
  engine text NOT NULL DEFAULT 'google',
  device text NOT NULL DEFAULT 'desktop',
  location_code integer,
  captured_at timestamptz NOT NULL DEFAULT now(),
  position integer,                                    -- nullable = not found in the SERP
  ranked_url text,
  serp_features jsonb NOT NULL DEFAULT '{}',           -- {ai_overview,featured_snippet,local_pack,...} (GEO signal)
  provider text,
  provider_call_id uuid REFERENCES search_provider_calls(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_search_rank_snapshots_series ON search_rank_snapshots (property_id, keyword_id, captured_at DESC);

-- (8) search_audits.
CREATE TABLE search_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  kind text NOT NULL CHECK (kind IN ('technical','cwv','content','links','geo')),
  source text NOT NULL CHECK (source IN ('seonaut','crawler','unlighthouse','ai')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  score numeric,
  summary jsonb NOT NULL DEFAULT '{}',                 -- severity counts
  report_file_id uuid REFERENCES files(id),            -- raw export
  started_at timestamptz,
  completed_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_audits_property ON search_audits (tenant_id, property_id, kind, status) WHERE deleted_at IS NULL;

-- (9) search_audit_findings — regression = diff of consecutive completed audits of the same kind.
CREATE TABLE search_audit_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  audit_id uuid NOT NULL REFERENCES search_audits(id),
  code text NOT NULL,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('critical','high','medium','low','info')),
  category text,
  message text NOT NULL,
  url_count integer NOT NULL DEFAULT 0,
  sample_urls jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','ignored','regressed')),
  first_seen_audit_id uuid REFERENCES search_audits(id),
  last_seen_audit_id uuid REFERENCES search_audits(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_search_audit_findings_audit ON search_audit_findings (tenant_id, audit_id);
CREATE INDEX ix_search_audit_findings_status ON search_audit_findings (tenant_id, status);

-- (10) search_backlink_snapshots — monthly aggregates (full link inventory NOT stored in v1).
CREATE TABLE search_backlink_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  captured_at timestamptz NOT NULL DEFAULT now(),
  totals jsonb NOT NULL DEFAULT '{}',                  -- {backlinks,ref_domains,authority_score}
  new_links jsonb NOT NULL DEFAULT '[]',               -- top-N samples
  lost_links jsonb NOT NULL DEFAULT '[]',
  provider text,
  provider_call_id uuid REFERENCES search_provider_calls(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_search_backlink_snapshots_property ON search_backlink_snapshots (tenant_id, property_id, captured_at DESC);

-- (11) search_ai_visibility (GEO pillar) — append-only snapshots.
CREATE TABLE search_ai_visibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  captured_at timestamptz NOT NULL DEFAULT now(),
  engine text NOT NULL CHECK (engine IN ('chatgpt','google_ai_overview','gemini','claude','perplexity')),
  query text NOT NULL,
  brand_mentioned boolean NOT NULL DEFAULT false,
  cited boolean NOT NULL DEFAULT false,
  cited_url text,
  prominence numeric,
  raw jsonb NOT NULL DEFAULT '{}',
  provider text,
  provider_call_id uuid REFERENCES search_provider_calls(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_search_ai_visibility_property ON search_ai_visibility (property_id, captured_at DESC);
CREATE INDEX ix_search_ai_visibility_engine ON search_ai_visibility (tenant_id, engine, captured_at DESC);

-- (12) search_campaigns (SEM). draft/proposed = ERP-side; live states mirror the platform once linked.
CREATE TABLE search_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL REFERENCES search_engagements(id),
  platform text NOT NULL DEFAULT 'google_ads' CHECK (platform IN ('google_ads','microsoft_ads')),
  external_id text,                                    -- nullable until linked
  name text NOT NULL,
  objective text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','live','paused','ended')),
  budget_minor bigint,
  currency text,
  bid_strategy text,
  target_cpa_minor bigint,
  target_roas numeric,
  custom_fields jsonb NOT NULL DEFAULT '{}',           -- D17 target (search_campaign)
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_campaigns_engagement ON search_campaigns (tenant_id, engagement_id, status) WHERE deleted_at IS NULL;

-- (13) search_ad_groups — built FROM keyword clusters.
CREATE TABLE search_ad_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  campaign_id uuid NOT NULL REFERENCES search_campaigns(id),
  name text NOT NULL,
  cluster_id uuid,                                     -- keyword cluster; not a table -> no FK
  external_id text,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_ad_groups_campaign ON search_ad_groups (tenant_id, campaign_id) WHERE deleted_at IS NULL;

-- (14) search_ads — RSA drafts.
CREATE TABLE search_ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  ad_group_id uuid NOT NULL REFERENCES search_ad_groups(id),
  headlines jsonb NOT NULL DEFAULT '[]',
  descriptions jsonb NOT NULL DEFAULT '[]',
  final_url text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','live','rejected')),
  ai_generated boolean NOT NULL DEFAULT false,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_ads_group ON search_ads (tenant_id, ad_group_id, status) WHERE deleted_at IS NULL;

-- (15) search_negatives.
CREATE TABLE search_negatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  campaign_id uuid NOT NULL REFERENCES search_campaigns(id),
  ad_group_id uuid REFERENCES search_ad_groups(id),   -- nullable (campaign-level negatives)
  term text NOT NULL,
  match_type text NOT NULL DEFAULT 'exact' CHECK (match_type IN ('broad','phrase','exact')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('ai','manual','sweep')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','applied','dismissed')),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_negatives_campaign ON search_negatives (tenant_id, campaign_id, status) WHERE deleted_at IS NULL;

-- (16) search_campaign_metrics_daily — CSV import / Ads-Scripts bridge; UNIQUE(campaign_id, date) upsert.
CREATE TABLE search_campaign_metrics_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  campaign_id uuid NOT NULL REFERENCES search_campaigns(id),
  date date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost_minor bigint NOT NULL DEFAULT 0,
  currency text,
  conversions numeric NOT NULL DEFAULT 0,
  conv_value_minor bigint NOT NULL DEFAULT 0,
  source text,                                         -- 'csv' | 'ads_scripts'
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, date)
);
CREATE INDEX ix_search_campaign_metrics_daily_campaign ON search_campaign_metrics_daily (tenant_id, campaign_id, date DESC);

-- (17) search_change_proposals — the dual-mode execution artifact (owner decision D-8, design §04).
CREATE TABLE search_change_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  campaign_id uuid NOT NULL REFERENCES search_campaigns(id),
  kind text NOT NULL CHECK (kind IN ('launch','pause','budget','bid','negatives_batch','ads_batch')),
  payload jsonb NOT NULL,                              -- exact intended change (hashed for approval match)
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','applied','dismissed')),
  mode text NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','api')),  -- human-chosen per action
  approval_id uuid REFERENCES automation_approvals(id),  -- WS4 link (api mode; one-shot, §07)
  export_file_id uuid REFERENCES files(id),           -- Ads-Editor-ready artifact (manual mode)
  proposed_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  applied_by uuid REFERENCES users(id),
  applied_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_change_proposals_campaign ON search_change_proposals (tenant_id, campaign_id, status) WHERE deleted_at IS NULL;

-- (18) search_reports — report = deliverable (surfaces in the agency deliverable flow).
CREATE TABLE search_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL REFERENCES search_engagements(id),
  period text,
  kind text NOT NULL DEFAULT 'monthly' CHECK (kind IN ('monthly','audit','adhoc')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','delivered')),
  metrics jsonb NOT NULL DEFAULT '{}',                 -- frozen snapshot incl. KPI-vs-target
  narrative_md text,                                   -- AI draft -> human-edited
  file_id uuid REFERENCES files(id),                   -- rendered artifact (mirrored to Shared Drive)
  deliverable_id uuid REFERENCES deliverables(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  delivered_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_reports_engagement ON search_reports (tenant_id, engagement_id, period) WHERE deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- THE NO-RLS EXEMPTION: search_data_cache (owner-ratified D-4). Shared cross-tenant market-data
-- cache — NO tenant_id, NO RLS (readable with no tenant GUC). Provider-layer-only; no client data.
-- Deliberately EXCLUDED from the FORCE-RLS loop below. See the header block for the full rationale.
CREATE TABLE search_data_cache (
  cache_key text PRIMARY KEY,           -- canonical: kind|provider-class|norm(query)|engine|locale|location
  kind text NOT NULL CHECK (kind IN ('serp','volume','suggestions','backlinks','competitors','ai_visibility')),
  payload jsonb NOT NULL,
  provider text NOT NULL,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL      -- per-kind TTL (volume 30d / serp 24h / suggestions 14d / backlinks 7d / ai_visibility 7d)
);
CREATE INDEX ix_search_data_cache_kind ON search_data_cache (kind);
CREATE INDEX ix_search_data_cache_expiry ON search_data_cache (expires_at);
COMMENT ON TABLE search_data_cache IS
  'DELIBERATELY NO-RLS (owner-ratified D-4, seo-sem-design.md §05/§11). Shared cross-tenant '
  'market-data cache: public-world SERP/volume/backlink data, no tenant_id, no client identifiers, '
  'provider-layer-only. Must be readable with no tenant GUC set (read before any tenant context '
  'exists). THE single exemption from the estate-wide FORCE-RLS rule.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the ONE composed tenant_isolation policy per TENANT table (design §04/§11). Written
-- once in a DO loop so the third-wall predicate can never drift per-table — every table below gets
-- the byte-identical `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')` on
-- BOTH USING (reads) and WITH CHECK (writes). search_data_cache is INTENTIONALLY absent (D-4).
-- Each listed table has a tenant_id column, so the rls.test.ts FORCE-RLS sweep covers all 18.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'search_properties','search_engagements','search_kpi_targets','search_keyword_sets',
    'search_keywords','search_provider_calls','search_rank_snapshots','search_audits',
    'search_audit_findings','search_backlink_snapshots','search_ai_visibility','search_campaigns',
    'search_ad_groups','search_ads','search_negatives','search_campaign_metrics_daily',
    'search_change_proposals','search_reports'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))',
      t
    );
  END LOOP;
END $$;
