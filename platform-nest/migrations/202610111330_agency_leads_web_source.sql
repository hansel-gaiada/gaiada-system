-- M5-L4 — a gaiada.com form submission can become an `agency_leads` row (source 'web').
-- Plan: docs/plans/2026-10-11-webdesk-m5-plan.md (M5-L4).
--
-- THE CHECK TRAP (a DROP+ADD re-declares the WHOLE list): `agency_leads_source_check` was declared ONCE,
-- inline on the column, in 202609050857_agency_discovery_intake.sql, as ('invite','open','staff'). No
-- later migration touches agency_leads (grep over migrations/ for "agency_leads" finds only that file),
-- so those three are every value that has ever been legal. This re-declares all three PLUS 'web'.
--
-- Additive columns, all NULL for every existing row (so nothing here backfills, and the RLS
-- zero-row trap cannot bite: no UPDATE/SELECT-with-GUC runs). RLS and the table's header note are
-- untouched (the header note belongs to the pipeline ticket).
--   submission_ref   WebDesk's submission id (the idempotency key together with tenant_id)
--   origin_form      WebDesk form key the lead came from ('contact' | 'audit' | 'onboard')
--   attribution      allow-listed attribution object as fetched from WebDesk (no raw IP)
--   visitor_consent  the banner choice at submit time; NULL = unknown = NO consent

ALTER TABLE agency_leads DROP CONSTRAINT IF EXISTS agency_leads_source_check;
ALTER TABLE agency_leads
  ADD CONSTRAINT agency_leads_source_check CHECK (source IN ('invite','open','staff','web'));

ALTER TABLE agency_leads
  ADD COLUMN IF NOT EXISTS submission_ref uuid,
  ADD COLUMN IF NOT EXISTS origin_form text,
  ADD COLUMN IF NOT EXISTS attribution jsonb,
  ADD COLUMN IF NOT EXISTS visitor_consent jsonb;

-- Trap (NULL defeats UNIQUE): partial over the non-null set. This is what makes the web-lead insert
-- idempotent per (tenant, submission), including under a race.
CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_tenant_submission
  ON agency_leads (tenant_id, submission_ref) WHERE submission_ref IS NOT NULL;

-- Assert, rather than trust the constraint name: exactly one CHECK on agency_leads mentions `source`
-- and it carries all four values. (A silently-missed DROP would leave the old three-value CHECK.)
DO $$
DECLARE n int; def text;
BEGIN
  SELECT count(*), max(pg_get_constraintdef(oid)) INTO n, def
    FROM pg_constraint
   WHERE conrelid = 'agency_leads'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ '\msource\M';
  IF n <> 1 THEN RAISE EXCEPTION 'agency_leads: expected exactly one source CHECK, found %', n; END IF;
  IF def !~ 'invite' OR def !~ '''open''' OR def !~ 'staff' OR def !~ 'web' THEN
    RAISE EXCEPTION 'agency_leads source CHECK lost a value: %', def;
  END IF;
END $$;
