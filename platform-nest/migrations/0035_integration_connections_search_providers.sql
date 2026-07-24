-- SM-01 (part 2) — WIDEN the integration_connections vault for search-marketing client OAuth (P4).
--
-- Implements seo-sem-design.md §04/§09/§14(D-8): the search module's P4 live-account integrations
-- (Google Search Console / Analytics / Ads, plus premium Semrush) ride the EXISTING 0033 vault
-- (AES-256-GCM at rest, `hasToken` reads only). Two ADDITIVE CHECK widenings, nothing else:
--
--   1. provider  += google_search_console, google_analytics, google_ads, semrush
--   2. owner_kind += 'client'   (polymorphic owner_id -> clients.id, NO FK — same convention as the
--                                existing user/company kinds and work_activity_links.target_id, 0030)
--
-- ── SECURITY-RELEVANT NOTE (flagged for the reviewer) ───────────────────────────────────────────────
-- This is a CHECK WIDENING on a credential-vault table. It is purely additive: every value permitted
-- before (github|google_drive|claude ; user|company) remains permitted, so all existing rows stay
-- valid and NO data is lost or rewritten. It does NOT touch RLS (integration_connections keeps its
-- 0033 core-table policy: app_current_tenants() alone, per-company, no module wall), does NOT touch
-- the vault columns, and does NOT relax any grant. It only makes it LEGAL to store a
-- google_search_console/analytics/ads/semrush connection and a client-owned link. Tokens are still
-- writable ONLY via service.setConnectionTokens (P4 OAuth); Phase-1 HTTP create/patch accept none.
--
-- Robust to the auto-generated constraint names (0033 named them integration_connections_*_check) and
-- idempotent: drop the discovered CHECK by lookup, re-add the widened one under the canonical name.
-- Additive, safe on live data — no rollout step beyond `migrate`.

-- 1) provider CHECK — widen to the search P4 providers.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%provider%'
     AND pg_get_constraintdef(oid) ILIKE '%github%';   -- disambiguate from the status/owner_kind CHECKs
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE integration_connections DROP CONSTRAINT %I', cname);
  END IF;
END $$;
ALTER TABLE integration_connections
  ADD CONSTRAINT integration_connections_provider_check
  CHECK (provider IN (
    'github', 'google_drive', 'claude',
    'google_search_console', 'google_analytics', 'google_ads', 'semrush'
  ));

-- 2) owner_kind CHECK — widen to add 'client' (per-client OAuth links; owner_id -> clients.id, no FK).
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%owner_kind%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE integration_connections DROP CONSTRAINT %I', cname);
  END IF;
END $$;
ALTER TABLE integration_connections
  ADD CONSTRAINT integration_connections_owner_kind_check
  CHECK (owner_kind IN ('user', 'company', 'client'));
