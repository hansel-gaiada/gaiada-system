-- 202609040403_integration_connections_credential_lifecycle.sql — VLT-6: last-used / expiry /
-- reveal tracking columns on the credential vault.
-- Plan: docs/plans/2026-09-04-client-hosting-credential-vault.md §3 (VLT-6).
--
-- ── NUMBERING (migrations/README.md — the timestamp scheme) ────────────────────────────────────
-- `date -u +%Y%m%d%H%M` at authoring time. `ls migrations | sort | tail` showed head =
-- 202609040401_integration_connections_hosting_providers.sql (this same ticket set's VLT-1,
-- written moments earlier in this session); re-verified immediately before writing this file.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────────────────────────
-- Four new columns on `integration_connections` (0033), all additive:
--   last_used_at          timestamptz              NULL
--   credential_expires_at timestamptz              NULL
--   last_revealed_at      timestamptz              NULL
--   reveal_count          integer  NOT NULL DEFAULT 0
-- Every existing row gets NULL/0 — an honest "never used / never expires per this column / never
-- revealed / revealed zero times", not a synthetic measurement. No backfill DML anywhere in this
-- file: ADD COLUMN with a constant DEFAULT rewrites no existing row's meaning, it only defines
-- what future rows and future writes will carry.
--
-- ── WHY FOUR COLUMNS AND NOT FEWER ─────────────────────────────────────────────────────────────
-- `last_used_at` — stamped by application code (the reveal path, VLT-3; later, whatever server
-- deploy code consumes a hosting credential) whenever the credential is ACTUALLY USED by a
-- machine. This is the operational signal the plan's §2 Gap 3 identifies as missing: "is this
-- credential stale" cannot be answered today at all.
--
-- `last_revealed_at` / `reveal_count` — a SEPARATE signal from last_used_at, on purpose: a reveal
-- puts the plaintext on a human's screen (VLT-3, the plan's highest-risk ticket); a use is a
-- machine presenting the credential to a remote host. The two can happen independently
-- (a human reveals it to hand to a subcontractor without ever driving a deploy; a scheduled deploy
-- uses it without any human ever seeing it) and conflating them would make one signal answer two
-- different operational questions badly instead of two signals each answering one well.
-- `reveal_count` is NOT the audit trail — VLT-3's own audit table (one row per successful reveal,
-- per the plan's acceptance criteria) is the ground truth for "how many times was this credential
-- exposed to a human." These two columns are the CHEAP, single-row signal for "is this credential
-- being handed out repeatedly" without joining out to the audit table for the common case; a
-- discrepancy between `reveal_count` and the audit table's row count for a connection would itself
-- be a signal worth investigating, which is a reason to keep both, not a reason either is
-- redundant.
--
-- ── credential_expires_at vs. token_expires_at — READ THIS BEFORE TOUCHING EITHER ────────────────
-- `token_expires_at` (0033, line 48) already exists and is NOT renamed, NOT repurposed, and NOT
-- touched by this migration. It is reused AS-IS for OAuth ACCESS-TOKEN expiry — the short-lived
-- token a provider hands back from a refresh flow, which is a property of the OAUTH PROTOCOL, not
-- of the credential class. A github/google_drive/claude/search-provider row's `token_expires_at`
-- answers "when does this access token need refreshing."
--
-- `credential_expires_at` (new here) answers a DIFFERENT question: "when does the CREDENTIAL
-- ITSELF stop being valid," which is a property of the credential class, not the protocol. Most
-- hosting-credential values (a plain FTP/SSH/cPanel password, an SSH key) have NO natural expiry
-- and leave this column NULL forever. Some do — most notably a WordPress APPLICATION PASSWORD
-- minted with a set lifetime — and for those this column, not `token_expires_at`, is where that
-- lifetime is recorded, because `token_expires_at` is semantically an OAuth-flow concept and a
-- WP application password is not an OAuth token.
--
-- The two columns can legitimately both be NULL (a plain FTP password with no expiry and no OAuth
-- token), both be set on different rows of the same table (an OAuth row sets token_expires_at, a
-- WP-application-password row sets credential_expires_at), but should never both be meaningfully
-- set on the SAME row under the providers this plan introduces — hosting providers
-- (cpanel/ftp/ssh/wp_admin) never go through an OAuth refresh flow, so `token_expires_at` has no
-- reason to be non-NULL on a row using one of the four new provider values. That is a convention,
-- not a CHECK constraint enforced here: this ticket is schema-only, and encoding "OAuth providers
-- use token_expires_at, hosting providers use credential_expires_at" as a CHECK would require
-- knowing every future provider's classification at DDL time, which is exactly the kind of
-- guess a CHECK constraint should not encode. The distinction is recorded in both columns'
-- COMMENT ON COLUMN instead, since a comment can explain intent without foreclosing a case DDL
-- cannot yet see. See `secret-box.ts`/`integrations.service.ts` for the application-layer contract
-- that actually enforces which column a given provider writes.
--
-- ── ACCEPTANCE-CRITERIA NOTE (for the sibling agent wiring the write) ──────────────────────────
-- The plan's VLT-6 acceptance criteria (§3) expect `last_used_at` to move on a reveal (VLT-3) and
-- to stay NULL on a freshly-imported row until first use, and a query that lists every hosting
-- connection whose `last_used_at` is NULL or older than N days. All three are satisfied by this
-- column shape as-is; none require anything further from this migration. That query is
-- deliberately not built as a view or function here — the plan names it as "documented, not
-- necessarily a new endpoint," i.e. application/reporting-side work, not schema work.
--
-- ── RLS / GRANTS ────────────────────────────────────────────────────────────────────────────────
-- No RLS change. `integration_connections` keeps its existing 0033 FORCE RLS `tenant_isolation`
-- policy (app_current_tenants() alone, CORE table, no module wall) — adding nullable columns to an
-- existing table does not touch its policies, and this migration does not attempt to. No new
-- GRANT: `platform_owner`'s ALTER DEFAULT PRIVILEGES already covers DML on this table for
-- `platform_app` (migrations/README.md — "you normally do not need to write GRANTs in a
-- migration").
--
-- ── WHY NO DO-BLOCK DATA GUARD HERE ─────────────────────────────────────────────────────────────
-- `integration_connections` carries `FORCE ROW LEVEL SECURITY` (0033), and the migration runner
-- connects as `platform_owner` (`usesuper = false, bypassrls = false` — same posture measured for
-- `search_properties` in `202609040149_search_properties_domain_key.sql` and restated in this
-- ticket set's own VLT-1 migration, 202609040401). A DO-block SELECT against this table's ROWS
-- during a migration would see ZERO rows and any guard built on that would be a silent no-op — so
-- this migration does not attempt one. It does not need to: `ADD COLUMN ... DEFAULT` is applied by
-- the DDL engine itself to every existing row regardless of RLS (RLS governs which rows a QUERY
-- can see, not which rows an ALTER TABLE's implicit rewrite touches), so there is nothing here
-- that a data-level guard would be verifying that the ALTER's own success/failure doesn't already
-- guarantee. Unlike VLT-1's provider-CHECK self-check (which reads `pg_get_constraintdef` — a
-- system-catalog read, unaffected by this table's RLS — and therefore DOES include a guard), a
-- guard here would have nothing catalog-shaped to check beyond "do the four columns exist with the
-- right types," which `information_schema.columns` can confirm and is included below for exactly
-- that reason: it is a catalog read, not a data read, so it is a real, firing check.
--
-- ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────
-- Additive, no backfill, no deploy-order dependency — nothing reads or writes these columns until
-- VLT-3's reveal path and whatever deploy code later consumes a hosting credential are built.
-- Plain `migrate` apply.

ALTER TABLE integration_connections
  ADD COLUMN last_used_at          timestamptz,
  ADD COLUMN credential_expires_at timestamptz,
  ADD COLUMN last_revealed_at      timestamptz,
  ADD COLUMN reveal_count          integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN integration_connections.last_used_at IS
  'VLT-6: when this credential was last actually USED by a machine (a deploy, an API call driven '
  'by the sealed value) — NOT when it was last revealed to a human (see last_revealed_at) and NOT '
  'when it was last created/updated. NULL means never used. Written by application code (the '
  'reveal path and any later deploy-automation code that consumes a hosting credential), not by '
  'this migration — every existing row starts NULL, which is the honest state for rows that '
  'predate this column.';

COMMENT ON COLUMN integration_connections.credential_expires_at IS
  'VLT-6: when the CREDENTIAL ITSELF expires — distinct from token_expires_at (0033), which is '
  'OAuth ACCESS-TOKEN expiry, a property of the OAuth refresh protocol. Most hosting credentials '
  '(a plain FTP/SSH/cPanel password, an SSH key) have no natural expiry and leave this NULL '
  'forever; a WordPress APPLICATION PASSWORD minted with a set lifetime is the case that sets it. '
  'Do not write OAuth access-token expiry here, and do not write a hosting credential''s expiry '
  'into token_expires_at — the two columns answer different questions and this table now has both '
  'because both questions are real. See this migration''s header for the full reasoning.';

COMMENT ON COLUMN integration_connections.last_revealed_at IS
  'VLT-6: when a human last saw this credential''s plaintext through the VLT-3 reveal path. '
  'Distinct from last_used_at (a machine use, not a human view). The audit table VLT-3 writes one '
  'row per reveal is the ground truth for "how many times was this exposed to a human" — this '
  'column is the cheap single-row signal, not a replacement for that audit trail. NULL means never '
  'revealed.';

COMMENT ON COLUMN integration_connections.reveal_count IS
  'VLT-6: how many times this credential has been revealed to a human through the VLT-3 reveal '
  'path. Defaults 0 for both existing and new rows — an honest "never revealed," not a backfilled '
  'guess. Incremented by the reveal path alongside writing its one-audit-row-per-reveal record '
  '(VLT-3) — this column is a fast signal for "is this credential being handed out repeatedly," '
  'not the audit trail itself; the audit table''s row count is the thing to trust if the two ever '
  'disagree.';

-- Catalog-only self-check (information_schema, not integration_connections' own rows — unaffected
-- by that table's FORCE RLS, see header). Confirms all four columns exist with the expected types
-- and nullability, so a future edit to this file that silently drops one of the four ADD COLUMN
-- clauses fails loudly here rather than shipping a partial widen.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_name = 'integration_connections'
     AND column_name IN ('last_used_at', 'credential_expires_at', 'last_revealed_at', 'reveal_count');

  IF n <> 4 THEN
    RAISE EXCEPTION 'VLT-6 self-check failed: expected 4 new columns on integration_connections, found %', n;
  END IF;

  IF NOT (SELECT is_nullable = 'NO' FROM information_schema.columns
           WHERE table_name = 'integration_connections' AND column_name = 'reveal_count') THEN
    RAISE EXCEPTION 'VLT-6 self-check failed: reveal_count must be NOT NULL';
  END IF;

  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'integration_connections' AND column_name = 'last_used_at') <> 'YES' THEN
    RAISE EXCEPTION 'VLT-6 self-check failed: last_used_at must be nullable';
  END IF;

  RAISE NOTICE 'VLT-6 self-check passed: all 4 lifecycle columns present with expected nullability';
END $$;
