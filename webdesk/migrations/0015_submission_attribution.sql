-- webdesk/migrations/0015_submission_attribution.sql
-- WebDesk M5 (M5-L1 / M5-L2): three additive, nullable columns on `submissions`.
--
--   attribution            jsonb  — where the visitor came from (landing page, form page, external referrer host,
--                                   utm_* and ad-click ids, sections seen). Allow-listed and size-capped by the
--                                   application (forms/attribution.ts); best-effort, never required.
--   visitor_consent        jsonb  — a snapshot of the visitor's cookie-banner choice AT SUBMIT TIME
--                                   ({analytics, marketing, version, decided_at}). NULL means "unknown", which
--                                   every reader must treat as NO consent. Distinct from the per-submission
--                                   FORM consent already stored in consent_notice_* (0003): that records the
--                                   notice the submitter accepted to send the form, this records the marketing
--                                   and analytics consent the site gathered before the form.
--   data_subject_phone_ref text   — the second data-subject correlator: the submitter's phone number reduced to
--                                   digits (forms/subject-refs.ts). `data_subject_ref` (0003) stays the email
--                                   correlator. privacy.find / export / erase match on either.
--
-- All three hold personal data (a phone number; a visitor's browsing context), so they are cleared by the same two
-- paths that clear `data_subject_ref` and `payload`: the on-demand privacy.erase command and the retention purge
-- (both in the application, not here).
--
-- The phone index mirrors ix_submissions_data_subject (0003): same leading column (tenant_id), partial on NOT NULL,
-- so the table does not pay for rows that carry no phone. No other index is added: attribution and
-- visitor_consent are only ever read by primary key.
--
-- RLS and grants: nothing to do. The columns live on an existing table, so its FORCE ROW LEVEL SECURITY
-- tenant_isolation policy (0003) already covers them, and the default privileges for webdesk_app and the read-only
-- webdesk_backup role (0001 / postgres/init-roles.sh) already cover a new column of an existing table. This file
-- runs as webdesk_migrator through migrate.mjs like every other, so a table-level GRANT SELECT to webdesk_backup
-- is inherited unchanged (check-rls-integrity.mjs verifies that).
--
-- No DML, so this file is clear of the RLS zero-row trap (lint-migration-rls.mjs). Re-runnable: IF NOT EXISTS
-- throughout.

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS attribution            jsonb;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS visitor_consent        jsonb;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS data_subject_phone_ref text;

CREATE INDEX IF NOT EXISTS ix_submissions_data_subject_phone ON submissions (tenant_id, data_subject_phone_ref)
  WHERE data_subject_phone_ref IS NOT NULL;

COMMENT ON COLUMN submissions.attribution IS
  'M5-L2: allow-listed, <= 4 KB attribution object (landing, form_page, referrer host, utm_*, click ids, sections_seen). NULL = none supplied. Cleared by privacy.erase and the retention purge.';
COMMENT ON COLUMN submissions.visitor_consent IS
  'M5-L2: the visitor''s cookie-banner choice at submit time {analytics, marketing, version, decided_at}. NULL = unknown = NO consent. Cleared by privacy.erase and the retention purge.';
COMMENT ON COLUMN submissions.data_subject_phone_ref IS
  'M5-L1: the submitter''s phone as digits with country code (forms/subject-refs.ts), a DSR correlator beside data_subject_ref (the email one). Cleared by privacy.erase and the retention purge.';
