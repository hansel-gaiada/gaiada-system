-- WD-23A-1 — promote the in-flight Google authorization-request store from the `search` module into
-- CORE, so surfaces outside search (webdev's Drive link, WD-23A-2) can use the ONE hardened OAuth
-- state machine instead of a second one.
-- Re-spec: docs/superpowers/plans/2026-08-01-wd23a-respec.md §4.2.
--
-- ── NUMBERING (rule 5, migrations/README.md) ───────────────────────────────────────────────────────
-- Re-verified at LANDING time, not inherited: this file was authored as `0070` when the head was
-- 0069_report_module_roles.sql, but it sat staged outside `migrations/` while five more landed. Head is
-- now 0075_client_portal.sql, so this takes **0076**. Rule 5 is explicit that the second ticket to
-- merge bumps, and the mail subsystem's plan had pencilled 0076 for its own core migration — its
-- tickets say "build-time next-unused", so it re-verifies and moves to 0077. `0058`/`0059` remain the
-- reports programme's permanently-orphaned reservation gaps, and `0070` is now one too: do NOT fill them.
--
-- It was parked outside the runner's directory on purpose, because the runner executes the WHOLE folder
-- and this file DROPs `search_google_oauth_states` — landing it early would have taken search's OAuth
-- flow down until the code move caught up. The code move is in the same commit as this rename.
-- `0058`/`0059` remain the reports program's permanently-orphaned reservation gaps: do NOT fill them.
--
-- ── WHY A REPLACEMENT AND NOT AN ALTER + BACKFILL (the enabling observation) ───────────────────────
-- `search_google_oauth_states` rows are IN-FLIGHT authorization requests with a 10-minute TTL
-- (GOOGLE_OAUTH_STATE_TTL_SECONDS, default 600). There is NO durable data in this table — every row
-- either gets consumed within minutes or expires and becomes unusable (the consume predicate itself
-- refuses expired rows, so an unpruned row is already dead: oauth-state.ts attack A8).
--
-- So this migration DROPs it and creates the core table fresh. The worst case is that a handful of
-- half-finished link attempts in flight at deploy time stop working, and their remedy is already the
-- one users hit on any expiry: start the flow again (the `unknown_or_expired` branch). That is a
-- strictly smaller risk than a dual-write/backfill window over a table holding sealed PKCE verifiers.
--
-- REVIEWER NOTE, stated so nobody goes looking for the missing backfill: the absence of DML here is
-- deliberate and is the whole point. This file contains no UPDATE, no DELETE-with-a-row-set, no
-- INSERT...SELECT — nothing whose effect depends on which rows RLS lets the migration runner see.
-- That matters on this estate: migrations run as `platform_owner`, which has NO BYPASSRLS (the
-- 2026-07-15 DB-topology role split), so a backfill against a FORCE-RLS table with no tenant GUC set
-- silently affects ZERO rows and still reports success. That defect shipped twice already
-- (0050 -> fixed by 0051). The correct way to avoid it here is to have nothing to backfill.
--
-- ── WHAT CHANGES vs 0060, AND WHY EACH CHANGE IS SAFE ─────────────────────────────────────────────
-- 1. `provider` CHECK widened to include 'google_drive' (0033's vault CHECK ALREADY permits that
--    provider and `owner_kind='user'`, so no vault DDL is needed anywhere — only this table rejected
--    Drive).
-- 2. `client_id uuid NOT NULL REFERENCES clients(id)` -> polymorphic `owner_kind` + `owner_id`,
--    mirroring the resulting vault row exactly (0033:17-18 / 0035's own 'client' widening, which
--    documents "NO FK — same convention as the polymorphic owner_id"). A Drive link is owned by a
--    USER, not a client, so a NOT NULL FK to clients(id) is structurally wrong for it.
--    LOSING THAT FK COSTS NO TENANT SAFETY, and this is not a judgement call: oauth.ts's own header
--    (see `bindPropertyConnection`) records that FK checks run as the table OWNER, OUTSIDE RLS — the
--    FK was never the cross-tenant protection. The protection is, and remains, that every read/write
--    goes through `withTenants([signedTenantId], ...)`, so a foreign owner_id matches zero rows.
-- 3. `property_id uuid REFERENCES search_properties(id)` -> generic `bind_target_id uuid` with NO FK.
--    A core table must not depend on a module's table (that dependency points the wrong way through
--    the D-2 wall). The meaning of `bind_target_id` is delegated to the registered surface's own
--    post-link hook: search reads it as a search_properties id and resolves it through its existing
--    tenant+module-scoped query, which returns zero rows for anything foreign — the same "no rows"
--    outcome the FK would have produced, via the mechanism that actually enforces tenancy.
-- 4. NEW `module text NULL` + a CONDITIONAL RLS predicate. This is the load-bearing addition.
--    0060's policy hard-codes `app_module_allowed('search')`, which is search's third wall. A shared
--    core table cannot hard-code one module's name -- but dropping the gate entirely would silently
--    REMOVE that wall from search's OAuth flow, which would be a security regression smuggled in as
--    a refactor. So the gate becomes per-row: a row that names a module is reachable only when that
--    module is allowed for the tenant; a row with `module IS NULL` is core and carries no module gate.
--    Search's surfaces stamp module='search' and therefore keep byte-equivalent protection; Drive
--    stamps NULL and needs no module. The tenant wall is unconditional for both.
--
-- Unchanged from 0060 and deliberately re-stated (do not "tidy" these): FORCE ROW LEVEL SECURITY; the
-- S256-only CHECK (a CHECK is cheaper than a code review); the SEALED code_verifier (a DB read alone
-- must not let anyone complete someone else's in-flight exchange) beside the deliberately-cleartext
-- code_challenge (already public — it travelled to the issuer in the authorize URL); `created_by` (the
-- anti-login-CSRF binding, attack A1); single-use `consumed_at` (the anti-replay mechanism, A3);
-- `issuer_host` + `simulated` (the §A12.2/§A12.3 provenance carriers, derived at INSERT, never
-- caller-supplied); `origin_site`.

CREATE TABLE google_oauth_states (
  -- Travels to the issuer inside a SIGNED, tenant-carrying `state` parameter
  -- (src/core/google-oauth/state.ts) — never bare, so a valid-looking id alone is not redeemable and
  -- the callback recovers the tenant without a cross-tenant read.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),

  -- WHO the resulting credential belongs to. Mirrors integration_connections (0033:38 + 0035) so the
  -- state row and the vault row it produces describe ownership identically:
  --   'user'    -> owner_id = users.id      (a person's own connection; webdev Drive)
  --   'company' -> owner_id = companies.id  (an org-level connection)
  --   'client'  -> owner_id = clients.id    (the client's own account; search GSC/GA4/Ads)
  -- Polymorphic, so NO FK — see the header's point 2 for why that costs no tenant safety.
  owner_kind text NOT NULL CHECK (owner_kind IN ('user', 'company', 'client')),
  owner_id uuid NOT NULL,

  -- The module whose third wall applies to this row, or NULL for a core surface. See header point 4:
  -- this is what lets one shared table preserve search's module gate without imposing it on core.
  module text,

  provider text NOT NULL CHECK (provider IN (
    'google_search_console',
    'google_analytics',
    'google_ads',
    'google_drive'
  )),

  -- Optional destination the completed connection should be bound to, interpreted by the registered
  -- surface's own post-link hook (search: a search_properties id -> gsc/ga4/ads_connection_id).
  -- Nullable because a connection may legitimately be established before it is bound. No FK: header 3.
  bind_target_id uuid,

  -- PKCE (RFC 7636). The VERIFIER is a secret, sealed with the same AES-256-GCM box as the vault
  -- (`enc:v1:`). The CHALLENGE is public by construction and kept clear for audit + sandbox strictness.
  code_verifier_enc text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),

  -- Re-verified at callback against the CURRENT config value: a rotated redirect URI must invalidate
  -- in-flight requests rather than silently complete against the old one (attack A5).
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',

  -- The issuer host this request was actually sent to, and whether that host was Google's own.
  -- Derived at INSERT from the authorize URL — a caller cannot ask for a row stamped "real Google".
  issuer_host text NOT NULL,
  simulated boolean NOT NULL DEFAULT false,

  -- The principal who STARTED the flow; the callback refuses when the caller is someone else. Without
  -- it, an attacker who gets a victim's browser to hit the callback with the ATTACKER's own
  -- authorization code could bind the ATTACKER's Google account into the victim's tenant (A1).
  created_by uuid REFERENCES users(id),

  -- Filled on successful completion, purely for audit (the vault row is the real artifact).
  connection_id uuid REFERENCES integration_connections(id),

  expires_at timestamptz NOT NULL,
  -- SINGLE USE. The callback's atomic `UPDATE ... WHERE consumed_at IS NULL RETURNING` is what makes
  -- authorization-code replay impossible: the second presentation matches zero rows (A3).
  consumed_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Pruning sweep + "is anything in flight for this owner/provider?" reads.
CREATE INDEX ix_google_oauth_states_expiry ON google_oauth_states (expires_at) WHERE consumed_at IS NULL;
CREATE INDEX ix_google_oauth_states_owner ON google_oauth_states (tenant_id, owner_kind, owner_id, provider);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE google_oauth_states ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE google_oauth_states FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON google_oauth_states';
  -- The tenant wall is unconditional. The MODULE wall is per-row: NULL module => core surface, no
  -- module gate; a named module => that module must be allowed for the tenant, which reproduces
  -- 0060's `app_module_allowed('search')` exactly for every search-issued row.
  EXECUTE
    'CREATE POLICY tenant_isolation ON google_oauth_states FOR ALL
       USING (
         tenant_id = ANY(app_current_tenants())
         AND (module IS NULL OR app_module_allowed(module))
       )
       WITH CHECK (
         tenant_id = ANY(app_current_tenants())
         AND (module IS NULL OR app_module_allowed(module))
       )';
END $$;

COMMENT ON TABLE google_oauth_states IS
  'WD-23A-1 core in-flight Google authorization-code requests (promoted from search_google_oauth_states, '
  '0060). Holds a SEALED PKCE code_verifier; single-use via consumed_at. NOT a credential vault — issued '
  'tokens land in the 0033 integration_connections vault. owner_kind/owner_id mirror that vault row. '
  '`module` carries a per-row third-wall gate (NULL = core surface); the tenant wall is unconditional. '
  'simulated=false means the request went to Google''s own issuer; true means a local Keycloak/sandbox '
  'issuer (audience-not-label).';

COMMENT ON COLUMN google_oauth_states.bind_target_id IS
  'Optional destination for the completed connection, interpreted by the registered surface''s post-link '
  'hook (search: a search_properties id). Deliberately NO FK — a core table must not depend on a module''s '
  'table; the hook''s own tenant+module-scoped read is what refuses a foreign id.';

-- The module-local predecessor. Safe to drop outright: 10-minute-TTL in-flight rows only, no durable
-- data, and the consume predicate already refuses anything expired (see the header).
DROP TABLE IF EXISTS search_google_oauth_states;
