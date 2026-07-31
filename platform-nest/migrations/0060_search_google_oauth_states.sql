-- SM-25a — the in-flight Google authorization-request store (design addendum §A12, binding).
--
-- ── NUMBERING (rule 5, migrations/README.md) ───────────────────────────────────────────────────────
-- `ls migrations | tail` at write time showed head = 0057_report_metric_seeds.sql. The README's
-- reservation table still holds 0058 for TR-14 (report_periods/report_documents) and 0059 for TR-23
-- (appraisal tables) — neither implemented yet, both potentially in flight in a concurrent session
-- while this file is being written. Rather than consume a reserved slot and force a second
-- rebase-in-flight on a program that has already hit two, this takes the first slot BEYOND the
-- reservation: 0060. Gaps are harmless (the runner sorts filenames lexicographically and skips nothing).
--
-- ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────────────────
-- ONE table: search_google_oauth_states — an in-flight authorization-code request. It holds the PKCE
-- code_verifier (SEALED, never plaintext) and the binding facts the callback must re-verify.
--
-- It is NOT a second credential vault. The tokens themselves land in the EXISTING 0033 vault
-- (integration_connections.access_token_enc / refresh_token_enc, AES-256-GCM via src/core/secret-box.ts,
-- `hasToken`-only reads), whose CHECK constraints 0035 already widened for exactly these providers
-- (google_search_console | google_analytics | google_ads) and for owner_kind='client'. Nothing here
-- duplicates that; this row is deleted-by-consumption metadata about a flow that is still in progress.
--
-- It is ALSO NOT a place any Google DATA lands. Search Console / GA4 / Ads rows are SM-25b/SM-25c's
-- tables. Stated here because the constraint is worth repeating at every Google touchpoint:
-- search_data_cache is deliberately NO-RLS shared market data (0034's own COMMENT, owner-ratified
-- D-4), so a client's private Search Console rows in it would be a cross-tenant leak BY CONSTRUCTION,
-- not by bug. Every Google-derived table is tenant-scoped and FORCE-RLS'd, like this one.
--
-- ── PROVENANCE: `simulated` FROM DAY ONE (§A12.2, the §A8.2 external-import precedent) ────────────
-- Semantics on THIS table, stated precisely so no reader has to guess (the §A4.7 duty):
--   simulated = false  -> the authorization request was issued against GOOGLE'S OWN issuer host.
--   simulated = true   -> it was issued against something else: the local Keycloak `google-dev` realm
--                        client, or SM-51's in-process sandbox token machine.
-- This is the SAME "audience, not label" ruling §A10.2 made for vendor rows, transposed: the boolean
-- records what a row descends from, and the honesty carrier for the resulting CONNECTION is the
-- issuer host recorded on integration_connections.meta (§A12.3 rules that proportionate — connection
-- rows are tenant-scoped credential metadata, not cross-tenant market data with dollars attached, so
-- they get an issuer-host disclosure rather than §A10's full ceremony).
--
-- ── RLS ───────────────────────────────────────────────────────────────────────────────────────────
-- FORCE ROW LEVEL SECURITY + the byte-identical composed policy every other search_* table carries
-- (0034's DO-loop shape): tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search').
-- A row holding a PKCE verifier must be no more reachable than an engagement row.
--
-- ── NO DML ────────────────────────────────────────────────────────────────────────────────────────
-- CREATE-only: no UPDATE, no DELETE, no INSERT...SELECT, no backfill of any kind. Stated explicitly
-- because scripts/lint-migration-rls.mjs going green on this file is meaningful only if the file
-- genuinely contains no row-set-determined DML (§6ai: read the file, do not trust the green). It does
-- not — there is nothing to backfill, since no authorization request can exist before the code that
-- creates one. Runtime DML grants come from the owner's ALTER DEFAULT PRIVILEGES + RUNTIME_GRANTS_SQL
-- pass (migrations/README.md) — no in-migration GRANTs.

CREATE TABLE search_google_oauth_states (
  -- The state ID. Travels to the issuer inside a SIGNED, tenant-carrying `state` parameter
  -- (modules/search/google/oauth-state.ts) — never bare, so a valid-looking id alone is not a
  -- redeemable state, and the callback can recover the tenant without a cross-tenant read.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- The client whose OWN Google account is being linked (0035's owner_kind='client'; the resulting
  -- vault row is owner_id = this clients.id). Per-client OAuth is the whole point of §A12's third
  -- egress class: this credential is not the agency's, it is the client's.
  client_id uuid NOT NULL REFERENCES clients(id),
  -- Optional destination binding: which property's gsc/ga4/ads_connection_id (0034:52-54) this link is
  -- meant to fill. Nullable because a connection may legitimately be established before it is bound.
  property_id uuid REFERENCES search_properties(id),
  provider text NOT NULL CHECK (provider IN ('google_search_console', 'google_analytics', 'google_ads')),
  -- PKCE (RFC 7636). The VERIFIER is a secret: sealed with the same AES-256-GCM box as the vault
  -- (`enc:v1:` format), so a database read alone cannot complete someone else's in-flight exchange.
  -- The CHALLENGE is public by construction (it already travelled to the issuer in the authorize URL)
  -- and is kept in the clear for audit + for the sandbox's own strictness checks.
  code_verifier_enc text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
      -- S256 ONLY. `plain` is permitted by RFC 7636 for constrained clients and is worthless for a
      -- server-side confidential client: a CHECK is cheaper than a code review.
  -- Re-verified at callback against the CURRENT config value. A rotated redirect URI must invalidate
  -- in-flight requests rather than silently complete against the old one.
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  -- The issuer host this request was actually sent to — the §A12.3 honesty carrier, and what
  -- `simulated` below is derived from at INSERT time.
  issuer_host text NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  -- The principal who STARTED the flow. The callback refuses when the caller is someone else: without
  -- it, an attacker who gets a victim's browser to hit the callback with the attacker's own
  -- authorization code could bind the ATTACKER's Google account into the victim's tenant.
  created_by uuid REFERENCES users(id),
  -- Filled on successful completion, purely for audit/debug (the vault row is the real artifact).
  connection_id uuid REFERENCES integration_connections(id),
  expires_at timestamptz NOT NULL,
  -- SINGLE USE. The callback's atomic `UPDATE ... WHERE consumed_at IS NULL RETURNING` is what makes
  -- authorization-code replay impossible: the second presentation of the same state matches zero rows.
  consumed_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Pruning sweep + "is anything in flight for this client/provider?" reads.
CREATE INDEX ix_search_google_oauth_states_expiry ON search_google_oauth_states (expires_at) WHERE consumed_at IS NULL;
CREATE INDEX ix_search_google_oauth_states_owner ON search_google_oauth_states (tenant_id, client_id, provider);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE search_google_oauth_states ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE search_google_oauth_states FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON search_google_oauth_states';
  EXECUTE
    'CREATE POLICY tenant_isolation ON search_google_oauth_states FOR ALL
       USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
       WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))';
END $$;

COMMENT ON TABLE search_google_oauth_states IS
  'SM-25a in-flight Google authorization-code requests (design addendum §A12). Holds a SEALED PKCE '
  'code_verifier; single-use via consumed_at. NOT a second credential vault — issued tokens land in '
  'the 0033 integration_connections vault (0035 widened its provider/owner_kind CHECKs for exactly '
  'these providers). simulated=false means the request went to Google''s own issuer; true means a '
  'local Keycloak/sandbox issuer (§A12.2, audience-not-label).';
