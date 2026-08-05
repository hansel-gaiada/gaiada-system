-- 0077_mail_core.sql — MAIL-04 (Zone A mail core; design doc
-- docs/superpowers/specs/2026-08-04-zone-a-mail-design.md v3, §5 DDL verbatim), amended by MAIL-22
-- (2026-08-05, senior-db) to restore the estate-wide FORCE-RLS invariant.
--
-- Ledger note: the design/plan docs both said "0076" as of the v3 write-up, but `0076` was taken
-- out-of-band by a concurrent session (`0076_core_google_oauth_states.sql`) before this ticket
-- executed. Re-checked with `ls migrations | sort | tail` immediately before writing this file —
-- `0077` was free and is taken here. This file is amended IN PLACE rather than superseded by a new
-- migration: as of MAIL-22 it had been committed but never applied to any persistent database (only
-- ephemeral per-test-file DBs created by `src/testing/setup.ts`), so amending it keeps the ledger at
-- one coherent migration with no window in which these tables existed without RLS. Amending an
-- APPLIED migration would violate README rule 4 — do not use this file as a precedent for that case.
--
-- RLS: MAIL-22 restores FORCE ROW LEVEL SECURITY on all three tables below, closing the gap
-- `src/db/rls.test.ts`'s estate-wide "every tenant-scoped table has FORCE RLS" invariant flagged
-- (`mail_log`/`mail_messages` carry `tenant_id`; the original cut left them and `mail_suppressions`
-- with no RLS at all). The MAIL-04 reasoning this replaces was correct about the platform's
-- *standard* `tenant_isolation` policy (a NULL `tenant_id` row is invisible under it to everyone,
-- permanently — auth mail would be unreadable) but wrong to conclude from that that these tables
-- must have NO RLS. The fix mirrors 0015_site_subscriptions_rls.sql's GUC-gate pattern: FORCE RLS
-- plus a policy gated on a dedicated session GUC (`app.mail_context`) that only the mail module's
-- own DB wrapper (`withMailContext`, src/db/index.ts) sets, via `set_config(..., true)` (SET LOCAL
-- semantics, scoped to one transaction). NULL-tenant rows (auth mail) are gated on the SAME
-- predicate as every other row here — the policy does not distinguish by tenant_id at all, only by
-- whether the caller's connection opted into mail context — so auth mail stays fully readable and
-- writable by the one code path that is supposed to touch it.
--
-- BE HONEST ABOUT WHAT THIS BUYS (stated plainly, not overclaimed): the GUC gate does not make mail
-- data unreadable to code that sets `app.mail_context` — any code path that calls `withMailContext`
-- (or issues the same `set_config` by hand) gets in, exactly as `withGlobal` got in before this
-- change. What FORCE RLS + the gate restores is DEFENCE IN DEPTH: a future query added against
-- `mail_log`/`mail_suppressions`/`mail_messages` through the ordinary `withGlobal`/`withTenants`
-- helpers — i.e. code that forgot this table needs its own context — now fails closed (zero rows,
-- or a WITH CHECK violation on write) instead of silently reading or writing global mail data.
-- Application-layer authorization (the elevated-only admin log, the A10 parent-entity check on
-- thread reads — see `src/mail/thread-authz.ts`) remains the PRIMARY gate; this is the backstop for
-- when that layer is bypassed or misused, the same invariant every other FORCE-RLS table in this
-- estate exists to provide.
--
-- Zero backfill DML in this file (no UPDATE/DELETE/INSERT...SELECT at all — every table below is
-- freshly created here with zero pre-existing rows), so the 0052+ CI backfill/RLS lint
-- (scripts/lint-migration-rls.mjs) — which now genuinely applies, since FORCE ROW LEVEL SECURITY
-- statements exist below — still finds nothing to flag: that lint only flags UPDATE/DELETE/
-- INSERT...SELECT against a FORCE-RLS table's PRE-EXISTING rows, and a table CREATE TABLE'd in this
-- same file has none. Confirmed by running `npm run lint:migration-rls` after this amendment (see
-- MAIL-22's report).

CREATE TABLE mail_log (
  id uuid PRIMARY KEY,
  stream text NOT NULL CHECK (stream IN ('notify','auth')),
  tenant_id uuid REFERENCES companies(id),        -- provenance; NULL for auth mail
  user_id uuid REFERENCES users(id),              -- recipient user when known
  to_email text NOT NULL,
  template_key text NOT NULL,                     -- 'approval.warning' | 'approval.actionable' | 'auth.magic_link' | …
  subject text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',            -- template input, PII-lean (ids + titles, never bodies twice)
  notification_ids uuid[] NOT NULL DEFAULT '{}',  -- the notifications rows this mail carries (A5 audit trail)
  entity_type text,                               -- the triggering entity (log UI + threading):
  entity_id uuid,                                 --   'automation_approval' | 'agency_approval' | 'pipeline_run' | …
  reply_token text UNIQUE,                        -- VERP inbound correlation; NULL = no-reply mail (128-bit CSPRNG, base64url)
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','delivered','bounced','failed','suppressed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  provider text, provider_message_id text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  provider_accepted_at timestamptz,               -- SMTP 250 time (M8 instrumentation)
  delivered_at timestamptz,                       -- from provider webhook (Brevo sends only — the relay has no event feed; §7.7)
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_log_due_idx    ON mail_log (next_attempt_at) WHERE status IN ('queued','sending');
CREATE INDEX mail_log_user_idx   ON mail_log (user_id, created_at);
CREATE INDEX mail_log_tenant_idx ON mail_log (tenant_id, created_at) WHERE tenant_id IS NOT NULL;
CREATE INDEX mail_log_entity_idx ON mail_log (entity_type, entity_id) WHERE entity_id IS NOT NULL;

CREATE TABLE mail_suppressions (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  stream text NOT NULL DEFAULT '*',
  reason text NOT NULL CHECK (reason IN ('hard_bounce','complaint','manual')),
  provider text, detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, stream)
);

-- Inbound replies to system mail (M13). UNTRUSTED CONTENT: body_html_sanitized has already been
-- through the server-side allowlist sanitizer at intake; the raw MIME is never stored.
CREATE TABLE mail_messages (
  id uuid PRIMARY KEY,
  mail_log_id uuid NOT NULL REFERENCES mail_log(id),  -- the outbound mail this replies to (via reply_token)
  tenant_id uuid REFERENCES companies(id),            -- copied provenance from mail_log
  entity_type text, entity_id uuid,                   -- copied from mail_log (threading denorm)
  provider text NOT NULL,                             -- 'brevo-inbound' | 'imap-poll'
  provider_message_id text NOT NULL,                  -- idempotency key
  from_email text NOT NULL,      -- DISPLAY METADATA ONLY — sender addresses are forgeable; never
                                 -- used for authorization or matching (the reply_token is the match)
  subject text,
  body_text text NOT NULL,
  body_html_sanitized text,
  attachments jsonb NOT NULL DEFAULT '[]',            -- [{fileRef, name, bytes, scanStatus: 'pending'|'clean'|'infected'|'skipped'}]
  size_bytes int NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_message_id)
);
CREATE INDEX mail_messages_entity_idx ON mail_messages (entity_type, entity_id, received_at);
CREATE INDEX mail_messages_log_idx    ON mail_messages (mail_log_id);

