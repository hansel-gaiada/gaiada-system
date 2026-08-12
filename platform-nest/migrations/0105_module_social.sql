-- SMM-01 — social-media module ('social') schema + THE THIRD RLS WALL (module-sliced RLS).
--
-- Implements docs/blueprints/smm-design.md §04 (the tenant-scoped social_* tables), §05
-- (social_usage_ledger), §11 (trust & security), AS AMENDED BY
-- docs/blueprints/smm-design-addendum-2026-08-12.md (BINDING): §A2 D-15 (args_sha256 replaces the
-- design's bespoke payload_hash), D-16 (the client-review table and its DIFFERENT wall), D-17 (the
-- generative-image ledger kinds ship inert), and §A1 Δ9 (this migration is 0105, not the design's
-- 0034 — that number was taken by the search module on 2026-07-23).
--
-- Conventions taken byte-for-byte from the two migrations this one is a hybrid of:
-- 0034_module_search.sql (third-wall module vertical, the closest domain sibling) and
-- 0088_webdev_change_requests.sql (the PLAIN-wall portal-written table).
--
-- ── NUMBERING (migrations/README.md rule 5) ─────────────────────────────────────────────────────
-- Head at write time was 0104_iam_dr12_drop_portal_staff_bundle_rows.sql; 0105 was RESERVED by
-- creating this file before writing it (concurrent sessions share this checkout). 0106 is reserved
-- in the same pass by SMM-30, which seeds this module's permission catalog rows. `0058`/`0059`/
-- `0070` remain permanently-orphaned reservations: do NOT fill them.
--
-- ── TWO WALLS, DELIBERATELY (addendum D-16 / Δ8 — the single most important thing in this file) ──
-- Fourteen social_* tables take the THIRD WALL:
--     tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social')
-- on BOTH USING and WITH CHECK, byte-identical across all of them (written once in a DO loop so it
-- cannot drift per-table). A request that reaches them without declaring the 'social' module scope
-- (`withTenants(t, fn, {modules:['social']})`) reads and writes ZERO rows, fail-closed.
--
-- `social_post_client_reviews` is the ONE tenant table that takes the PLAIN CORE tenant wall
-- instead, and this is NOT an inconsistency to tidy up later. Its primary writer is the CLIENT
-- PORTAL; portal controllers are core and declare no module scope, so app_module_allowed('social')
-- is a two-sided handshake they can never complete — a third wall there would read as zero rows,
-- SILENTLY, on every portal query. This is 0088's D-2a lesson, applied before it could bite rather
-- than after. Do NOT add an app_module_allowed() clause here "for consistency"; that reintroduces
-- exactly the failure this split exists to avoid. The staff-side content it points at
-- (social_post_variants) stays third-walled, which is why the review is a SEPARATE TABLE rather
-- than columns on the variant.
--
-- ── THE SINGLE NO-RLS TABLE (design D-4) ────────────────────────────────────────────────────────
-- social_platform_apps is OUR OWN approved developer-app fleet (Meta/TikTok/LinkedIn/X/YouTube app
-- registrations). It holds ZERO client data and no secrets — only `credential_ref`, an alias into
-- env/OpenBao — and one approved app serves every tenant on that network, so it has no tenant_id
-- and carries no RLS. Unlike the search module there is NO shared market-data cache here: every
-- other byte in this module is client-private (design D-4). Reachable only through admin endpoints
-- gated by `social.platform_app.admin`.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────────────────────────
-- origin_site default 'central'; soft-delete deleted_at on user-facing entities; append-only
-- time-series / ledger tables carry created_at only. Metered cost is numeric(12,6) USD (X per-post
-- is ~$0.015 and credit unit prices are sub-cent — minor-unit integers cannot hold them); there is
-- no client-facing money in this module (no ad spend in v1 scope). Runtime DML grants come from the
-- owner's ALTER DEFAULT PRIVILEGES + the external RUNTIME_GRANTS_SQL pass — NO in-migration GRANTs,
-- and NO sync_app grants (social tables do not sync in v1). Additive, CREATE-only.
--
-- ── ATTRIBUTION (addendum Δ5) ───────────────────────────────────────────────────────────────────
-- No module-local actor/channel columns are invented here. `requested_by`/`created_by`/`decided_by`
-- are plain users FKs exactly as every other module writes them, and the narrative record is the
-- platform's own work_activity/audit rows. Agent attribution (the pre-staging "via:" gate, owner
-- decision 2026-08-08) is systemic and lands platform-wide; when it does, these rows inherit it
-- with no schema change here. A social_* column for it now would be a second, competing answer.
--
-- ── NO DML ──────────────────────────────────────────────────────────────────────────────────────
-- Brand-new tables, nothing to backfill, so the 0050 NOBYPASSRLS backfill trap (migrations run as
-- platform_owner WITHOUT BYPASSRLS against FORCE-RLS tables, where an unset GUC silently returns
-- zero rows and reports success) does not apply to this file.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) social_platform_apps — OUR approved developer-app fleet. GLOBAL: no tenant_id, NO RLS.
--     Deliberately created FIRST so social_accounts can FK it. See the header for why it is exempt.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_platform_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL CHECK (network IN ('instagram','facebook','tiktok','linkedin','x',
    'youtube','threads','pinterest','bluesky','mastodon')),
  app_name text NOT NULL,
  -- The app-review pipeline (design OQ-1) is a weeks-long NON-CODE workstream; modeling its state
  -- here is what lets the console tell an operator WHY a client account cannot be connected yet.
  review_status text NOT NULL DEFAULT 'sandbox'
    CHECK (review_status IN ('sandbox','submitted','approved','rejected','suspended')),
  access_tier text,                                    -- e.g. LinkedIn Dev vs Standard
  scopes jsonb NOT NULL DEFAULT '[]',                  -- granted OAuth scopes, as approved
  quota_regime jsonb NOT NULL DEFAULT '{}',            -- documented caps, e.g. {"igPosts24h":25}
  -- ALIAS ONLY (design D-5): the app secret lives in env/OpenBao and is injected into the Postiz
  -- container at deploy. A secret has never been in this column and must never be.
  credential_ref text,
  review_notes text,
  expires_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- One app per network per name; the fleet is small and hand-curated.
  UNIQUE (network, app_name)
);
COMMENT ON TABLE social_platform_apps IS
  'DELIBERATELY NO-RLS and NO tenant_id (smm-design.md §04/§11, D-4). Our own approved developer-app '
  'fleet: one app per network serves every tenant. Contains zero client data and zero secrets — '
  'credential_ref is an env/OpenBao alias. Admin-endpoint-only (social.platform_app.admin). This is '
  'this module''s ONLY exemption from the estate-wide FORCE-RLS rule; unlike the search module there '
  'is no shared cross-tenant data cache here, because all social data is client-private.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) social_engagements — the outcome-tracked client engagement, carrying the per-client tool
