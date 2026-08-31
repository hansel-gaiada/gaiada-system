-- webdesk/migrations/0004_mail.sql
-- WSK-03 — mail layer: mail_templates · mail_log · suppressions.
-- Zone B's own stream only (§03 egress allowlist: the Brevo `forms.gaiada.online` stream key) —
-- this schema does not and must not touch Zone A's `notify.`/`auth.gaiada.com` mail streams.
--
-- Requires 0001_platform_core.sql. Runs as webdesk_migrator (no SET ROLE) — see 0001's header
-- note on the role model.

CREATE TABLE mail_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  site_id    uuid NOT NULL REFERENCES sites(id),
  key        text NOT NULL,
  subject    text NOT NULL,
  body_html  text NOT NULL,
  body_text  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, key)
);
CREATE INDEX ix_mail_templates_tenant ON mail_templates (tenant_id);

CREATE TABLE mail_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  site_id             uuid NOT NULL REFERENCES sites(id),
  template_id         uuid REFERENCES mail_templates(id),
  to_address          text NOT NULL,
  subject             text NOT NULL,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
  provider_message_id text,
  error                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX ix_mail_log_tenant ON mail_log (tenant_id);
CREATE INDEX ix_mail_log_template ON mail_log (template_id);
-- BullMQ worker updates status/sent_at/error/provider_message_id as delivery progresses, so
-- (unlike audit_entries/content_versions) UPDATE stays granted. DELETE is clawed back — a mail
-- log is evidence of what was sent to whom for compliance and abuse investigation, and should
-- not be quietly erasable by the runtime role. (This is a WSK-03 addition beyond the bare §04
-- sketch line, not a stated requirement; flagged in the report.)
REVOKE DELETE ON mail_log FROM webdesk_app;

CREATE TABLE suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  address    text NOT NULL,
  reason     text NOT NULL CHECK (reason IN ('bounce', 'complaint', 'manual', 'unsubscribe')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, address)
);
CREATE INDEX ix_suppressions_tenant ON suppressions (tenant_id);

ALTER TABLE mail_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_templates;
CREATE POLICY tenant_isolation ON mail_templates FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE mail_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_log;
CREATE POLICY tenant_isolation ON mail_log FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppressions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON suppressions;
CREATE POLICY tenant_isolation ON suppressions FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

