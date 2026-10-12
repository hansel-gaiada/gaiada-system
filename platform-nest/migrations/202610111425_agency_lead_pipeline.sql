-- M5-P1-a — the lead pipeline on `agency_leads` (WSK-D69, owner, 2026-10-11).
-- Design (the spec for this file): docs/plans/2026-10-11-m5-lead-pipeline-design.md §4.
-- Builds on 202610111330_agency_leads_web_source.sql (M5-L4), which is this migration's head.
--
-- HEADER NOTE, REWRITTEN. Migrations are immutable (README rule 4), so the rewrite of the note that
-- 202609050857_agency_discovery_intake.sql put above CREATE TABLE agency_leads lives here, and in
-- COMMENT ON TABLE agency_leads at the end of this file (the catalogue is where the next reader looks):
--
--   agency_leads: the agency's lead record and its small sales pipeline (WSK-D69, owner, 2026-10-11).
--   It began as the minimum record of the AD-1 discovery intake. That design said "NOT a CRM ... if
--   the group later wants sales-pipeline management it should own this table rather than this feature
--   growing into it." D69 is that adoption: the M5 lead pipeline owns this table now. It has two state
--   machines, kept apart on purpose. `status` is the intake lifecycle (new, invited, submitted,
--   in_review, nurturing, converted, declined) and keeps its AD-1 meaning. `stage` is the sales
--   position, from `agency_lead_stages`. They meet only at the ends: won <=> converted, lost <=>
--   declined. Every stage change appends one row to `agency_lead_stage_events` and emits
--   `agency.lead.stage_changed` (ids, stages, value; no personal data). It is a pipeline, not a
--   general CRM: no forecasting, no probability weighting, no account hierarchy, no activity feed of
--   its own. The contact fields, attribution and consent snapshot here are personal data. Erasure
--   (M5-G5) scrubs those fields, and never edits the append-only history, which holds none. Plain
--   tenant wall, deliberately not module-walled (AD-1 §3.1).
--
-- WHAT THIS DOES, in order (every step is additive; nothing existing is dropped or re-declared):
--   1. agency_lead_stages: GLOBAL vocabulary (no tenant_id, NO RLS: the finance_currencies precedent,
--      202608241012). Stages are rows, so adding one later is an INSERT and no CHECK is ever rebuilt
--      (the DROP+ADD trap). Created and seeded BEFORE the FK column that points at it.
--   2. agency_leads.stage NOT NULL DEFAULT 'enquiry', deal_value numeric(20,4), deal_currency.
--      A constant DEFAULT fills every existing row as DDL (no UPDATE, no RLS involvement).
--   3. Terminal backfill, PER TENANT with app.current_tenant_ids set first: existing `converted`
--      leads become 'won', existing `declined` leads become 'lost'; everything else keeps 'enquiry'.
--      THE RLS ZERO-ROW TRAP (db-topology-roles / migration-backfill-rls-trap): this runs as
--      platform_owner, which is NOSUPERUSER NOBYPASSRLS, and agency_leads is FORCE RLS, so an
--      un-GUC'd UPDATE matches ZERO rows with no error. CI migrates as a superuser and cannot see
--      that. Step 4 is the net: its CHECKs validate EVERY row regardless of RLS, so a backfill that
--      silently matched nothing fails the apply LOUDLY here instead of shipping a table whose
--      converted leads sit at 'enquiry'.
--   4. Four NEW named CHECKs on agency_leads, ADD only (no existing CHECK is dropped):
--        lead_won_iff_converted   (stage = 'won')  = (status = 'converted')
--        lead_lost_iff_declined   (stage = 'lost') = (status = 'declined')
--        lead_deal_pair           deal_value and deal_currency are set together or not at all
--        lead_deal_nonneg         deal_value >= 0
--      SAFE ON LIVE DATA: every pre-existing row is, after step 3, either (converted, won),
--      (declined, lost) or (anything else, enquiry); deal_* are NULL on all of them. None of the four
--      can fail on a row in that state. Postgres evaluates CHECK constraints BEFORE unique indexes,
--      so a test that expected a ux_lead_client error from a status-only UPDATE now gets a CHECK
--      error unless it also sets stage (the convert-race fixture was updated for exactly that).
--   5. agency_lead_stage_events: append-only history, no free text and no personal data. A BEFORE
--      UPDATE trigger always raises. A BEFORE DELETE trigger raises unless
--      current_setting('app.lead_purge', true) = 'on', which only M5-G5's retention purge sets
--      (SET LOCAL). Its hard delete of a lead then cascades the history away (the FK is ON DELETE
--      CASCADE; RI actions bypass RLS); any other delete is refused. TRUNCATE and a superuser
--      disabling the trigger are NOT covered, the same accepted residual as 0068/0087.
--      RLS: ENABLE + FORCE, the NULLIF-hardened plain tenant_isolation block copied from
--      202609050857. NO app_module_allowed(): same doctrine as agency_leads.
--
-- GRANT NOTE (flag for review; this NARROWS, never widens): agency_lead_stages is global reference
-- data with no RLS, so a runtime-role write would be a cross-tenant write. platform_app gets SELECT
-- only; stages are added by migration, as owner. Guarded on the role existing (dev/test have a
-- single shared role, the migrate.ts RUNTIME_GRANTS_SQL convention).
--
-- ROLLOUT: deploy this migration together with (or before) P1-b. Until P1-b, the SERVICES that set
-- status='converted' (convert) or status='declined' (decline) without also setting stage violate the
-- new CHECKs, and the intake-submit path that re-opens a declined lead cannot run either. Ship P1-a
-- and P1-b in one release. On live, rehearse on a restored copy first: an aborted apply is a failed
-- deploy. No down migration is shipped; to undo: DROP the four constraints, DROP TABLE
-- agency_lead_stage_events, DROP COLUMN stage/deal_value/deal_currency, DROP TABLE agency_lead_stages.