--     scope + metered budget (design D-8, inherited from search D-11).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  project_id uuid REFERENCES projects(id),             -- optional: PM/time/deliverables tie-in
  name text NOT NULL,
  -- THE per-engagement config a human sets per client. Every flow and every metered dispatch
  -- consults it, INCLUDING the D14 execution precondition (addendum D-14) — a toggle turned off
  -- between approval and execution refuses at execution time, not just in the composer. Shape:
  --   {"networks":{"instagram":true,"linkedin":true,"x":false},
  --    "posting":{"cadencePerWeek":5,"requiresClientOk":false},
  --    "inbox":{"enabled":true,"slaMinutes":240,"dm":false},
  --    "ai":{"drafting":true,"cloudPolish":true,"imageGen":false},
  --    "reporting":{"cadence":"monthly"}}
  -- `networks.x` ships FALSE by design (addendum D-14 + design OQ-2): X is the only metered network,
  -- and keeping it off is what makes the publish path $0 and therefore eligible for the D14
  -- executable-approval registry, whose doctrine permanently bars money-spending tools.
  -- `ai.imageGen` ships FALSE and INERT (addendum D-17): no generative-image backend exists yet
  -- (ai-gateway-go has /complete, /media, /embed only; render-gateway-go is 0.0.0).
  tool_scope jsonb NOT NULL DEFAULT '{}',
  usage_budget_usd numeric(12,6) NOT NULL DEFAULT 10.0,  -- monthly metered cap (X fees + credits)
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','closed')),
  owner_id uuid REFERENCES users(id),
  starts_on date,
  ends_on date,
  custom_fields jsonb NOT NULL DEFAULT '{}',           -- D17 target (social_engagement)
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT ux_social_engagements_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_social_engagements_client ON social_engagements (tenant_id, client_id, status) WHERE deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) social_brand_profiles — per-client voice config. CONFIG ONLY: the brand corpus itself lives in
--     WS8 knowledge (design D-13, preserving D9's single ownership of derived knowledge stores);
--     this table holds pointers, never text-to-be-retrieved and never an embedding column.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_brand_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  tone jsonb NOT NULL DEFAULT '{}',                    -- traits, do/don't lists, banned words, emoji policy, locale
  hashtag_strategy jsonb NOT NULL DEFAULT '{}',
  knowledge_source_ids jsonb NOT NULL DEFAULT '[]',    -- pointers into WS8 knowledge sources
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, client_id)
);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) social_publisher_orgs — the row that makes AGPL containment concrete (design D-2): one Postiz
--     organization per (tenant, client). The MAPPING — and therefore multi-tenancy itself — lives in
--     OUR schema and is never forked into Postiz.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_publisher_orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  driver text NOT NULL DEFAULT 'postiz' CHECK (driver IN ('postiz','mixpost')),
      -- The SocialPublisher port ships one driver (design §05/§06); 'mixpost' is admitted by the
      -- schema now so the documented paid fallback (SMM-28) is a driver swap, not a migration.
  postiz_org_id text NOT NULL,                         -- opaque upstream id
  api_key_ref text NOT NULL,                           -- alias into env/OpenBao — NEVER the key
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, client_id),
  -- The wrong-account-publish defence, at the schema level: one upstream org can NEVER serve two
  -- clients (design §11). A UNIQUE here is worth more than any amount of controller discipline.
  UNIQUE (postiz_org_id),
  CONSTRAINT ux_social_publisher_orgs_id_tenant UNIQUE (id, tenant_id)
);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) social_accounts — the CONNECTOR REGISTRY (modeled on the IT device registry): one row per
--     client × network account, mirroring STATE ABOUT the Postiz integration. Never a token:
--     network tokens are created, stored and refreshed INSIDE Postiz and are never copied into our
--     DB, our vault, or our logs (design D-5, the three-way custody split).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  publisher_org_id uuid NOT NULL REFERENCES social_publisher_orgs(id),
  platform_app_id uuid REFERENCES social_platform_apps(id),   -- which of OUR apps carries it
  network text NOT NULL CHECK (network IN ('instagram','facebook','tiktok','linkedin','x',
    'youtube','threads','pinterest','bluesky','mastodon')),
  handle text NOT NULL,
  display_name text,
  postiz_integration_id text,                          -- opaque upstream id (set after connect)
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','connected','expiring','expired','error','disconnected')),
  quota jsonb NOT NULL DEFAULT '{}',                   -- live counters, e.g. {"igPosts24h":{"used":3,"cap":25}}
  capabilities jsonb NOT NULL DEFAULT '{}',            -- resolved per network: {"schedule":true,"dm":false,...}
  health_checked_at timestamptz,
  last_error text,
  connected_by uuid REFERENCES users(id),
  connected_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, client_id, network, handle),
  -- Same-tenant guarantee on the org link. An FK check runs as the table owner OUTSIDE RLS, so the
  -- two-column form is what actually enforces it (0075 §0) — and this is the exact edge a
  -- cross-client publish would travel down.
  CONSTRAINT fk_social_accounts_org_tenant FOREIGN KEY (publisher_org_id, tenant_id)
    REFERENCES social_publisher_orgs (id, tenant_id),
  CONSTRAINT ux_social_accounts_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_social_accounts_client ON social_accounts (tenant_id, client_id, network) WHERE deleted_at IS NULL;
