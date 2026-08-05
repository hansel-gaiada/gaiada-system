-- 0077_mail_core.sql — MAIL-04 (Zone A mail core; design doc
-- docs/superpowers/specs/2026-08-04-zone-a-mail-design.md v3, §5 DDL verbatim).
--
-- Ledger note: the design/plan docs both said "0076" as of the v3 write-up, but `0076` was taken
-- out-of-band by a concurrent session (`0076_core_google_oauth_states.sql`) before this ticket
-- executed. Re-checked with `ls migrations | sort | tail` immediately before writing this file —
-- `0077` was free and is taken here.
--
-- GLOBAL tables (no RLS at all — no ALTER ... ENABLE/FORCE ROW LEVEL SECURITY anywhere in this
-- file). Forced by design §6.1/F2: auth mail has no tenant (tenant_id NULL before any tenant
-- context exists), and under the platform's standard tenant_isolation policy a NULL tenant_id is
-- invisible to every tenant-scoped reader AND to platform_owner (deliberately NOBYPASSRLS) AND to
-- withGlobal (FORCE RLS + unset GUC ⇒ policy false) — a NULL-tenant row in a FORCE-RLS table is
-- readable by nobody, permanently. Same class as `users`/`identity_links` (the existing sanctioned
-- withGlobal surface, src/db/index.ts). `platform_owner` creates these tables; default privileges
-- (infra/db/init-cluster.sh's ALTER DEFAULT PRIVILEGES) auto-grant DML to `platform_app` — no
-- explicit GRANT needed here.
--
-- Zero backfill DML in this file (no UPDATE/DELETE/INSERT...SELECT at all — every table below is
-- freshly created here with zero pre-existing rows), and even if there were, none of these tables
-- are FORCE-RLS, so the 0052+ CI backfill/RLS lint (scripts/lint-migration-rls.mjs) has nothing to
-- bite on by construction: that lint only flags DML against a table that carries FORCE ROW LEVEL
-- SECURITY, and no ALTER TABLE ... FORCE ROW LEVEL SECURITY statement exists anywhere below.

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
