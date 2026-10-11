-- M5-G5 — data-subject rights and retention for website leads (agency_leads + AD-1).
-- Ticket: M5-G5 in docs/plans/2026-10-11-webdesk-m5-plan.md. Addendum: legal/website-visitor-addendum.md
-- §5 (retention: unconverted leads 24 months from the last status change, AD-1 on the lead's clock),
-- §9.3 items 3, 7, 8, 9; R-V10, R-V11, R-V12. Code: core/agency-privacy.* and core/agency-lead-retention.ts.
-- Builds on 202610111425_agency_lead_pipeline.sql (its `app.lead_purge` hatch is what the purge sets).
--
-- WHAT THIS ADDS (every step additive; no existing column, CHECK or policy is dropped or re-declared):
--   1. agency_leads.status_changed_at — the retention clock. NOT NULL DEFAULT now(): the constant
--      default fills existing rows as DDL (the migration's own timestamp, no UPDATE, no RLS involvement).
--      A per-tenant backfill then moves it back to GREATEST(created_at, updated_at, triaged_at). If that
--      backfill silently matched zero rows (the RLS zero-row trap), every existing lead keeps the
--      migration's timestamp, which only DELAYS its purge: the failure direction is "kept longer", never
--      "deleted early". A BEFORE UPDATE trigger, created AFTER the backfill, stamps now() whenever
--      `status` or `stage` changes, so the clock is maintained by the database, not by every writer.
--   2. agency_leads.erased_at + CHECK lead_erased_holds_no_contact: an erased row structurally cannot
--      hold a contact field or attribution. agency_discovery_submissions.erased_at (bookkeeping only).
--   3. agency_dsr_requests — the append-only DSR ledger (WebDesk WSK-38's `dsr_requests`, mirrored):
--      the identifier as SHA-256 ONLY (core/agency-privacy.subject.ts `subjectHash`, deliberately the
--      same hash WebDesk computes, so the two ledgers correlate). Two phases per request: `filed` (the
--      WS4 approval was requested) and `executed` (the approval was consumed). The partial UNIQUE on
--      (approval_id) WHERE phase='executed' IS the single-use claim of the approval. UPDATE and DELETE
--      always raise (the 0087 idiom) and are revoked from platform_app.
--   4. agency_contact_suppressions — hashed contacts that the web intake must not re-create and that
--      P2 must never upload. scope 'all' (written by an erase: no re-intake, no upload) or 'ad_upload'
--      (schema-admitted for a marketing-only withdrawal, design flag (b) of the pipeline design: blocks
--      uploads only; no writer exists yet).
--   5. agency_lead_retention_runs — evidence that the purge ran and what it removed (counts only, no ids,
--      no personal data). One row per tenant per run that deleted something.
--   RLS: ENABLE + FORCE + the NULLIF-hardened plain tenant_isolation block of 202609050857, on every new
--   table. NO app_module_allowed(): the agency tables' doctrine (AD-1 §3.1), and the purge runs as a
--   generic sweep with no module scope.
--
-- NOT DONE HERE, deliberately: no ledger retention (the DSR log follows the legal pack's DSR-log period,
-- a separate decision); no FK from agency_dsr_requests.approval_id to automation_approvals (the binding is
-- the `filed` row this platform's own route writes, never a lookup by tool_args, which any member can
-- forge through POST /automation-approvals — search.controller.ts SM-21 wall 2).
--
-- ROLLOUT: no service depends on the new columns being populated; the trigger maintains the clock from
-- the moment this applies. To undo: DROP the trigger + function, the CHECK, the three tables, and the
-- columns agency_leads.status_changed_at/erased_at and agency_discovery_submissions.erased_at.

-- ─────────────────────────────────────────────────────────────── 1. the retention clock
ALTER TABLE agency_leads
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN erased_at timestamptz;

ALTER TABLE agency_discovery_submissions
  ADD COLUMN erased_at timestamptz;

-- Per tenant, GUC first (the 0051 / 202610111425 pattern; lint:migration-rls checks it). SET LOCAL semantics.
DO $$
DECLARE co record;
BEGIN
  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    UPDATE agency_leads
       SET status_changed_at = GREATEST(created_at, updated_at, triaged_at)
     WHERE tenant_id = co.id;
  END LOOP;
  PERFORM set_config('app.current_tenant_ids', '', true);
END $$;

CREATE OR REPLACE FUNCTION agency_leads_status_clock() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_agency_leads_status_clock
  BEFORE UPDATE OF status, stage ON agency_leads
  FOR EACH ROW EXECUTE FUNCTION agency_leads_status_clock();

-- The purge's scan: unconverted leads by clock, per tenant.
CREATE INDEX ix_lead_retention ON agency_leads (tenant_id, status_changed_at) WHERE status <> 'converted';

-- ─────────────────────────────────────────────────────────────── 2. erased rows hold no contact
-- Validates every existing row regardless of RLS; all have erased_at NULL, so it cannot fail on apply.
ALTER TABLE agency_leads
  ADD CONSTRAINT lead_erased_holds_no_contact CHECK (
    erased_at IS NULL
    OR (contact_name IS NULL AND contact_email IS NULL AND contact_phone IS NULL AND attribution IS NULL)
  );

-- ─────────────────────────────────────────────────────────────── 3. the DSR ledger
CREATE TABLE agency_dsr_requests (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES companies(id),
  -- Groups the `filed` row and the `executed` row of one request.
  request_id         uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('find','export','erase')),
  phase              text NOT NULL CHECK (phase IN ('filed','executed')),
  -- subjectHash() of the normalised email / phone. NEVER the plaintext: this ledger must survive the
  -- erasure it records without becoming a second copy of what was erased.
  email_hash         text CHECK (email_hash IS NULL OR email_hash ~ '^[0-9a-f]{64}$'),
  phone_hash         text CHECK (phone_hash IS NULL OR phone_hash ~ '^[0-9a-f]{64}$'),
  -- The automation_approvals row (WS4) this request is bound to.
  approval_id        uuid NOT NULL,
  actor_id           uuid REFERENCES users(id),
  -- Counts at execution (0 on the filed row). Ids are not kept: a count proves the scope without
  -- pointing back at the person.
  lead_count         integer NOT NULL DEFAULT 0 CHECK (lead_count >= 0),
  submission_count   integer NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
  token_count        integer NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  out_of_scope_count integer NOT NULL DEFAULT 0 CHECK (out_of_scope_count >= 0),
  suppression_count  integer NOT NULL DEFAULT 0 CHECK (suppression_count >= 0),
  origin_site        text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dsr_has_subject CHECK (email_hash IS NOT NULL OR phone_hash IS NOT NULL)
);
-- One filed row per approval, and ONE EXECUTION per approval: inserting the executed row is the claim.
CREATE UNIQUE INDEX ux_agency_dsr_filed    ON agency_dsr_requests (approval_id) WHERE phase = 'filed';
CREATE UNIQUE INDEX ux_agency_dsr_executed ON agency_dsr_requests (approval_id) WHERE phase = 'executed';
CREATE INDEX ix_agency_dsr_email ON agency_dsr_requests (tenant_id, email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX ix_agency_dsr_phone ON agency_dsr_requests (tenant_id, phone_hash) WHERE phone_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION agency_dsr_requests_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agency_dsr_requests is append-only: % is not permitted (id=%)', TG_OP, OLD.id;
END $$;
CREATE TRIGGER trg_agency_dsr_requests_no_update
  BEFORE UPDATE ON agency_dsr_requests
  FOR EACH ROW EXECUTE FUNCTION agency_dsr_requests_append_only();
CREATE TRIGGER trg_agency_dsr_requests_no_delete
  BEFORE DELETE ON agency_dsr_requests
  FOR EACH ROW EXECUTE FUNCTION agency_dsr_requests_append_only();

-- ─────────────────────────────────────────────────────────────── 4. the suppression list
CREATE TABLE agency_contact_suppressions (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  contact_kind   text NOT NULL CHECK (contact_kind IN ('email','phone')),
  contact_hash   text NOT NULL CHECK (contact_hash ~ '^[0-9a-f]{64}$'),
  -- 'all': never re-create a lead from this contact and never upload it. 'ad_upload': uploads only.
  scope          text NOT NULL CHECK (scope IN ('all','ad_upload')),
  reason         text NOT NULL CHECK (reason IN ('erasure','marketing_withdrawal')),
  -- The ledger request that produced it (an erase), when there was one.
  dsr_request_id uuid,
  created_by     uuid REFERENCES users(id),
  origin_site    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppression_erasure_is_total CHECK (reason <> 'erasure' OR scope = 'all')
);
CREATE UNIQUE INDEX ux_agency_contact_suppression
  ON agency_contact_suppressions (tenant_id, contact_kind, contact_hash, scope);

-- ─────────────────────────────────────────────────────────────── 5. purge evidence
CREATE TABLE agency_lead_retention_runs (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES companies(id),
  ran_at               timestamptz NOT NULL DEFAULT now(),
  retention_months     integer NOT NULL CHECK (retention_months > 0),
  cutoff               timestamptz NOT NULL,
  leads_deleted        integer NOT NULL DEFAULT 0 CHECK (leads_deleted >= 0),
  submissions_deleted  integer NOT NULL DEFAULT 0 CHECK (submissions_deleted >= 0),
  tokens_deleted       integer NOT NULL DEFAULT 0 CHECK (tokens_deleted >= 0),
  stage_events_deleted integer NOT NULL DEFAULT 0 CHECK (stage_events_deleted >= 0),
  origin_site          text NOT NULL
);
CREATE INDEX ix_agency_lead_retention_runs ON agency_lead_retention_runs (tenant_id, ran_at DESC);

-- ─────────────────────────────────────────────────────────────── grants
-- The ledger is append-only for the runtime role too (the trigger is the enforcement; this is the
-- belt). Guarded on the role existing: dev/test have a single shared role (migrate.ts RUNTIME_GRANTS_SQL).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON agency_dsr_requests FROM platform_app;
    REVOKE UPDATE, TRUNCATE ON agency_lead_retention_runs FROM platform_app;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────── RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agency_dsr_requests','agency_contact_suppressions','agency_lead_retention_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL
        USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
        WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
    $f$, t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────── comments
COMMENT ON COLUMN agency_leads.status_changed_at IS
  'Retention clock (M5-G5, addendum section 5): when status or stage last changed. Maintained by trg_agency_leads_status_clock. An unconverted lead is purged N months (default 24, AGENCY_LEAD_RETENTION_MONTHS) after it.';
COMMENT ON COLUMN agency_leads.erased_at IS
  'Set by the M5-G5 privacy erase. The row survives (status, stage, client link, value) but holds no contact field or attribution (CHECK lead_erased_holds_no_contact); org_name reads (erased).';
COMMENT ON COLUMN agency_discovery_submissions.erased_at IS
  'Set by the M5-G5 privacy erase when the person fields of `answers` were replaced by [erased].';
COMMENT ON TABLE agency_dsr_requests IS
  'Append-only DSR ledger for agency-intake data (M5-G5; WebDesk WSK-38 dsr_requests mirrored). Identifiers as SHA-256 only, the same hash WebDesk computes. phase filed = WS4 approval requested; phase executed = approval consumed (unique per approval).';
COMMENT ON TABLE agency_contact_suppressions IS
  'Hashed contacts (M5-G5): scope all = the web intake never re-creates a lead and nothing is uploaded to an ad platform; scope ad_upload = uploads only. Checked by isContactSuppressed().';
COMMENT ON TABLE agency_lead_retention_runs IS
  'Evidence of the M5-G5 retention purge: counts per tenant per run that deleted something. No ids, no personal data.';

-- ─────────────────────────────────────────────────────────────── self-assert (catalogue reads only)
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class
   WHERE relname IN ('agency_dsr_requests','agency_contact_suppressions','agency_lead_retention_runs')
     AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 3 THEN RAISE EXCEPTION 'M5-G5: expected 3 new tables with RLS ENABLED + FORCED, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'agency_dsr_requests'::regclass AND NOT tgisinternal
     AND tgname IN ('trg_agency_dsr_requests_no_update','trg_agency_dsr_requests_no_delete');
  IF n <> 2 THEN RAISE EXCEPTION 'agency_dsr_requests: expected the 2 append-only triggers, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'agency_leads'::regclass AND NOT tgisinternal AND tgname = 'trg_agency_leads_status_clock';
  IF n <> 1 THEN RAISE EXCEPTION 'agency_leads: the status clock trigger is missing'; END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'agency_leads'::regclass AND contype = 'c' AND conname = 'lead_erased_holds_no_contact';
  IF n <> 1 THEN RAISE EXCEPTION 'agency_leads: CHECK lead_erased_holds_no_contact is missing'; END IF;

  -- The pipeline's escape hatch this purge relies on must still be the one it was (202610111425).
  SELECT count(*) INTO n FROM pg_proc
   WHERE proname = 'agency_lead_stage_events_guard' AND prosrc LIKE '%app.lead_purge%';
  IF n <> 1 THEN RAISE EXCEPTION 'agency_lead_stage_events_guard no longer carries the app.lead_purge hatch'; END IF;
END $$;
