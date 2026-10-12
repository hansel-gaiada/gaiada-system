-- webdesk/migrations/0017_consent_records.sql
-- WebDesk M5-G6: a SERVER-SIDE CONSENT LOG, so a site can PROVE what a visitor chose and when
-- (legal/website-visitor-addendum.md R-V3 "no server-side proof of consent", F17, section 3.6; WSK-D67).
-- The browser keeps its banner choice in localStorage; this table is the evidence the site cannot forge
-- after the fact. One row per banner decision, keyed by the CONSENT ID (a random uuid the browser keeps,
-- sent again on every later decision and copied onto each form submission as visitor_consent.consentId).
--
-- WHAT IS DELIBERATELY NOT STORED: no IP address, no raw User-Agent, no cookie, no identifier beyond the
-- random consent id. user_agent_class is a coarse bucket (desktop / mobile / tablet / bot / unknown)
-- computed in the application. A consent id identifies a BROWSER, not a person; it becomes personal data
-- only when a submission links it to one, which is why privacy.find / export / erase can look it up.
--
-- APPEND-ONLY. The app role gets SELECT, INSERT and DELETE, and NO UPDATE: a recorded decision can never be
-- rewritten. DELETE exists for exactly two callers, both running as the app role: the retention purge
-- (the hourly maintenance job, consent/consent-purge.service.ts) and the data-subject erase
-- (privacy.erase by consent id). Postgres cannot grant DELETE to one code path only, so that restriction is
-- by construction in the application, and the migration test proves the UPDATE refusal. A decision
-- changes by appending a new row (action 'update' or 'withdraw'), never by editing one.
--
-- RETENTION: "consent records: data lifetime + 1 year" (addendum section 5): 14 + 12 = 26 months by
-- default, WEBDESK_CONSENT_RETENTION_MONTHS (consent/consent.config.ts). The purge works per consent id
-- (a browser's whole history goes once its LATEST record is older than the cutoff), so a history is never
-- left with a hole in the middle.
--
-- RLS and grants follow 0012 / 0013 / 0016: FORCE ROW LEVEL SECURITY with the single-mode tenant_isolation
-- policy, fail-closed on an unset webdesk.tenant_ctx, no platform_ctx escape. Grants are written out
-- (REVOKE ALL, then GRANT) so a database whose default privileges were never set up still ends right.
-- This file runs as webdesk_migrator through migrate.mjs, so the default privileges the read-only
-- webdesk_backup role (WSK-68) inherits cover the new table; check-rls-integrity.mjs asserts that.
--
-- No DML: clear of the RLS zero-row trap (lint-migration-rls.mjs). Re-runnable (IF NOT EXISTS / DROP IF EXISTS).

CREATE TABLE IF NOT EXISTS consent_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- this ROW; many rows share one consent_id
  consent_id        uuid NOT NULL,                                -- the CONSENT ID the browser keeps
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  site_id           uuid NOT NULL REFERENCES sites(id),           -- resolved from the request Origin (environments.domain)
  analytics         boolean NOT NULL,
  marketing         boolean NOT NULL,
  notice_version    text NOT NULL,                                -- the banner / notice version the visitor saw
  action            text NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),           -- server clock, never client-supplied
  user_agent_class  text NOT NULL DEFAULT 'unknown',
  CONSTRAINT consent_records_action_check
    CHECK (action IN ('grant', 'update', 'withdraw')),
  CONSTRAINT consent_records_notice_version_check
    CHECK (char_length(notice_version) BETWEEN 1 AND 32),
  CONSTRAINT consent_records_ua_class_check
    CHECK (user_agent_class IN ('desktop', 'mobile', 'tablet', 'bot', 'unknown')),
  -- A withdrawal withdraws everything: a 'withdraw' row can never carry a granted category.
  CONSTRAINT consent_records_withdraw_check
    CHECK (action <> 'withdraw' OR (NOT analytics AND NOT marketing))
);

CREATE INDEX IF NOT EXISTS ix_consent_records_subject  ON consent_records (tenant_id, consent_id, recorded_at);
CREATE INDEX IF NOT EXISTS ix_consent_records_recorded ON consent_records (tenant_id, recorded_at);

REVOKE ALL ON consent_records FROM webdesk_app;
GRANT SELECT, INSERT, DELETE ON consent_records TO webdesk_app;

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consent_records;
CREATE POLICY tenant_isolation ON consent_records FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

COMMENT ON TABLE consent_records IS
  'M5-G6: append-only log of cookie-banner decisions, keyed by the browser-held consent id. No IP, no raw user agent. Deleted only by the retention purge and by privacy.erase.';
COMMENT ON COLUMN consent_records.consent_id IS
  'Random uuid the browser keeps; identifies a browser, not a person. Copied to submissions.visitor_consent.consentId.';
COMMENT ON COLUMN consent_records.user_agent_class IS
  'Coarse bucket only (desktop/mobile/tablet/bot/unknown). The raw User-Agent is never stored.';
