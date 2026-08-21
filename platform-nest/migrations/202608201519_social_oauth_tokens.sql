-- SMM-38 phase 38b — the `direct` driver's TOKEN CUSTODY table (owner decision D-20, design
-- addendum §PD). This is the migration §PD's own phasing table names for 38b: "encrypted-at-rest
-- token table on the tenant wall" — senior-db's call, per SMM-36's inbox-retention-job.ts header
-- ("What SMM-38 phase 38b MUST implement... 1. Its own encrypted-at-rest token table, on the tenant
-- wall (schema is senior-db's call, not this ticket's — SMM-36 does not create it)").
--
-- ── WHY THIS TABLE EXISTS AT ALL, AND WHY IT REVERSES D-5 ───────────────────────────────────────
-- D-5 put every client's network OAuth token INSIDE Postiz, on purpose, so this platform never held
-- one. D-20 (2026-08-18) reverses that for the two networks the `direct` driver serves first
-- (LinkedIn, YouTube — 38c/38d): once we speak OAuth ourselves, WE mint and refresh those tokens,
-- and they must live somewhere. This table is that somewhere. It is deliberately NOT a generalization
-- of `integration_connections` (0033, WSUX-14's GitHub/Google-Drive/Claude vault): that table is a
-- CORE, per-person-or-company link with no module wall, and folding a client-network credential into
-- it would put a live publishing secret behind a different authz surface than the rest of this
-- module's client data — this table instead follows 0105's own tables (`social_accounts` FK,
-- `app_module_allowed('social')` third wall) so its exposure surface, its lint coverage
-- (`lint:withtenants`) and its access story are identical to every other row this module holds.
--
-- ── THE ENCRYPTION MECHANISM — REUSED, NOT INVENTED ─────────────────────────────────────────────
-- `src/core/secret-box.ts` (WSUX-14 decision #7) is this estate's ONE existing app-layer credential
-- vault: AES-256-GCM, key from env `INTEGRATION_TOKEN_KEY` (base64, 32 bytes), ciphertext shaped
-- `enc:v1:<iv_b64>:<tag_b64>:<data_b64>`, FAIL-CLOSED (throws 503 with no key configured — a token
-- can never be written unencrypted). It already seals `integration_connections.{access,refresh}
-- _token_enc` for exactly this job (external-provider OAuth tokens at rest) and it is NOT a
-- wa-chat-bot-style two-axis (subject × entity) envelope scheme with OpenBao Transit key destruction
-- as the crypto-shred — that mechanism (`docs/runbooks/key-custody.md`) is wired into wa-chat-bot
-- ONLY; platform-nest carries no OpenBao client and secret-box.ts's own header says so explicitly
-- ("not wired into platform-nest ... decision #7 chose app-layer AES-256-GCM for v1"). So this table
-- reuses secret-box.ts byte-for-byte — same `enc:v1:` format, same `token_key_version` column
-- convention — rather than inventing a second scheme or reaching for infrastructure this service does
-- not have. See the ERD-shed note below for how THIS table achieves a shred with a single global key.
--
-- ── THE SHRED, WITHOUT A PER-SUBJECT KEY ────────────────────────────────────────────────────────
-- secret-box.ts has ONE key for the whole deployment (no per-subject/per-entity wrapping), so
-- "destroy the key" is not this table's shred primitive. `src/core/integrations.service.ts`'s own
-- `revokeConnection` already establishes the pattern this table follows: "status = 'revoked',
-- access_token_enc = NULL, refresh_token_enc = NULL, row KEPT" — deleting the ONLY ciphertext copy
-- IS the shred (there is nothing left anywhere to decrypt), and the row survives as a shell exactly
-- like SMM-36's inbox purge preserves a thread/message shell after scrubbing its content. The
-- `sot_shred_contract` CHECK below makes that structural rather than a convention a future UPDATE
-- could violate: a `revoked`/`expired` row CANNOT carry ciphertext in either column, full stop.
--
-- ── WHICH RLS WALL, AND WHY (ticket's own required decision) ───────────────────────────────────
-- THIRD WALL — `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social')` — the SAME
-- wall every social_* table takes except `social_post_client_reviews` (0105 D-16). That table is the
-- ONE deliberate exception because the CLIENT PORTAL is its primary writer, and portal controllers
-- declare no module scope. This table's writers are the OPPOSITE case: the OAuth callback finalize
-- route (38c/38d, staff-initiated connect flow), the revoke action (staff/manager initiated), and the
-- refresh-ahead purge sweep (`inbox-retention-job.ts`'s per-tenant transaction, which already
-- declares the module scope via `declareSocialModuleScope` before any registered purger runs) — all
-- of them are social-module code, none of them are portal controllers. So the third wall is the
-- correct, consistent choice; giving this table the plain wall "to be safe" would be D-16's exact
-- mistake in reverse (a wall that does not match its actual writers).
--
-- ── REFRESH-AHEAD AND THE PURGE/SHRED SEAM ──────────────────────────────────────────────────────
-- `expires_at` is the access-token deadline; `refresh_expires_at` is the (nullable) deadline on the
-- REFRESH token itself (LinkedIn's own refresh tokens expire too — addendum §A4e). Application code
-- (`src/modules/social/publisher/oauth-tokens.ts`) finds grants approaching `expires_at` and, if a
-- per-network refresher is registered (none is, in 38b — see that file's header), refreshes them
-- before they lapse; grants that reach `expires_at` unrefreshed (no refresher registered, or a
-- refresh attempt failed) are shredded to `status='expired'` by the SAME purger this migration's
-- sibling ticket asked for: `registerRetentionPurger('oauth_tokens', ...)` in `inbox-retention-job.ts`
-- (SMM-36's seam), riding the identical per-tenant sweep, schedule and module-scope declaration — no
-- new job, no new schedule.
--
-- ── NO DML, NO BACKFILL ──────────────────────────────────────────────────────────────────────────
-- Brand-new table, zero rows anywhere (38c/38d, the only writers of a real grant, have not shipped),
-- so the 0050 NOBYPASSRLS backfill trap does not apply. Self-asserted below anyway per the
-- 0106/0112/0113/0114/0118 discipline: never trust, always assert what actually landed.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────────────
-- The sequential `NNNN_` scheme is CLOSED above 0118 (0119 grandfathered by name only — see
-- `scripts/lint-migration-names.mjs`). This file uses the UTC-timestamp scheme
-- (`date -u +%Y%m%d%H%M` at write time: 202608201518), per `migrations/README.md`'s 2026-08-19
-- protocol change.
--
-- ⚠ Referenced-but-missing at worktree-cut time: the ticket briefing said "three timestamped
-- migrations already exist" as the shape to follow; this worktree contains exactly ONE
-- (`202608191417_iam_monitoring_permissions_completion.sql`) at the time this file was written. Noted
-- per this program's own cross-session-hazards rule ("worktrees can be cut before a commit made in
-- the same turn") rather than silently assumed away — the one that IS present, plus the lint script's
-- own documented format, were enough to follow the shape correctly.

CREATE TABLE social_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  account_id uuid NOT NULL REFERENCES social_accounts(id),
  -- Duplicated off social_accounts.network (0105's own convention — social_inbox_threads does the
  -- same) so a per-network scan (the refresh-ahead sweep, the purger) is a plain index lookup on
  -- this table and never needs a join back to social_accounts just to filter by network.
  network text NOT NULL CHECK (network IN ('instagram','facebook','tiktok','linkedin','x',
    'youtube','threads','pinterest','bluesky','mastodon')),
  -- VAULT COLUMNS — secret-box.ts `enc:v1:` ciphertext ONLY, exactly like
  -- integration_connections.{access,refresh}_token_enc (0033). NEVER plaintext, NEVER serialized by
  -- any controller. Nullable: a revoked/expired grant carries NEITHER (the shred — see header and
  -- the CHECK below).
  access_token_enc text,
  refresh_token_enc text,
  token_key_version text NOT NULL DEFAULT 'v1',
  scopes jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  last_refreshed_at timestamptz,
  -- A revoked grant's audit trail. Kept even after the shred — "who revoked this and why" must
  -- survive the ciphertext it revoked.
  revoked_at timestamptz,
  revoked_reason text,
  granted_by uuid REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One live grant per connected account. A re-consent (a fresh OAuth round trip on the SAME
  -- account) UPSERTs this row rather than accumulating a second one — same reasoning as
  -- integration_connections' per-(owner,provider) UNIQUE.
  UNIQUE (account_id),
  CONSTRAINT fk_social_oauth_tokens_account_tenant FOREIGN KEY (account_id, tenant_id)
    REFERENCES social_accounts (id, tenant_id),
  CONSTRAINT ux_social_oauth_tokens_id_tenant UNIQUE (id, tenant_id),
  -- THE SHRED CONTRACT, STRUCTURAL (see header): a live grant MUST carry an access token; a
  -- revoked/expired grant MUST carry neither ciphertext column. This makes "revoke without shredding"
  -- impossible at the database, not merely a convention a future hand-written UPDATE could violate.
  CONSTRAINT sot_shred_contract CHECK (
    (status = 'active' AND access_token_enc IS NOT NULL)
    OR (status IN ('revoked','expired') AND access_token_enc IS NULL AND refresh_token_enc IS NULL)
  ),
  -- A revoked row must say who/why/when; any other row must not pretend to have been revoked.
  CONSTRAINT sot_revocation_is_complete CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL AND revoked_reason IS NULL)
  )
);

-- The refresh-ahead scan's own index: "which active grants on network N, this tenant, need a look".
CREATE INDEX ix_social_oauth_tokens_refresh_due
  ON social_oauth_tokens (tenant_id, network, expires_at) WHERE status = 'active';

COMMENT ON TABLE social_oauth_tokens IS
  'SMM-38/38b (D-20, addendum §PD) — in-house OAuth token custody for the networks the ''direct'' '
  'publisher driver serves (LinkedIn/YouTube first, 38c/38d). THIRD RLS WALL, same as every social_* '
  'table except social_post_client_reviews (0105 D-16 is a portal-writer exception that does not '
  'apply here). Vault columns are secret-box.ts enc:v1 ciphertext ONLY, reused from '
  'integration_connections (0033) rather than a new scheme. Revocation/expiry SHREDS: '
  'access_token_enc/refresh_token_enc are NULLed (sot_shred_contract), never merely flagged — the row '
  'survives as an audit shell. Never log, return, or embed either ciphertext or the decrypted '
  'plaintext; see src/modules/social/publisher/oauth-tokens.ts.';

-- FORCE RLS, THIRD WALL — byte-identical predicate to 0105's DO-loop block, applied here as an
-- explicit statement (no loop needed for a single table) so it cannot silently drift from that text.
ALTER TABLE social_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_oauth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_oauth_tokens FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social'));

-- ── SELF-ASSERTION (0106/0112/0113/0114/0118 idiom) ─────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables WHERE table_name = 'social_oauth_tokens';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected social_oauth_tokens to exist, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conname IN ('sot_shred_contract', 'sot_revocation_is_complete',
                      'fk_social_oauth_tokens_account_tenant', 'ux_social_oauth_tokens_id_tenant');
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected 4 named constraints on social_oauth_tokens, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes WHERE indexname = 'ix_social_oauth_tokens_refresh_due';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected ix_social_oauth_tokens_refresh_due to exist, found %', n;
  END IF;

  -- FORCE RLS actually landed (a typo'd table/policy name would not error the way a SELECT would).
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE c.relname = 'social_oauth_tokens' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected social_oauth_tokens to have ENABLE+FORCE row level security, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'social_oauth_tokens' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected a tenant_isolation policy on social_oauth_tokens, found %', n;
  END IF;

  -- No DML above, so a fresh table must have zero rows — the floor every later assertion assumes.
  SELECT count(*) INTO n FROM social_oauth_tokens;
  IF n <> 0 THEN
    RAISE EXCEPTION 'expected social_oauth_tokens to be empty immediately after creation, found % rows', n;
  END IF;
END $$;
-- Behavioural coverage (the module-GUC regression, encrypt/decrypt round trip, revocation-fails-
-- closed, the shred-on-revoke/expire property against real rows, and the SMM-36 purger seam) lives
-- in `src/modules/social/publisher/oauth-tokens.test.ts` against the repo's own `initTestDb` harness
-- — deliberately not attempted here with synthetic FK values (0113's own reasoning: an FK violation
-- and a CHECK violation would be indistinguishable, turning this assertion into a false pass).
