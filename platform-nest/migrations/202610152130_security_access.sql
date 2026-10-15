-- DW-7h (docs/FRONTEND-BFF-CONTRACT.md §52; PERMISSION-CONTRACT §42; ruling DW-D36): THE ERP-SIDE SECURITY VIEW. The office
-- network cannot be read (no UniFi API: the controller is shared with a private house), so IT sees and controls what reaches
-- the ERP itself: who is connected, from where and on what, and it can sign a session out or block an address.
--
--   security_access_seen          — per company: one row per (user, Keycloak session, address), with the browser, first and
--                                   last seen and a request count. Written by the request hook (throttled to one write per key
--                                   per minute). The "Connected" page and the new-device alert read it.
--   security_session_revocations  — GLOBAL: a signed-out session (session_id set), or every session of a user issued before
--                                   revoked_at (session_id NULL: "Block login"). The request hook refuses a matching token.
--   security_ip_blocks            — per company: an address IT blocked from this company's data, with an expiry, the hits it
--                                   stopped, and who lifted it.
--
-- ── NOTES ─────────────────────────────────────────────────────────────────────────────────────
--   * `security_access_seen` and `security_ip_blocks` carry the standard tenant_isolation policy (tenant_id in the request's
--     tenant set), FORCE RLS, and NO module wall: like IT accounts, security is not behind the `it` module. A read through
--     `withGlobal` sees ZERO rows on these two (migration-backfill-rls-trap); read them in the tenant's context.
--   * `security_session_revocations` is GLOBAL like `users`: a session belongs to the person, not to one company, so it has
--     no RLS. `revoked_from_company_id` records which company's IT signed it out, for that company's Blocks page. It is
--     deliberately NOT named tenant_id: every table with a tenant_id must FORCE RLS (db/rls.test.ts), and a forced policy
--     would hide rows from the request hook, which reads this table with no tenant context. `expires_at` is past the
--     ERP session's 12 h absolute life, so an old row stops costing the hot path anything.
--   * `security_access_seen.ip` is NULL when the address cannot be told (never a guess), so the key is UNIQUE NULLS NOT
--     DISTINCT (Postgres 15+; the stack runs 16), or a NULL address would add a row per request. `session_id` is '' when a
--     token carries no `sid` (the dev service-token path).
--   * One ACTIVE block per (company, address): the partial unique index keys on `lifted_at IS NULL`. An expired block that
--     was never lifted still holds the slot, so the create route first marks expired rows lifted (lifted_at = expires_at,
--     lifted_by NULL), and only then inserts.
--   * Retention: nothing deletes rows yet. A sweep of security_access_seen beyond 90 days is a later ticket.
--
-- Pure DDL, idempotent (CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY). No data is written.

CREATE TABLE IF NOT EXISTS security_access_seen (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  session_id text NOT NULL DEFAULT '' CHECK (char_length(session_id) <= 200),
  ip inet,
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  request_count bigint NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  CONSTRAINT ux_security_access_seen_key UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, session_id, ip)
);
CREATE INDEX IF NOT EXISTS ix_security_access_seen_recent ON security_access_seen (tenant_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS ix_security_access_seen_user ON security_access_seen (tenant_id, user_id, first_seen_at);

ALTER TABLE security_access_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_access_seen FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security_access_seen;
CREATE POLICY tenant_isolation ON security_access_seen FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

CREATE TABLE IF NOT EXISTS security_session_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  session_id text CHECK (session_id IS NULL OR char_length(session_id) BETWEEN 1 AND 200),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES users(id),
  revoked_from_company_id uuid REFERENCES companies(id),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > revoked_at)
);
CREATE INDEX IF NOT EXISTS ix_security_session_revocations_sid ON security_session_revocations (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_security_session_revocations_user ON security_session_revocations (user_id, revoked_at DESC);
CREATE INDEX IF NOT EXISTS ix_security_session_revocations_company ON security_session_revocations (revoked_from_company_id, revoked_at DESC);

CREATE TABLE IF NOT EXISTS security_ip_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  ip inet NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  lifted_at timestamptz,
  lifted_by uuid REFERENCES users(id),
  hit_count bigint NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  last_hit_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (lifted_at IS NULL OR lifted_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_security_ip_blocks_active ON security_ip_blocks (tenant_id, ip) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_security_ip_blocks_recent ON security_ip_blocks (tenant_id, created_at DESC);

ALTER TABLE security_ip_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_ip_blocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security_ip_blocks;
CREATE POLICY tenant_isolation ON security_ip_blocks FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

COMMENT ON TABLE security_access_seen IS
  'DW-7h — who reached this company''s data, per (user, Keycloak session, address), with the browser and first/last seen '
  '(FRONTEND-BFF-CONTRACT §52.3). Written by the request hook, throttled. ip NULL = could not be told.';
COMMENT ON TABLE security_session_revocations IS
  'DW-7h — GLOBAL. A signed-out Keycloak session (session_id), or every session of a user issued before revoked_at '
  '(session_id NULL, "Block login"). The request hook refuses a matching token (§52.4). Rows past expires_at are ignored.';
COMMENT ON TABLE security_ip_blocks IS
  'DW-7h — an address blocked from this company''s data until expires_at or lifted (§52.5). One active block per address.';
