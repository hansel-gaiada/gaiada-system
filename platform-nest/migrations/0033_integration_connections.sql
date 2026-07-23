-- WSUX-14 (ex-P1-08) — F1 CONNECTIONS SUBSYSTEM: the integration-credential vault's data model.
-- Implements locked decision #6 (web-dev-phase1-tickets.md) — renumbered 0031 -> 0033 (Creative
-- consumed 0031/0032; see migrations/README.md numbering protocol + WS-UX v2 plan R-5).
--
-- ONE tenant-scoped CORE table: integration_connections. It is the single place a person (or a
-- company) links an external provider account (github | google_drive | claude) to the ERP, and the
-- AT-REST VAULT for that account's OAuth/API credentials. It is CORE, always-on (not gated behind
-- companies.enabled_modules) — every department and every future provider reuses it — so its RLS is
-- composed from app_current_tenants() ALONE (mirrors 0030_work_activity.sql), NOT the module-sliced
-- app_module_allowed() wall the hr_* tables carry (0028).
--
-- ── TENANCY (owner's locked decision, carried verbatim) ────────────────────────────────────────────
-- Connection links are PER-COMPANY (RLS-consistent): a person serving N companies re-links per
-- company in v1. There is NO cross-tenant / holding-wide path — a row's `tenant_id` is the company
-- the link lives in, and FORCE RLS bounds every read/write to app_current_tenants() exactly like
-- every other core row. (Shared-service-aware single-link-everywhere is DEFERRED — WS-UX §5.2.)
--   owner_kind='user'    -> owner_id = the platform user's id  (a person's own connection)
--   owner_kind='company' -> owner_id = the company's id (= tenant_id)  (a company/org-level connection)
-- owner_id is POLYMORPHIC (user id OR company id), so it carries NO FK — same convention as
-- work_activity_links.target_id (0030). tenant_id/created_by DO carry FKs.
--
-- ── THE VAULT (locked decision #7) ─────────────────────────────────────────────────────────────────
-- Tokens are stored ENCRYPTED AT REST ONLY, never as plaintext: access_token_enc / refresh_token_enc
-- hold app-layer AES-256-GCM ciphertext in the `enc:v1:<iv>:<tag>:<data>` format produced by
-- src/core/secret-box.ts (key from env INTEGRATION_TOKEN_KEY). token_key_version records which key
-- version sealed the row so a future OpenBao/KMS key can be rotated in without re-reading plaintext.
-- The API NEVER serializes these columns — reads return `hasToken:boolean` + metadata only (asserted
-- in tests; the WSUX-12 security gate probes for token exposure). Phase-1 HTTP create/patch accept NO
-- tokens; the encrypt path (service.setConnectionTokens) exists for the Phase-2 OAuth callbacks that
-- will ride this foundation.
--
-- Additive, CREATE-only. Runtime DML grants come from the owner's ALTER DEFAULT PRIVILEGES +
-- RUNTIME_GRANTS_SQL pass (migrations/README.md) — no in-migration GRANTs.

CREATE TABLE integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),   -- the company this link lives in (per-company, v1)
  owner_kind text NOT NULL CHECK (owner_kind IN ('user', 'company')),
  owner_id uuid NOT NULL,                              -- polymorphic: user id (user) OR company id (company); no FK
  provider text NOT NULL CHECK (provider IN ('github', 'google_drive', 'claude')),
  external_account text,                               -- github login / google email / claude seat email
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'unconfigured'
    CHECK (status IN ('unconfigured', 'pending', 'linked', 'error', 'revoked')),
  -- Vault columns — AES-256-GCM ciphertext ONLY (secret-box.ts `enc:v1:` format). NEVER serialized.
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  token_key_version text,                              -- e.g. 'v1' — which key sealed the tokens (rotation)
  meta jsonb NOT NULL DEFAULT '{}',                    -- provider extras, e.g. claude designLogin
  created_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- One connection per (company, owner, provider). Soft-revoke keeps the row (status='revoked'),
  -- so this UNIQUE also means a re-link re-uses the same row rather than accumulating duplicates.
  UNIQUE (tenant_id, owner_kind, owner_id, provider)
);
CREATE INDEX ix_integration_connections_owner
  ON integration_connections (tenant_id, owner_kind, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_integration_connections_provider
  ON integration_connections (tenant_id, provider) WHERE deleted_at IS NULL;

-- FORCE RLS + the standard tenant_isolation policy, composed from the 0025 helper
-- app_current_tenants() (mirrors 0030). CORE table -> NO app_module_allowed() wall.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON integration_connections FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;