-- Connector-health sweep (smm-connector-health, daily): the rows that need attention.
CREATE INDEX ix_social_accounts_health ON social_accounts (tenant_id, status)
  WHERE status IN ('expiring','expired','error') AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) social_campaigns — content campaigns/themes. `kind` reserves 'paid' as the documented future
--     service-line seam (design §01); v1 writes only 'organic'.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL REFERENCES social_engagements(id),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'organic' CHECK (kind IN ('organic','paid')),
  goal text,
  period daterange,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','done','archived')),
  custom_fields jsonb NOT NULL DEFAULT '{}',           -- D17 target (social_campaign)
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_social_campaigns_engagement_tenant FOREIGN KEY (engagement_id, tenant_id)
    REFERENCES social_engagements (id, tenant_id),
  CONSTRAINT ux_social_campaigns_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_social_campaigns_engagement ON social_campaigns (tenant_id, engagement_id, status) WHERE deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (7) social_posts — the MASTER post: the idea/brief and its rolled-up state. There is deliberately
--     NO universal post object (locked, design §00.2): per-network content lives on the variants.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL REFERENCES social_engagements(id),
  campaign_id uuid REFERENCES social_campaigns(id),
  title text NOT NULL,                                 -- internal working title
  brief text,                                          -- the idea/angle the variants execute
  source text NOT NULL DEFAULT 'human'
    CHECK (source IN ('human','ai','agent','native_import')),
  status text NOT NULL DEFAULT 'idea' CHECK (status IN
    ('idea','draft','in_review','approved','scheduled','publishing','published',
     'partially_published','failed','archived')),      -- rolls up the variant states
  scheduled_at timestamptz,                            -- plan-level slot (variants may offset)
  created_by uuid REFERENCES users(id),
  custom_fields jsonb NOT NULL DEFAULT '{}',           -- D17 target (social_post)
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_social_posts_engagement_tenant FOREIGN KEY (engagement_id, tenant_id)
    REFERENCES social_engagements (id, tenant_id),
  CONSTRAINT fk_social_posts_campaign_tenant FOREIGN KEY (campaign_id, tenant_id)
    REFERENCES social_campaigns (id, tenant_id),
  CONSTRAINT ux_social_posts_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_social_posts_engagement ON social_posts (tenant_id, engagement_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_social_posts_calendar ON social_posts (tenant_id, scheduled_at) WHERE deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (8) social_post_variants — the per-network content, and THE most safety-critical table here: a row
--     reaching 'queued' is a public, irreversible act.
--
-- THE STATE LAW (design §04/§07, as amended by addendum D-14/D-15):
--   * `args_sha256` is the hash of the MCP tool args the publish call will carry, computed with the
--     hub's canonical-JSON algorithm (mcp-hub/src/approval-grant.ts) — NOT a module-private hash.
--     One hashing contract in the estate: a second one drifts, and the drift is invisible until a
--     grant silently fails to match in production.
--   * A variant reaches 'queued' ONLY by consuming an approved, unconsumed approval whose
--     argsSha256 matches, in the same transaction that stamps `provider_post_id`.
--   * Any edit to an approved variant NULLs `approval_id`, reverts status to 'draft', and
--     recomputes `args_sha256` — so edit-after-approval is structurally impossible, not policed.
--   * `native_import` rows (published by hand in the network's own app) enter directly as
--     'published' with a NULL approval and NULL provider_post_id: calendar completeness WITHOUT
--     faking an approval trail. The CHECK below is what keeps that exception honest and narrow.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_post_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  post_id uuid NOT NULL REFERENCES social_posts(id),
  account_id uuid NOT NULL REFERENCES social_accounts(id),
  body text NOT NULL DEFAULT '',                       -- caption/copy for THIS network
  first_comment text,                                  -- e.g. the IG hashtag-in-first-comment pattern
  media jsonb NOT NULL DEFAULT '[]',                   -- ordered [{fileId, kind:'image'|'video', alt}]
  settings jsonb NOT NULL DEFAULT '{}',                -- {"igType":"reel","tiktokMode":"inbox",...}
  validation jsonb NOT NULL DEFAULT '{}',              -- pre-check result {ok, errors[], warnings[]}
  -- The approval-match anchor (D-15). Recomputed on every content edit; a mismatch at execution
  -- time is a refusal, never a "close enough".
  args_sha256 text,
  approval_id uuid REFERENCES automation_approvals(id),
  native_import boolean NOT NULL DEFAULT false,
  scheduled_at timestamptz,                            -- per-network offset from the master slot
  provider_post_id text,                               -- set only after approved dispatch
  status text NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','in_review','approved','queued','publishing','published','failed','cancelled')),
  published_url text,
  published_at timestamptz,
  last_error text,
  estimated_cost_usd numeric(12,6) NOT NULL DEFAULT 0, -- X per-post preview (design §05)
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (post_id, account_id),
  -- STRUCTURAL, not controller discipline: anything that has left the drafting states must carry
  -- both the approval and the hash it was approved against — unless it is a native import, which by
  -- definition was never dispatched by us.
  CONSTRAINT svar_dispatched_has_approval CHECK (
    native_import
    OR status IN ('draft','in_review','approved','cancelled')
    OR (approval_id IS NOT NULL AND args_sha256 IS NOT NULL)
  ),
  -- A native import is a bookkeeping row, not an execution: it can never carry an approval or a
  -- provider id, and it can only ever be 'published'. Without this, "record what we posted by hand"
  -- becomes a hole in the approval trail wide enough to drive a publish through.
  CONSTRAINT svar_native_import_is_bookkeeping CHECK (
    NOT native_import
    OR (approval_id IS NULL AND provider_post_id IS NULL AND status = 'published')
  ),
  CONSTRAINT fk_social_post_variants_post_tenant FOREIGN KEY (post_id, tenant_id)
    REFERENCES social_posts (id, tenant_id),
  -- The wrong-account-publish defence, second edge (design §11 "defence in depth"): the account
  -- must be in the same tenant as the variant. The client-level check (account's client == post's
  -- engagement's client) is enforced at the dispatch choke-point, where the FK chain is walked.
  CONSTRAINT fk_social_post_variants_account_tenant FOREIGN KEY (account_id, tenant_id)
    REFERENCES social_accounts (id, tenant_id),
  CONSTRAINT ux_social_post_variants_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_social_post_variants_post ON social_post_variants (tenant_id, post_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_social_post_variants_account ON social_post_variants (tenant_id, account_id, status) WHERE deleted_at IS NULL;
-- The reconcile sweep (smm-post-status-sync): what is in flight, oldest first.
CREATE INDEX ix_social_post_variants_inflight ON social_post_variants (tenant_id, scheduled_at)
  WHERE status IN ('queued','publishing') AND deleted_at IS NULL;
-- Idempotency backstop for the dispatch stamp. NULL defeats a plain UNIQUE (SQL NULLs are distinct),
-- so this is a PARTIAL unique over the non-null set — the 0072/0075/0088 house pattern. Two variants
-- can never claim the same upstream post.
CREATE UNIQUE INDEX ux_social_post_variants_provider ON social_post_variants (provider_post_id)
  WHERE provider_post_id IS NOT NULL;
-- One approval is spent on exactly one variant (the other half of one-shot consumption; the first
-- half is the approval row's own single-use claim).
CREATE UNIQUE INDEX ux_social_post_variants_approval ON social_post_variants (approval_id)
  WHERE approval_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (9) social_post_client_reviews — THE CLIENT-APPROVAL STAGE (addendum D-16, owner decision
--     2026-08-12). PLAIN CORE TENANT WALL — see the header block for why, and do not change it.
--
--     Ordering: client OK is a PRECONDITION OF SUBMITTING a variant for staff approval, never a
--     substitute for it. Staff WS4 approval remains the only thing that dispatches, so there is
--     still exactly one publish choke-point.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_post_client_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  variant_id uuid NOT NULL,
  -- SERVER-DERIVED on the portal path (from the caller's resolved scope, never the body — 0075's
  -- "rule 1": a client cannot name their own client_id).
  client_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','changes_requested','withdrawn')),
  comment text,
  -- The content the client actually saw, at the moment they saw it. Same algorithm as the variant's
  -- own hash: if the post is edited after a client approves, the two stop matching and the review is
  -- stale by construction rather than by a timestamp comparison someone has to remember to write.
  reviewed_args_sha256 text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),                -- portal contacts ARE users rows (0072)
  decided_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One live review per variant: the decision is idempotent by construction, which is what an
  -- at-least-once caller (portal retry, agent retry) needs — agentic criterion 3.
  UNIQUE (variant_id),
  -- A decided row must say who decided and when; a pending row must not pretend to.
  CONSTRAINT spcr_decision_is_complete CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL)
  ),
  CONSTRAINT fk_spcr_variant_tenant FOREIGN KEY (variant_id, tenant_id)
    REFERENCES social_post_variants (id, tenant_id),
  CONSTRAINT fk_spcr_client_tenant FOREIGN KEY (client_id, tenant_id)
    REFERENCES clients (id, tenant_id)
);
-- The portal list ("posts awaiting my approval") — the hot path, and the queue the client sees.
CREATE INDEX ix_spcr_client_pending ON social_post_client_reviews (tenant_id, client_id)
  WHERE status = 'pending';
COMMENT ON TABLE social_post_client_reviews IS
  'PLAIN CORE TENANT WALL, deliberately — NOT the app_module_allowed(''social'') third wall the rest '
  'of this module carries (addendum D-16, 0088''s D-2a lesson). The client portal is this table''s '
  'primary writer and portal controllers declare no module scope, so a third wall here would read '
  'ZERO ROWS, silently, on every portal query. Do not "fix" this for consistency.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (10) social_inbox_threads / (11) social_inbox_messages — the engagement inbox. Sync is idempotent
--      on the upstream ids; outbound replies are one-shot-gated exactly like publishes.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_inbox_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  account_id uuid NOT NULL REFERENCES social_accounts(id),
  network text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comment','dm','mention','review')),
  external_thread_id text NOT NULL,
  post_variant_id uuid REFERENCES social_post_variants(id),   -- set when the comment is on our post
  author_handle text,
  author_name text,
  excerpt text,
  sentiment text CHECK (sentiment IN ('positive','neutral','negative','urgent')),  -- AI-stamped
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','replied','escalated','dismissed','closed')),
  assigned_to uuid REFERENCES users(id),
  sla_due_at timestamptz,
  last_message_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- The idempotency key the 15-minute pull relies on: re-running a sync produces zero duplicates.
  UNIQUE (account_id, external_thread_id),
  CONSTRAINT fk_social_inbox_threads_account_tenant FOREIGN KEY (account_id, tenant_id)
    REFERENCES social_accounts (id, tenant_id),
  CONSTRAINT ux_social_inbox_threads_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_social_inbox_threads_queue ON social_inbox_threads (tenant_id, status, last_message_at DESC)
  WHERE deleted_at IS NULL;
-- The SLA guard (smm-inbox-sla-guard, every 15 min): what is about to breach.
CREATE INDEX ix_social_inbox_threads_sla ON social_inbox_threads (tenant_id, sla_due_at)
  WHERE status = 'open' AND sla_due_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE social_inbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  thread_id uuid NOT NULL REFERENCES social_inbox_threads(id),
  direction text NOT NULL CHECK (direction IN ('in','out')),
  external_id text,                                    -- NULL until an outbound reply is sent
  body text NOT NULL DEFAULT '',
  author_handle text,
  posted_at timestamptz,
  source text NOT NULL DEFAULT 'postiz_sync' CHECK (source IN ('postiz_sync','reply')),
  -- Outbound only — the same one-shot machinery as a publish (design §07.3, addendum D-15).
  approval_id uuid REFERENCES automation_approvals(id),
  args_sha256 text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','in_review','approved','sent','failed')),
  last_error text,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- An inbound message is only ever synced, and a sent reply is only ever outbound. Both halves of
  -- that have been assumed rather than enforced in other systems, and the result is a "reply" row
  -- with no approval behind it.
  CONSTRAINT sim_sent_reply_has_approval CHECK (
    direction = 'in' OR status <> 'sent' OR (approval_id IS NOT NULL AND args_sha256 IS NOT NULL)
  ),
  CONSTRAINT fk_social_inbox_messages_thread_tenant FOREIGN KEY (thread_id, tenant_id)
    REFERENCES social_inbox_threads (id, tenant_id)
);
CREATE INDEX ix_social_inbox_messages_thread ON social_inbox_messages (tenant_id, thread_id, posted_at);
-- Sync idempotency (partial: NULL external_id is a not-yet-sent draft, and NULLs are distinct).
CREATE UNIQUE INDEX ux_social_inbox_messages_external ON social_inbox_messages (thread_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX ux_social_inbox_messages_approval ON social_inbox_messages (approval_id)
  WHERE approval_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (12) social_kpi_targets / (13) social_metrics_daily / (14) social_post_metrics — the outcome
--      commitments and the two time series that measure them. `social_metrics_daily` IS the cache
--      (design D-4): analytics pulls are $0, so nothing is cached outside a tenant row.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_kpi_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL REFERENCES social_engagements(id),
  metric_key text NOT NULL,        -- canonical: followers_total|reach_month|engagement_rate|
                                   -- link_clicks_month|avg_response_minutes|posts_published_month|leads_attributed
  baseline_value numeric,
  target_value numeric NOT NULL,
  direction text NOT NULL DEFAULT 'up' CHECK (direction IN ('up','down')),
  due_period text,                 -- 'YYYY-MM' or a free label
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_social_kpi_targets_engagement_tenant FOREIGN KEY (engagement_id, tenant_id)
    REFERENCES social_engagements (id, tenant_id)
);
CREATE INDEX ix_social_kpi_targets_engagement ON social_kpi_targets (tenant_id, engagement_id) WHERE deleted_at IS NULL;