-- ─────────────────────────────────────────────────────────────── 1. vocabulary
CREATE TABLE agency_lead_stages (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z][a-z_]{1,31}$'),
  position   smallint NOT NULL UNIQUE,
  kind       text NOT NULL CHECK (kind IN ('open','won','lost')),
  label      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Exactly one won and one lost stage: a second terminal stage of a kind would make "won" ambiguous.
CREATE UNIQUE INDEX ux_agency_lead_stages_terminal ON agency_lead_stages (kind) WHERE kind <> 'open';
INSERT INTO agency_lead_stages (key, position, kind, label) VALUES
  ('enquiry',   10, 'open', 'Enquiry'),
  ('contacted', 20, 'open', 'Contacted'),
  ('qualified', 30, 'open', 'Qualified'),
  ('proposal',  40, 'open', 'Proposal sent'),
  ('won',       90, 'won',  'Won'),
  ('lost',      99, 'lost', 'Lost');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON agency_lead_stages FROM platform_app;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────── 2. columns
ALTER TABLE agency_leads
  ADD COLUMN stage text NOT NULL DEFAULT 'enquiry' REFERENCES agency_lead_stages(key),
  ADD COLUMN deal_value numeric(20,4),
  ADD COLUMN deal_currency text REFERENCES finance_currencies(code);

-- ─────────────────────────────────────────────────────────────── 3. terminal backfill
-- Per tenant, GUC first (the 0051/0087 pattern). SET LOCAL semantics: scoped to this transaction.
DO $$
DECLARE co record;
BEGIN
  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    UPDATE agency_leads SET stage = 'won'  WHERE tenant_id = co.id AND status = 'converted';
    UPDATE agency_leads SET stage = 'lost' WHERE tenant_id = co.id AND status = 'declined';
  END LOOP;
  PERFORM set_config('app.current_tenant_ids', '', true);
END $$;

-- ─────────────────────────────────────────────────────────────── 4. constraints (ADD only)
ALTER TABLE agency_leads
  ADD CONSTRAINT lead_won_iff_converted CHECK ((stage = 'won')  = (status = 'converted')),
  ADD CONSTRAINT lead_lost_iff_declined CHECK ((stage = 'lost') = (status = 'declined')),
  ADD CONSTRAINT lead_deal_pair         CHECK ((deal_value IS NULL) = (deal_currency IS NULL)),
  ADD CONSTRAINT lead_deal_nonneg       CHECK (deal_value IS NULL OR deal_value >= 0);

CREATE INDEX ix_lead_stage ON agency_leads (tenant_id, stage) WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────── 5. append-only history
-- No free text and no personal data: a lost reason stays on the lead, where G5 can scrub it.
CREATE TABLE agency_lead_stage_events (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  lead_id       uuid NOT NULL,
  from_stage    text NOT NULL REFERENCES agency_lead_stages(key),
  to_stage      text NOT NULL REFERENCES agency_lead_stages(key),
  deal_value    numeric(20,4),
  deal_currency text REFERENCES finance_currencies(code),
  actor_id      uuid REFERENCES users(id),
  via_agent     text CHECK (via_agent IS NULL OR length(via_agent) <= 64),  -- currentVia()?.agent
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  origin_site   text NOT NULL,
  CONSTRAINT fk_stage_event_lead_tenant FOREIGN KEY (lead_id, tenant_id)
    REFERENCES agency_leads (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT stage_event_moves     CHECK (from_stage <> to_stage),
  CONSTRAINT stage_event_deal_pair CHECK ((deal_value IS NULL) = (deal_currency IS NULL))
);
CREATE INDEX ix_stage_event_lead ON agency_lead_stage_events (tenant_id, lead_id, occurred_at DESC);

-- The 0087 idiom, with one purge hatch. UPDATE is never allowed. DELETE is refused unless the
-- transaction opted in with SET LOCAL app.lead_purge = 'on' (M5-G5's retention purge only).
CREATE OR REPLACE FUNCTION agency_lead_stage_events_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.lead_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'agency_lead_stage_events is append-only: % is not permitted (id=%)', TG_OP, OLD.id;
END $$;
CREATE TRIGGER trg_agency_lead_stage_events_no_update
  BEFORE UPDATE ON agency_lead_stage_events
  FOR EACH ROW EXECUTE FUNCTION agency_lead_stage_events_guard();
CREATE TRIGGER trg_agency_lead_stage_events_no_delete
  BEFORE DELETE ON agency_lead_stage_events
  FOR EACH ROW EXECUTE FUNCTION agency_lead_stage_events_guard();

-- RLS: plain tenant wall (copied from 202609050857), NULLIF-hardened per 0025. No app_module_allowed.
ALTER TABLE agency_lead_stage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_lead_stage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agency_lead_stage_events;
CREATE POLICY tenant_isolation ON agency_lead_stage_events FOR ALL
  USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]));