-- MAIL-22 — GUC-gated FORCE RLS, mirroring 0015_site_subscriptions_rls.sql's `app.sync_context`
-- pattern exactly, with a mail-specific GUC. One policy per table, unconditional on `tenant_id`
-- (including NULL) — the gate is "did the caller's connection opt into mail context", not "does
-- this row belong to tenant X". `withMailContext` (src/db/index.ts) is the ONLY place that sets
-- `app.mail_context = 'on'`; every other NOBYPASSRLS reader of this database (withGlobal,
-- withTenants, an ad-hoc psql session as the app role) sees zero rows and cannot write any, by
-- construction. Standard Postgres caveat, not specific to this gate: a superuser or any role with
-- BYPASSRLS ignores RLS/FORCE RLS entirely regardless of the GUC — `platform_owner` (migrations)
-- and `platform_app` (runtime) are both deliberately NOBYPASSRLS (db-topology-roles), so this
-- applies to every real connection in the estate; only a literal Postgres superuser session (e.g.
-- the test harness's disposable-DB admin) is exempt, same as for every other FORCE-RLS table here.
ALTER TABLE mail_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_log FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_context ON mail_log FOR ALL
  USING (current_setting('app.mail_context', true) = 'on')
  WITH CHECK (current_setting('app.mail_context', true) = 'on');

ALTER TABLE mail_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_suppressions FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_context ON mail_suppressions FOR ALL
  USING (current_setting('app.mail_context', true) = 'on')
  WITH CHECK (current_setting('app.mail_context', true) = 'on');

ALTER TABLE mail_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_context ON mail_messages FOR ALL
  USING (current_setting('app.mail_context', true) = 'on')
  WITH CHECK (current_setting('app.mail_context', true) = 'on');