CREATE TABLE social_metrics_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  account_id uuid NOT NULL REFERENCES social_accounts(id),
  date date NOT NULL,
  followers integer,
  impressions integer,
  reach integer,
  engagements integer,
  link_clicks integer,
  video_views integer,
  raw jsonb NOT NULL DEFAULT '{}',
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The nightly pull's ON CONFLICT target: re-running a day is an update, never a duplicate.
  UNIQUE (account_id, date),
  CONSTRAINT fk_social_metrics_daily_account_tenant FOREIGN KEY (account_id, tenant_id)
    REFERENCES social_accounts (id, tenant_id)
);
CREATE INDEX ix_social_metrics_daily_series ON social_metrics_daily (tenant_id, account_id, date DESC);

CREATE TABLE social_post_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  variant_id uuid NOT NULL REFERENCES social_post_variants(id),
  impressions integer,
  likes integer,
  comments integer,
  shares integer,
  saves integer,
  video_views integer,
  clicks integer,
  fetched_at timestamptz NOT NULL DEFAULT now(),       -- APPEND-ONLY snapshots
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_social_post_metrics_variant_tenant FOREIGN KEY (variant_id, tenant_id)
    REFERENCES social_post_variants (id, tenant_id)
);
CREATE INDEX ix_social_post_metrics_variant ON social_post_metrics (variant_id, fetched_at DESC);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (15) social_reports — the client-facing engagement report. A DIFFERENT GRAIN from the reports
--      module's four internal grains (company/department/person/project), exactly as search_reports
--      is — but the RENDERING and delivery reuse the existing report-renderer + print-payload
--      pipeline (addendum Δ13). Nothing here re-implements a renderer.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL REFERENCES social_engagements(id),
  period text,
  kind text NOT NULL DEFAULT 'monthly' CHECK (kind IN ('monthly','campaign','adhoc')),
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
  deleted_at timestamptz,
  CONSTRAINT fk_social_reports_engagement_tenant FOREIGN KEY (engagement_id, tenant_id)
    REFERENCES social_engagements (id, tenant_id)
);
CREATE INDEX ix_social_reports_engagement ON social_reports (tenant_id, engagement_id, period) WHERE deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (16) social_usage_ledger — the ONE metering ledger (design D-9, mirroring search_provider_calls).
--      APPEND-ONLY. Feeds the stop-loss chain (engagement usage_budget_usd → tenant cap → global
--      cap, fail-closed) which is checked at ONE choke-point before dispatch AND re-checked inside
--      the D14 execution precondition (addendum D-14).
--
--      'ai_image'/'ai_video' are admitted by the CHECK but INERT in v1 (addendum D-17): there is no
--      generative backend to spend against yet. They are here so the ledger does not need a
--      migration the day the Creative render gateway lands — not because anything writes them.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE social_usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid REFERENCES social_engagements(id),
  account_id uuid REFERENCES social_accounts(id),
  kind text NOT NULL CHECK (kind IN ('x_post','ai_image','ai_video','ai_cloud_text')),
  ref_id uuid,                                         -- variant / asset / report the spend served
  items integer NOT NULL DEFAULT 1,
  cost_usd numeric(12,6) NOT NULL,                     -- estimated at dispatch, trued-up on completion
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','completed','failed')),
  requested_by uuid REFERENCES users(id),              -- human or the automation OBO user
  correlation_id text,                                 -- n8n run / MCP call id
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_social_usage_ledger_engagement ON social_usage_ledger (tenant_id, engagement_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the ONE composed tenant_isolation policy per THIRD-WALLED table. Written once in a DO
-- loop so the predicate can never drift per-table: every table below gets the byte-identical
-- `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social')` on BOTH USING (reads)
-- and WITH CHECK (writes). app_current_tenants() (0025) and app_module_allowed() (0028) already
-- exist as PUBLIC-EXECUTE inlinable STABLE helpers; this migration only composes them.
-- Unset/empty GUC -> NULL -> `= ANY(NULL)` -> false, i.e. fail-closed.
--
-- TWO TABLES ARE INTENTIONALLY ABSENT and neither is an oversight:
--   * social_platform_apps        — global, no tenant_id, no RLS at all (D-4; see its COMMENT).
--   * social_post_client_reviews  — PLAIN core wall, applied separately below (D-16; see its COMMENT).
-- Every listed table has a tenant_id column, so rls.test.ts's FORCE-RLS sweep covers all 14 for free.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'social_engagements','social_brand_profiles','social_publisher_orgs','social_accounts',
    'social_campaigns','social_posts','social_post_variants','social_inbox_threads',
    'social_inbox_messages','social_kpi_targets','social_metrics_daily','social_post_metrics',
    'social_reports','social_usage_ledger'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''social''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''social''))',
      t
    );
  END LOOP;
END $$;

-- FORCE RLS, PLAIN tenant wall for the one portal-written table — byte-identical to 0088's block
-- (which is byte-identical to 0075's, with the 0025 NULLIF hardening). NO app_module_allowed()
-- clause, deliberately (D-16 / D-2a). NO principal_lookup policy either: nothing reads this table
-- during principal assembly — every read runs under withTenants.
ALTER TABLE social_post_client_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_post_client_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON social_post_client_reviews;
CREATE POLICY tenant_isolation ON social_post_client_reviews FOR ALL
  USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]));