-- ─────────────────────────────────────────────────────────────── comments
COMMENT ON TABLE agency_leads IS
  'agency_leads: the agency''s lead record and its small sales pipeline (WSK-D69, owner, 2026-10-11). '
  'It began as the minimum record of the AD-1 discovery intake. '
  'That design said "NOT a CRM ... if the group later wants sales-pipeline management it should own this table rather than this feature growing into it." '
  'D69 is that adoption: the M5 lead pipeline owns this table now. '
  'It has two state machines, kept apart on purpose. '
  '`status` is the intake lifecycle (new, invited, submitted, in_review, nurturing, converted, declined) and keeps its AD-1 meaning. '
  '`stage` is the sales position, from `agency_lead_stages`. '
  'They meet only at the ends: won <=> converted, lost <=> declined. '
  'Every stage change appends one row to `agency_lead_stage_events` and emits `agency.lead.stage_changed` (ids, stages, value; no personal data). '
  'It is a pipeline, not a general CRM: no forecasting, no probability weighting, no account hierarchy, no activity feed of its own. '
  'The contact fields, attribution and consent snapshot here are personal data. '
  'Erasure (M5-G5) scrubs those fields, and never edits the append-only history, which holds none. '
  'Plain tenant wall, deliberately not module-walled (AD-1 section 3.1).';
COMMENT ON COLUMN agency_leads.status IS
  'Intake lifecycle (AD-1): new, invited, submitted, in_review, nurturing, converted, declined. Meets `stage` only at the ends: converted <=> won, declined <=> lost (CHECKs).';
COMMENT ON COLUMN agency_leads.stage IS
  'Sales position, FK to agency_lead_stages(key). Default enquiry. Written ONLY by transitionStage() (core/agency-lead-pipeline.service.ts): won only via Convert, lost only via Decline.';
COMMENT ON COLUMN agency_leads.deal_value IS
  'Deal value, numeric(20,4) >= 0, exact at the currency''s minor unit (enforced by the service, not the DDL). Set together with deal_currency or not at all.';
COMMENT ON COLUMN agency_leads.deal_currency IS
  'ISO 4217 code, FK to finance_currencies(code). No default currency anywhere (internal now, SaaS later).';
COMMENT ON TABLE agency_lead_stages IS
  'GLOBAL pipeline vocabulary (WSK-D69): reference data, no tenant_id, no RLS, runtime role is read-only. One won and one lost stage (partial unique index). Adding a stage is an INSERT in a migration.';
COMMENT ON TABLE agency_lead_stage_events IS
  'Append-only stage history (WSK-D69), one row per stage change, written by transitionStage() in the same transaction as the change. Holds NO personal data (M5-G5 erasure never edits it). UPDATE always raises; DELETE raises unless the transaction sets app.lead_purge = on (G5 retention purge only).';

-- ─────────────────────────────────────────────────────────────── self-assert
-- Catalogue reads only (pg_constraint/pg_class/pg_trigger have no RLS), and NO probe rows: a probe
-- INSERT into a FORCE-RLS table is green in CI (superuser) and red on live (lint-migration-rls note).
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM agency_lead_stages WHERE kind = 'won';
  IF n <> 1 THEN RAISE EXCEPTION 'agency_lead_stages: expected exactly one won stage, found %', n; END IF;
  SELECT count(*) INTO n FROM agency_lead_stages WHERE kind = 'lost';
  IF n <> 1 THEN RAISE EXCEPTION 'agency_lead_stages: expected exactly one lost stage, found %', n; END IF;
  SELECT count(*) INTO n FROM agency_lead_stages;
  IF n <> 6 THEN RAISE EXCEPTION 'agency_lead_stages: expected 6 seeded stages, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'agency_leads'::regclass AND contype = 'c'
     AND conname IN ('lead_won_iff_converted','lead_lost_iff_declined','lead_deal_pair','lead_deal_nonneg');
  IF n <> 4 THEN RAISE EXCEPTION 'agency_leads: expected the 4 pipeline CHECKs, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_class
   WHERE oid = 'agency_lead_stage_events'::regclass AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN RAISE EXCEPTION 'agency_lead_stage_events: RLS is not ENABLED + FORCED'; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'agency_lead_stage_events'::regclass AND NOT tgisinternal
     AND tgname IN ('trg_agency_lead_stage_events_no_update','trg_agency_lead_stage_events_no_delete');
  IF n <> 2 THEN RAISE EXCEPTION 'agency_lead_stage_events: expected the 2 append-only triggers, found %', n; END IF;
END $$;
