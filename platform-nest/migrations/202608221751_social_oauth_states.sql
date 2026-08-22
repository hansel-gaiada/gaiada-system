-- SMM security follow-up (named honestly by SMM-38c/38d's own file headers, closed here) — the
-- `direct` driver's LinkedIn/YouTube OAuth `state` parameter was HMAC-signed and time-boxed but NOT
-- single-use: `linkedin-oauth.ts`/`youtube-oauth.ts`'s own headers said so in as many words ("There is
-- deliberately NO database row and NO atomic single-use enforcement of the state token itself... a
-- future pass that wants full parity with the Google flow's DB-backed single-use guarantee would add a
-- small state table — flagged as a follow-up, not silently decided as unnecessary"). This migration is
-- that follow-up landing.
--
-- ── THE DEFECT, PRECISELY ────────────────────────────────────────────────────────────────────────
-- A signed-but-not-consumed state is replayable for its whole validity window (10 minutes,
-- STATE_TTL_MS in both files): an attacker who captures one callback URL (`?code=...&state=...`) can
-- re-drive it repeatedly until the token expires, and nothing at OUR layer distinguishes the first
-- presentation from the second. The two files' own headers already named the mitigating fact this
-- table does NOT rely on: LinkedIn's/Google's authorization `code` is separately single-use at THEIR
-- token endpoint. That is a real, working defense, but it is a defense outsourced to a third party for
-- a control this platform can enforce itself — and `core/google-oauth/state.ts` (this estate's OTHER
-- real OAuth-callback precedent, SM-25a) already proves the DB-backed pattern works and is not
-- expensive. This migration ports that pattern rather than inventing a second one.
--
-- ── WHY A NEW TABLE, AND NOT A PROMOTION INTO `google_oauth_states` (0076) ──────────────────────────
-- 0076 promoted the SEARCH module's own state table into CORE specifically because a SECOND module
-- (webdev, Drive) needed the identical Google-issuer machinery (PKCE, `code_verifier` sealing,
-- `owner_kind`/`owner_id` polymorphism). Nothing about LinkedIn's or YouTube's `direct`-driver OAuth
-- flow is shared outside the `social` module — no other module mints or consumes this state shape,
-- there is no PKCE verifier to seal (neither LinkedIn nor this driver's YouTube scope profile uses
-- PKCE), and the row's only job is "was this state minted by us, for this tenant/account/network, and
-- has it been used yet." Folding it into a CORE table that carries Google-specific PKCE columns would
-- either force those columns NULL for every LinkedIn row or force this module to fake a code_verifier
-- it doesn't have — both worse than a small, honestly-scoped table of our own. So this table follows
-- 0105's own convention instead (`social_accounts` FK, `app_module_allowed('social')` third wall),
-- exactly like `social_oauth_tokens` (202608201519) already does for the token side of this same
-- feature — same exposure surface, same lint coverage (`lint:withtenants`), same access story as every
-- other row this module holds.
--
-- ── RLS WALL DECISION (ticket's own required call) — THIRD WALL, TENANT-SCOPED ──────────────────────
-- This is NOT a core, cross-module table (see above), so it is not `module text NULL`-conditional like
-- 0076. It IS tenant-scoped: every row names a real `social_accounts` row a real tenant is trying to
-- connect, and a cross-tenant read/write here would let one tenant's staff claim or inspect another
-- tenant's in-flight connect ceremony. So: THIRD WALL, byte-identical predicate to
-- `social_oauth_tokens`'s own (202608201519) — `tenant_id = ANY(app_current_tenants()) AND
-- app_module_allowed('social')` — because this table's writers are the SAME shape as that one's: the
-- connect-start route (`linkedin-oauth.ts#startLinkedInConnect` / `youtube-oauth.ts`'s own), the
-- OAuth callback finalize route (the controllers, via the new `consumeSocialOAuthState`), and the
-- retention sweep (`inbox-retention-job.ts`'s per-tenant transaction, already module-scoped before any
-- registered purger runs) — never a portal controller, so this is not `social_post_client_reviews`'s
-- (0105 D-16) exception case.
--
-- ── SINGLE-USE, THE SAME MECHANISM AS 0076 ──────────────────────────────────────────────────────────
-- `consumed_at timestamptz` + an atomic `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()
-- RETURNING` (in `src/modules/social/publisher/oauth-state.ts`) is the whole anti-replay mechanism: it
-- is one statement, so two concurrent callback presentations cannot both win, and an expired-but-
-- unconsumed row is refused by the SAME predicate without needing the purge sweep to have run first.
--
-- ── WHY THIS TABLE'S PURGE DIFFERS FROM 0076's (a deliberate departure, not an oversight) ───────────
-- `google_oauth_states#pruneExpiredAuthorizationStates` deletes ONLY unconsumed-and-expired rows,
-- leaving CONSUMED rows forever — defensible there because `connection_id` gives a consumed row real
-- audit value (which state row produced which live Google connection). This table's consumed rows have
-- no comparable audit value of their own: `social_accounts.connected_at`/`connected_by` and
-- `social_oauth_tokens.granted_by` (202608201519) already carry the durable "who connected what, when"
-- record. So this table's purger (`purgeSocialOAuthStates`, registered under SMM-36's
-- `registerRetentionPurger('oauth_states', ...)` seam, riding the SAME sweep/cadence/module-scope
-- discipline `oauth_tokens` already does) deletes EVERY row — consumed or not — once `expires_at`
-- passes, which is the reading of this migration's own instruction ("do not create an unbounded
-- table"): a 10-minute-TTL row this deployment will never need again, kept forever, is exactly that.
--
-- ── `created_by`: STORED FOR AUDIT, NOT YET ENFORCED (a named, NOT a silently-decided gap) ───────────
-- `core/google-oauth/state.ts`'s own attack A1 (CSRF/login-CSRF) is closed there by requiring the
-- callback's calling principal to equal the row's `created_by`. This migration's table carries the
-- SAME column for the SAME future use, but THIS PASS's application code (oauth-state.ts) does not yet
-- compare it — the two controllers' existing Cerbos `connect` check (any principal with tenant-scoped
-- connect permission, not necessarily the SAME principal who started the flow) is what currently stands
-- in that gap, same as before this migration. Named here rather than assumed closed: closing it fully
-- is a small, separate follow-up (compare `expect.principalUserId` inside `consumeSocialOAuthState`,
-- exactly like `consumeAuthorizationState`'s own `principal_mismatch` check), out of THIS ticket's
-- scope (single-use replay closure only).
--
-- ── NO DML, NO BACKFILL ──────────────────────────────────────────────────────────────────────────────
-- Brand-new table, zero rows anywhere — the 0050 NOBYPASSRLS backfill trap does not apply (nothing here
-- depends on RLS to select a pre-existing row set). Self-asserted below per the 0106/.../0118/
-- 202608201519 discipline: never trust, always assert what actually landed.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────────────────
-- The sequential `NNNN_` scheme is CLOSED above 0118 (0119 grandfathered by name only). This file uses
-- the UTC-timestamp scheme (`date -u +%Y%m%d%H%M` at write time: 202608221751), per
-- `migrations/README.md`'s 2026-08-19 protocol change; verified against the live directory listing at
-- write time (head was 202608221603_social_best_time_suggestions.sql), not inherited from memory.

CREATE TABLE social_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),

  -- The `social_accounts` row this connect ceremony is for. Composite FK (below) pins it to THIS
  -- tenant as well, mirroring `social_oauth_tokens`'s own `fk_social_oauth_tokens_account_tenant`.
  account_id uuid NOT NULL,

  -- Duplicated off social_accounts.network, same convention `social_oauth_tokens` already uses (and
  -- 0105's own `social_inbox_threads`): a per-network filter is a plain column scan, no join needed,
  -- and it is what `consumeSocialOAuthState`'s `network_mismatch` check compares against.
  network text NOT NULL CHECK (network IN ('linkedin','youtube')),

  -- The principal who STARTED the flow. Stored for audit/future-use; NOT YET compared at consume time
  -- — see the header's own named-gap note.
  created_by uuid REFERENCES users(id),

  expires_at timestamptz NOT NULL,
  -- SINGLE USE. `consumeSocialOAuthState`'s atomic `UPDATE ... WHERE consumed_at IS NULL AND
  -- expires_at > now() RETURNING` is the entire anti-replay mechanism — see the header.
  consumed_at timestamptz,

  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_social_oauth_states_account_tenant FOREIGN KEY (account_id, tenant_id)
    REFERENCES social_accounts (id, tenant_id)
);

-- The purge sweep's own index: "everything past its TTL, for this tenant" — the WHERE-less form
-- (unlike 0076's `WHERE consumed_at IS NULL`) because THIS table's purge deletes consumed rows too —
-- see the header's own departure note.
CREATE INDEX ix_social_oauth_states_expiry ON social_oauth_states (tenant_id, expires_at);

ALTER TABLE social_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_oauth_states FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social'));

COMMENT ON TABLE social_oauth_states IS
  'Security follow-up to SMM-38c/38d (LinkedIn/YouTube direct-driver OAuth) — DB-backed single-use '
  'state for the connect-ceremony state parameter, closing the pure state-replay window those files'' '
  'own headers named and left open. THIRD RLS WALL, same predicate as social_oauth_tokens '
  '(202608201519). Single-use via consumed_at + an atomic UPDATE...WHERE consumed_at IS NULL RETURNING '
  '(oauth-state.ts). Purges EVERY row (consumed or not) past expires_at — see this file''s header for '
  'why that differs from google_oauth_states'' own keep-consumed-forever policy. created_by is stored '
  'for audit but NOT YET compared at consume time (named gap, see header).';

-- ── SELF-ASSERTION (0106/.../0118/202608201519 idiom) ─────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables WHERE table_name = 'social_oauth_states';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected social_oauth_states to exist, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint WHERE conname = 'fk_social_oauth_states_account_tenant';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected fk_social_oauth_states_account_tenant to exist, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes WHERE indexname = 'ix_social_oauth_states_expiry';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected ix_social_oauth_states_expiry to exist, found %', n;
  END IF;

  -- FORCE RLS actually landed (a typo'd table/policy name would not error the way a SELECT would).
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE c.relname = 'social_oauth_states' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected social_oauth_states to have ENABLE+FORCE row level security, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'social_oauth_states' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected a tenant_isolation policy on social_oauth_states, found %', n;
  END IF;

  -- No DML above, so a fresh table must have zero rows.
  SELECT count(*) INTO n FROM social_oauth_states;
  IF n <> 0 THEN
    RAISE EXCEPTION 'expected social_oauth_states to be empty immediately after creation, found % rows', n;
  END IF;
END $$;
-- Behavioural coverage (the module-GUC regression, the atomic single-use consume proven against a
-- real replay, the network_mismatch/expired/malformed/bad_signature refusal paths, and the purger
-- seam) lives in `src/modules/social/publisher/oauth-state.test.ts` against the repo's own
-- `initTestDb` harness — same reasoning `social_oauth_tokens`'s own migration gives for not attempting
-- that here with synthetic FK values (an FK violation and a CHECK violation would be indistinguishable,
-- turning a migration-level assertion into a false pass).
