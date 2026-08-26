-- webdesk/migrations/0003_forms.sql
-- WSK-03 — forms layer: form_defs · submissions.
-- Carries the v1.1 consent record (webdesk-design.md §11, WSK-D22c): which notice text + which
-- notice VERSION the submitter accepted, stored alongside the payload — "consent you cannot
-- evidence is consent you do not have".
--
-- Requires 0001_platform_core.sql. Runs as webdesk_migrator (no SET ROLE) — see 0001's header
-- note on the role model.

CREATE TABLE form_defs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  site_id               uuid NOT NULL REFERENCES sites(id),
  key                   text NOT NULL,
  schema                jsonb NOT NULL DEFAULT '{}',
  notify                jsonb NOT NULL DEFAULT '{}',
  retention_days        integer NOT NULL DEFAULT 180 CHECK (retention_days > 0),
  -- The consent-notice VERSION currently in force for this form (WSK-D22c). Each submission
  -- captures its own accepted text+version at submit time (below) — this column is what a new
  -- submission stamps itself with, not a substitute for the per-submission record.
  consent_notice_version text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, key)
);
CREATE INDEX ix_form_defs_tenant ON form_defs (tenant_id);

CREATE TABLE submissions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  site_id                uuid NOT NULL REFERENCES sites(id),
  form_def_id            uuid NOT NULL REFERENCES form_defs(id),
  payload                jsonb NOT NULL,
  status                 text NOT NULL DEFAULT 'received'
                           CHECK (status IN ('received', 'processed', 'flagged', 'purged')),
  -- Consent record (WSK-D22c) — the exact text and version the submitter accepted, snapshotted
  -- at submit time so a later edit to the live notice never rewrites history.
  consent_notice_text    text NOT NULL,
  consent_notice_version text NOT NULL,
  consent_accepted_at    timestamptz NOT NULL DEFAULT now(),
  -- Not in the §04 sketch; added as a forward-looking hook for WSK-38's DSR command (find /
  -- export / delete one data subject's submissions across a tenant, WSK-D22b) so that ticket
  -- does not need its own ALTER TABLE. Nullable, app-populated (e.g. a normalized email/phone),
  -- purely a correlator — carries no authority of its own. Flagged as an addition beyond the
  -- literal sketch; trivial to drop if WSK-38 lands a different correlation strategy.
  data_subject_ref       text,
  -- The retention axis (§11): app computes this at insert time as
  -- created_at + form_defs.retention_days at that moment (a CHECK cannot reach across tables,
  -- so this is an application invariant, not a database one — flagged as underspecified in the
  -- §04 sketch, which lists `expires_at` with no stated derivation).
  expires_at             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX ix_submissions_tenant ON submissions (tenant_id);
CREATE INDEX ix_submissions_form_def ON submissions (form_def_id);
-- The retention purge worker's whole query shape: "not yet purged, past its expiry".
CREATE INDEX ix_submissions_purge_sweep ON submissions (expires_at) WHERE status <> 'purged';
CREATE INDEX ix_submissions_data_subject ON submissions (tenant_id, data_subject_ref)
  WHERE data_subject_ref IS NOT NULL;

ALTER TABLE form_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_defs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON form_defs;
CREATE POLICY tenant_isolation ON form_defs FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON submissions;
CREATE POLICY tenant_isolation ON submissions FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

