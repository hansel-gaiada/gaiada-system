-- 202610301300_social_reports_periodic.sql — SCP-5 W5-A1: periodic reports, "Generate with AI" runs and report automation.
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §63.24.2 ("<prefix>_social_reports_periodic.sql"), with §63.24.1 (the kinds and their
-- period formats), §63.24.5 (social_report_runs), §63.24.9 (social_report_schedules) and §63.30.3 (rules_ref). Plan
-- docs/plans/2026-10-15-social-content-pipeline.md §2 (SCP-Q25, Q26, Q37 to Q41) and §7 wave 5, row W5-A1. Data only: the routes,
-- the run worker and the schedule job are W5-A2, A3 and A5.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────────────────────────────
-- (1) social_reports (0105; the third wall unchanged):
--       kind            0105's inline CHECK (Postgres named it social_reports_kind_check, admitting monthly, campaign, adhoc) is
--                       found by its definition and replaced, in ONE statement, by social_reports_kind_ck admitting the eight
--                       kinds: daily, weekly, monthly, quarterly, semester, yearly, campaign, adhoc. The old CHECK is dropped
--                       only when it is a plain list on `kind` whose every value is among the eight, so no value it admitted
--                       is lost; anything else stops the migration. Exactly one CHECK on `kind` alone remains (asserted).
--       period          social_reports_period_ck: one format per NEW kind (daily YYYY-MM-DD, weekly ISO YYYY-Www with weeks
--                       01 to 53, quarterly YYYY-Qn, semester YYYY-Hn, yearly YYYY). Each branch is coalesce(…, false), so a
--                       NULL period FAILS for those five kinds. monthly, campaign and adhoc are not checked (ELSE true):
--                       SMM-23 stored any period, and live rows must not break. Whether the date or the week exists (Feb 30,
--                       a week 53) is the route's check: a CHECK cannot know which years have a week 53.
--       next_period     text NULL: a short kind's "next day / next week" line. social_reports_next_period_ck admits it only on
--                       daily and weekly, at most 1,000 characters. `kind` is NOT NULL, so the CHECK is never NULL itself.
--       ux_social_reports_periodic   UNIQUE (tenant_id, engagement_id, kind, period) WHERE kind IN (the five new kinds) AND
--                       deleted_at IS NULL: one live report per client, kind and period. A partial index, so it covers no
--                       monthly, campaign or adhoc row: older live monthly rows may repeat a period, and the monthly keeps
--                       SCP-5a's advisory lock instead. NULL cannot defeat it: inside its predicate `period` is never NULL
--                       (the period CHECK refuses that) and tenant_id and engagement_id are NOT NULL. No row of a new kind
--                       exists before this file, so the build cannot fail on a duplicate.
-- (2) social_engagements.report_kinds   text[] NOT NULL DEFAULT '{}', CHECK (report_kinds <@ the five new kinds): the periodic
--                       kinds the client is due besides the monthly (SCP-Q26, per kind since SCP-Q37). A NULL element is
--                       refused (<@ never matches NULL); duplicates are the route's to normalise.
-- (3) social_report_schedules (new; THIRD wall): report automation (63.24.9), created before the runs that point at it.
--       owner_id, kind (the six periodic kinds), scope ('all' | 'chosen') with engagement_ids (1 to 200 for 'chosen', none
--       for 'all', no NULL element), timing (a JSON object, the route validates its shape), enabled with paused_reason /
--       paused_at / paused_by, next_run_at + next_period, last_run_at + last_period, created_at, updated_by, updated_at,
--       deleted_at + deleted_by, origin_site. Periods are in the kind's format (monthly YYYY-MM here: no legacy rows).
--       ux_social_report_schedules_all UNIQUE (tenant_id, kind) WHERE scope = 'all' AND deleted_at IS NULL: at most one
--       company-wide schedule per kind. ix_social_report_schedules_due (next_run_at) WHERE enabled AND deleted_at IS NULL.
-- (4) social_report_runs (new; THIRD wall): the bulk "Generate with AI" runs (63.24.5) and the schedules' runs.
--       kind (the six periodic kinds) + period NOT NULL in its format, requested_by, via (NULL or a JSON object; required on a
--       scheduled run), rules_ref ('company:<n>' | 'default:<token>', the format fixed by §63.30), trigger ('person' |
--       'schedule' | 'run_now') with schedule_id (set exactly when the trigger is not 'person'; composite FK to the
--       schedule, so a run never points into another company), status ('queued' | 'running' | 'done' | 'failed'),
--       total / done_count, results (a JSON array), and the resume fields heartbeat_at, started_at, finished_at.
--       ux_social_report_runs_active   UNIQUE (tenant_id, kind, period) WHERE status IN ('queued','running')
--       ux_social_report_runs_running  UNIQUE (tenant_id) WHERE status = 'running': one running run per company (63.24.5;
--                                      the job starts the next when the current one ends; a stale run is RESUMED in place)
--       ux_social_report_runs_schedule UNIQUE (schedule_id, period) WHERE schedule_id IS NOT NULL: one run per schedule
--                                      and period (the job and "Run now" alike; trigger 'person' has no schedule_id)
--       ix_social_report_runs_recent (tenant_id, created_at DESC) and ix_social_report_runs_schedule_recent (schedule_id,
--       created_at DESC) WHERE schedule_id IS NOT NULL: the 30-day list and a schedule's newest run.
--
-- ── THE NULL CASES ────────────────────────────────────────────────────────────────────────────────────────────────────────
-- A CHECK passes on NULL, so every pairing is an equality of two booleans that are never NULL (an `IS NULL` test or a NOT NULL
-- column), and every format test is wrapped in coalesce(…, false). The contract's `paused_by IS NULL OR paused_reason =
-- 'manual'` would pass with paused_reason NULL, so it is written `(paused_by IS NOT NULL) = (paused_reason IS NOT DISTINCT FROM
-- 'manual')`: a manual pause names who paused, and a job's pause (and no pause) names nobody (63.24.9's "who (NULL when the job
-- paused it)").
--
-- ── NO DML, AND THE BACKFILL RULE ─────────────────────────────────────────────────────────────────────────────────────────
-- No row is read or written. Both new columns take a constant default (NULL, '{}'), which Postgres records in the catalogue
-- without rewriting a row. The CHECKs and the unique index are validated by Postgres itself over every row as the table owner
-- (constraint validation is not filtered by row security); every live row is monthly, campaign or adhoc with next_period NULL,
-- so each holds. The RLS zero-row trap (an unset tenant GUC reads ZERO rows of a FORCE-RLS table) cannot bite: nothing here
-- counts rows. The closing DO block asserts the catalogue, never a row count.
--
-- ── RE-RUNNABLE ───────────────────────────────────────────────────────────────────────────────────────────────────────────
-- CREATE TABLE / INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT / POLICY IF EXISTS + ADD / CREATE, and the kind
-- CHECK's swap skips itself once only social_reports_kind_ck is left. Applies on its own with plain `psql -f` (CI's
-- sync-engine-go job applies every migration that way, with no ledger) and again without error. No table here is in the
-- sync-engine's write-back registry.
--
-- ── GRANTS ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- No in-migration GRANT: runtime DML grants come from the owner's ALTER DEFAULT PRIVILEGES and migrate.ts's RUNTIME_GRANTS_SQL
-- pass, as for every social table.
--
-- ── ROLLOUT ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Additive for every reader: a wider kind list, two nullable or defaulted columns, two new empty tables. Runs on boot; the
-- ALTERs take a brief ACCESS EXCLUSIVE lock on social_reports and social_engagements (small tables) to validate their CHECKs
-- and build one partial index covering zero rows. No deploy-order constraint: the running code writes only monthly, campaign
-- and adhoc rows, which every new CHECK admits as before. No Cerbos change (PERMISSION §57), so no Cerbos restart.
-- Reversal, should it be needed before any new-kind row exists: drop the two tables, the index, next_period and report_kinds,
-- and put back CHECK (kind IN ('monthly','campaign','adhoc')).

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) social_reports: the eight kinds (one statement: the new CHECK in, the old one out), the period formats, next_period.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  kind_att smallint;
  r record;
  admitted text[];
BEGIN
  SELECT attnum INTO kind_att FROM pg_attribute
   WHERE attrelid = to_regclass('social_reports') AND attname = 'kind' AND NOT attisdropped;
  IF kind_att IS NULL THEN
    RAISE EXCEPTION '202610301300: social_reports.kind not found';
  END IF;

  -- Every CHECK on `kind` alone other than ours: 0105's social_reports_kind_check on a database that has not run this file.
  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = to_regclass('social_reports') AND contype = 'c' AND conkey = ARRAY[kind_att]
       AND conname <> 'social_reports_kind_ck'
  LOOP
    -- Drop it only when it is a plain list on `kind` and every value it admits stays admitted; otherwise stop, never narrow.
    IF r.def !~ '^CHECK \(\(kind = ANY \(ARRAY\[''[a-z_]+''::text(, ''[a-z_]+''::text)*\]\)\)\)$' THEN
      RAISE EXCEPTION '202610301300: social_reports CHECK % on kind has an unexpected shape, refusing to replace it: %', r.conname, r.def;
    END IF;
    SELECT array_agg(m[1]) INTO admitted FROM regexp_matches(r.def, '''([a-z_]+)''::text', 'g') AS m;
    IF NOT admitted <@ ARRAY['daily','weekly','monthly','quarterly','semester','yearly','campaign','adhoc']::text[] THEN
      RAISE EXCEPTION '202610301300: social_reports CHECK % admits a kind the new list would drop: %', r.conname, r.def;
    END IF;
    EXECUTE format('ALTER TABLE social_reports DROP CONSTRAINT %I', r.conname);
  END LOOP;

  ALTER TABLE social_reports
    DROP CONSTRAINT IF EXISTS social_reports_kind_ck,
    ADD CONSTRAINT social_reports_kind_ck
      CHECK (kind IN ('daily','weekly','monthly','quarterly','semester','yearly','campaign','adhoc'));
END $$;

ALTER TABLE social_reports
  ADD COLUMN IF NOT EXISTS next_period text;

ALTER TABLE social_reports
  DROP CONSTRAINT IF EXISTS social_reports_period_ck,
  ADD CONSTRAINT social_reports_period_ck CHECK (CASE kind
    WHEN 'daily' THEN coalesce(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$', false)
    WHEN 'weekly' THEN coalesce(period ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$', false)
    WHEN 'quarterly' THEN coalesce(period ~ '^[0-9]{4}-Q[1-4]$', false)
    WHEN 'semester' THEN coalesce(period ~ '^[0-9]{4}-H[12]$', false)
    WHEN 'yearly' THEN coalesce(period ~ '^[0-9]{4}$', false)
    ELSE true END),
  DROP CONSTRAINT IF EXISTS social_reports_next_period_ck,
  ADD CONSTRAINT social_reports_next_period_ck
    CHECK (next_period IS NULL OR (kind IN ('daily','weekly') AND char_length(next_period) <= 1000));

-- One live report per client, kind and period for the five new kinds (the monthly keeps SCP-5a's advisory lock).
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_reports_periodic
  ON social_reports (tenant_id, engagement_id, kind, period)
  WHERE kind IN ('daily','weekly','quarterly','semester','yearly') AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) social_engagements.report_kinds: the periodic kinds a client is due besides the monthly (SCP-Q26).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE social_engagements
  ADD COLUMN IF NOT EXISTS report_kinds text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE social_engagements
  DROP CONSTRAINT IF EXISTS social_engagements_report_kinds_ck,
  ADD CONSTRAINT social_engagements_report_kinds_ck
    CHECK (report_kinds <@ ARRAY['daily','weekly','quarterly','semester','yearly']::text[]);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) social_report_schedules: report automation (63.24.9).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- The one of the four who set or last changed it; every run acts as them, re-authorized at run time.
  owner_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  scope text NOT NULL,
  -- For 'chosen': the clients (social_engagements ids; an array cannot carry an FK, so the route checks each is an open
  -- engagement of the company, and the run narrows them again for the owner).
  engagement_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  timing jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  paused_reason text,
  paused_at timestamptz,
  paused_by uuid REFERENCES users(id),
  next_run_at timestamptz,
  next_period text,
  last_run_at timestamptz,
  last_period text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT ux_social_report_schedules_id_tenant UNIQUE (id, tenant_id)
);

ALTER TABLE social_report_schedules
  DROP CONSTRAINT IF EXISTS social_report_schedules_kind_ck,
  ADD CONSTRAINT social_report_schedules_kind_ck
    CHECK (kind IN ('daily','weekly','monthly','quarterly','semester','yearly')),
  DROP CONSTRAINT IF EXISTS social_report_schedules_scope_ck,
  ADD CONSTRAINT social_report_schedules_scope_ck CHECK (scope IN ('all','chosen')),
  -- 'chosen' exactly when it lists clients; at most 200; no NULL element.
  DROP CONSTRAINT IF EXISTS social_report_schedules_clients_ck,
  ADD CONSTRAINT social_report_schedules_clients_ck CHECK (
    (scope = 'chosen') = (cardinality(engagement_ids) > 0)
    AND cardinality(engagement_ids) <= 200
    AND array_position(engagement_ids, NULL) IS NULL
  ),
  DROP CONSTRAINT IF EXISTS social_report_schedules_timing_ck,
  ADD CONSTRAINT social_report_schedules_timing_ck CHECK (jsonb_typeof(timing) = 'object'),
  DROP CONSTRAINT IF EXISTS social_report_schedules_paused_reason_ck,
  ADD CONSTRAINT social_report_schedules_paused_reason_ck
    CHECK (paused_reason IS NULL OR paused_reason IN ('manual','owner_not_allowed','owner_inactive','kind_off','ai_drafting_off')),
  -- On exactly when there is no pause reason and no pause time.
  DROP CONSTRAINT IF EXISTS social_report_schedules_paused_ck,
  ADD CONSTRAINT social_report_schedules_paused_ck
    CHECK (enabled = (paused_reason IS NULL) AND enabled = (paused_at IS NULL)),
  -- A manual pause names who paused it; the job's pauses (and no pause) name nobody.
  DROP CONSTRAINT IF EXISTS social_report_schedules_paused_by_ck,
  ADD CONSTRAINT social_report_schedules_paused_by_ck
    CHECK ((paused_by IS NOT NULL) = (paused_reason IS NOT DISTINCT FROM 'manual')),
  -- The next run is known exactly while on, and always with its period.
  DROP CONSTRAINT IF EXISTS social_report_schedules_next_ck,
  ADD CONSTRAINT social_report_schedules_next_ck
    CHECK (enabled = (next_run_at IS NOT NULL) AND (next_run_at IS NULL) = (next_period IS NULL)),
  DROP CONSTRAINT IF EXISTS social_report_schedules_last_ck,
  ADD CONSTRAINT social_report_schedules_last_ck CHECK ((last_run_at IS NULL) = (last_period IS NULL)),
  -- Both periods in the schedule's kind's format (no legacy rows here, so the monthly is checked too).
  DROP CONSTRAINT IF EXISTS social_report_schedules_periods_ck,
  ADD CONSTRAINT social_report_schedules_periods_ck CHECK (
    (next_period IS NULL OR CASE kind
      WHEN 'daily' THEN coalesce(next_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$', false)
      WHEN 'weekly' THEN coalesce(next_period ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$', false)
      WHEN 'monthly' THEN coalesce(next_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$', false)
      WHEN 'quarterly' THEN coalesce(next_period ~ '^[0-9]{4}-Q[1-4]$', false)
      WHEN 'semester' THEN coalesce(next_period ~ '^[0-9]{4}-H[12]$', false)
      WHEN 'yearly' THEN coalesce(next_period ~ '^[0-9]{4}$', false)
      ELSE false END)
    AND (last_period IS NULL OR CASE kind
      WHEN 'daily' THEN coalesce(last_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$', false)
      WHEN 'weekly' THEN coalesce(last_period ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$', false)
      WHEN 'monthly' THEN coalesce(last_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$', false)
      WHEN 'quarterly' THEN coalesce(last_period ~ '^[0-9]{4}-Q[1-4]$', false)
      WHEN 'semester' THEN coalesce(last_period ~ '^[0-9]{4}-H[12]$', false)
      WHEN 'yearly' THEN coalesce(last_period ~ '^[0-9]{4}$', false)
      ELSE false END)
  ),
  DROP CONSTRAINT IF EXISTS social_report_schedules_deleted_ck,
  ADD CONSTRAINT social_report_schedules_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

-- At most one live company-wide schedule per kind; 'chosen' schedules never collide.
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_report_schedules_all
  ON social_report_schedules (tenant_id, kind) WHERE scope = 'all' AND deleted_at IS NULL;
-- The job's pick: due, on, not deleted.
CREATE INDEX IF NOT EXISTS ix_social_report_schedules_due
  ON social_report_schedules (next_run_at) WHERE enabled AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) social_report_runs: the bulk runs (63.24.5) and the schedules' runs (63.24.9).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_report_runs (
  -- The caller's run id (a replayed id answers the run as it stands).
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL,
  period text NOT NULL,
  -- The person: also when an agent asked for them; for a scheduled run, the schedule's owner.
  requested_by uuid NOT NULL REFERENCES users(id),
  -- The agent (as metadata.via), or {automation: 'report_schedule', scheduleId, missed?} for a scheduled run.
  via jsonb,
  rules_ref text NOT NULL,
  trigger text NOT NULL DEFAULT 'person',
  schedule_id uuid,
  status text NOT NULL DEFAULT 'queued',
  total smallint NOT NULL,
  done_count smallint NOT NULL DEFAULT 0,
  -- [{engagementId, clientName, reportId?, status, draftedVia?, reason?, simulated?}], the route's shape.
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Resume: the worker beats while it runs; a running run whose beat is over five minutes old is resumed by the job.
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT fk_social_report_runs_schedule_tenant FOREIGN KEY (schedule_id, tenant_id)
    REFERENCES social_report_schedules (id, tenant_id)
);

ALTER TABLE social_report_runs
  DROP CONSTRAINT IF EXISTS social_report_runs_kind_ck,
  ADD CONSTRAINT social_report_runs_kind_ck
    CHECK (kind IN ('daily','weekly','monthly','quarterly','semester','yearly')),
  DROP CONSTRAINT IF EXISTS social_report_runs_period_ck,
  ADD CONSTRAINT social_report_runs_period_ck CHECK (CASE kind
    WHEN 'daily' THEN coalesce(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$', false)
    WHEN 'weekly' THEN coalesce(period ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$', false)
    WHEN 'monthly' THEN coalesce(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$', false)
    WHEN 'quarterly' THEN coalesce(period ~ '^[0-9]{4}-Q[1-4]$', false)
    WHEN 'semester' THEN coalesce(period ~ '^[0-9]{4}-H[12]$', false)
    WHEN 'yearly' THEN coalesce(period ~ '^[0-9]{4}$', false)
    ELSE false END),
  DROP CONSTRAINT IF EXISTS social_report_runs_rules_ref_ck,
  ADD CONSTRAINT social_report_runs_rules_ref_ck
    CHECK (rules_ref ~ '^(company:[1-9][0-9]{0,9}|default:[A-Za-z0-9][A-Za-z0-9._-]{0,59})$'),
  DROP CONSTRAINT IF EXISTS social_report_runs_via_ck,
  ADD CONSTRAINT social_report_runs_via_ck
    CHECK ((via IS NULL OR jsonb_typeof(via) = 'object') AND (trigger <> 'schedule' OR via IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS social_report_runs_trigger_ck,
  ADD CONSTRAINT social_report_runs_trigger_ck
    CHECK (trigger IN ('person','schedule','run_now') AND (trigger = 'person') = (schedule_id IS NULL)),
  DROP CONSTRAINT IF EXISTS social_report_runs_status_ck,
  ADD CONSTRAINT social_report_runs_status_ck CHECK (status IN ('queued','running','done','failed')),
  -- Finished exactly when done or failed; anything past queued has started.
  DROP CONSTRAINT IF EXISTS social_report_runs_finished_ck,
  ADD CONSTRAINT social_report_runs_finished_ck CHECK ((status IN ('done','failed')) = (finished_at IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS social_report_runs_started_ck,
  ADD CONSTRAINT social_report_runs_started_ck CHECK (status = 'queued' OR started_at IS NOT NULL),
  DROP CONSTRAINT IF EXISTS social_report_runs_counts_ck,
  ADD CONSTRAINT social_report_runs_counts_ck CHECK (done_count BETWEEN 0 AND total),
  DROP CONSTRAINT IF EXISTS social_report_runs_results_ck,
  ADD CONSTRAINT social_report_runs_results_ck CHECK (jsonb_typeof(results) = 'array');

-- One queued-or-running run per company, kind and period (409 generation_running).
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_report_runs_active
  ON social_report_runs (tenant_id, kind, period) WHERE status IN ('queued','running');
-- One running run per company: the job starts the next queued run when the current one ends.
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_report_runs_running
  ON social_report_runs (tenant_id) WHERE status = 'running';
-- One run per schedule and period, by the job or by "Run now".
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_report_runs_schedule
  ON social_report_runs (schedule_id, period) WHERE schedule_id IS NOT NULL;
-- The 30-day list, and a schedule's newest run (its "last run" and its spend).
CREATE INDEX IF NOT EXISTS ix_social_report_runs_recent
  ON social_report_runs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_social_report_runs_schedule_recent
  ON social_report_runs (schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the third wall on both new tables, in 0105's DO-loop form (byte-identical predicate).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['social_report_schedules','social_report_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''social''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''social''))',
      t
    );
  END LOOP;
END $$;

COMMENT ON TABLE social_report_schedules IS
  'SCP-5b (BFF 63.24.9, SCP-Q38): report automation. Owned by the one of the four who set or last changed it; each run acts as '
  'the owner, re-authorized at run time, and pauses the schedule with the reason when the owner may no longer. Third wall.';
COMMENT ON TABLE social_report_runs IS
  'SCP-5b (BFF 63.24.5): a bulk "Generate with AI" run, by a person, a schedule or a schedule''s Run now. One queued-or-running '
  'run per company, kind and period; one running run per company; one run per schedule and period. Third wall.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Assert, don't assume: columns, CHECKs, keys, indexes and the walls. Catalogue reads only.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n integer;
  missing text;
BEGIN
  -- social_reports.kind: exactly one CHECK on `kind` alone, ours, admitting the eight.
  SELECT count(*) INTO n FROM pg_constraint c
   WHERE c.conrelid = to_regclass('social_reports') AND c.contype = 'c'
     AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('social_reports') AND attname = 'kind')];
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301300: social_reports must carry exactly one CHECK on kind, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = to_regclass('social_reports') AND conname = 'social_reports_kind_ck' AND pg_get_constraintdef(oid) =
     'CHECK ((kind = ANY (ARRAY[''daily''::text, ''weekly''::text, ''monthly''::text, ''quarterly''::text, ''semester''::text, ''yearly''::text, ''campaign''::text, ''adhoc''::text])))';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301300: social_reports_kind_ck must admit exactly the eight kinds';
  END IF;

  -- Columns with their type, nullability and default.
  SELECT string_agg(want.t || '.' || want.c, ', ') INTO missing
    FROM (VALUES
      ('social_reports','next_period','text','YES', NULL),
      ('social_engagements','report_kinds','ARRAY','NO', '''{}''::text[]'),
      ('social_report_schedules','id','uuid','NO', NULL), ('social_report_schedules','tenant_id','uuid','NO', NULL),
      ('social_report_schedules','owner_id','uuid','NO', NULL), ('social_report_schedules','kind','text','NO', NULL),
      ('social_report_schedules','scope','text','NO', NULL), ('social_report_schedules','engagement_ids','ARRAY','NO', '''{}''::uuid[]'),
      ('social_report_schedules','timing','jsonb','NO', NULL), ('social_report_schedules','enabled','boolean','NO', 'true'),
      ('social_report_schedules','paused_reason','text','YES', NULL),
      ('social_report_schedules','paused_at','timestamp with time zone','YES', NULL),
      ('social_report_schedules','paused_by','uuid','YES', NULL),
      ('social_report_schedules','next_run_at','timestamp with time zone','YES', NULL),
      ('social_report_schedules','next_period','text','YES', NULL),
      ('social_report_schedules','last_run_at','timestamp with time zone','YES', NULL),
      ('social_report_schedules','last_period','text','YES', NULL),
      ('social_report_schedules','created_at','timestamp with time zone','NO', 'now()'),
      ('social_report_schedules','updated_by','uuid','YES', NULL),
      ('social_report_schedules','updated_at','timestamp with time zone','NO', 'now()'),
      ('social_report_schedules','deleted_at','timestamp with time zone','YES', NULL),
      ('social_report_schedules','deleted_by','uuid','YES', NULL),
      ('social_report_schedules','origin_site','text','NO', NULL),
      ('social_report_runs','id','uuid','NO', NULL), ('social_report_runs','tenant_id','uuid','NO', NULL),
      ('social_report_runs','kind','text','NO', NULL), ('social_report_runs','period','text','NO', NULL),
      ('social_report_runs','requested_by','uuid','NO', NULL), ('social_report_runs','via','jsonb','YES', NULL),
      ('social_report_runs','rules_ref','text','NO', NULL), ('social_report_runs','trigger','text','NO', '''person''::text'),
      ('social_report_runs','schedule_id','uuid','YES', NULL), ('social_report_runs','status','text','NO', '''queued''::text'),
      ('social_report_runs','total','smallint','NO', NULL), ('social_report_runs','done_count','smallint','NO', '0'),
      ('social_report_runs','results','jsonb','NO', '''[]''::jsonb'),
      ('social_report_runs','heartbeat_at','timestamp with time zone','YES', NULL),
      ('social_report_runs','started_at','timestamp with time zone','YES', NULL),
      ('social_report_runs','finished_at','timestamp with time zone','YES', NULL),
      ('social_report_runs','created_at','timestamp with time zone','NO', 'now()'),
      ('social_report_runs','origin_site','text','NO', NULL)
    ) AS want(t, c, ty, nul, def)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                      WHERE ic.table_schema = current_schema() AND ic.table_name = want.t AND ic.column_name = want.c
                        AND ic.data_type = want.ty AND ic.is_nullable = want.nul
                        AND (want.def IS NULL OR ic.column_default = want.def));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301300: columns missing or misshapen: %', missing;
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name IN ('social_report_schedules','social_report_runs');
  IF n <> 21 + 18 THEN
    RAISE EXCEPTION '202610301300: social_report_schedules and social_report_runs must hold 21 + 18 columns, found %', n;
  END IF;

  -- The CHECKs: the simple ones by their exact text, the CASE ones by the fragments that make them NULL-safe (ILIKE: Postgres
  -- prints coalesce back as COALESCE).
  SELECT string_agg(want.t || '.' || want.c, ', ') INTO missing
    FROM (VALUES
      ('social_reports','social_reports_period_ck','CHECK (%CASE kind%daily%coalesce((period ~ %::text), false)%weekly%W(0[1-9]|[1-4][0-9]|5[0-3])%quarterly%Q[1-4]%semester%H[12]%yearly%ELSE true%'),
      ('social_reports','social_reports_next_period_ck','CHECK (((next_period IS NULL) OR ((kind = ANY (ARRAY[''daily''::text, ''weekly''::text])) AND (char_length(next_period) <= 1000))))'),
      ('social_engagements','social_engagements_report_kinds_ck','CHECK ((report_kinds <@ %''daily''::text, ''weekly''::text, ''quarterly''::text, ''semester''::text, ''yearly''::text]%'),
      ('social_report_schedules','social_report_schedules_kind_ck','CHECK ((kind = ANY (ARRAY[''daily''::text, ''weekly''::text, ''monthly''::text, ''quarterly''::text, ''semester''::text, ''yearly''::text])))'),
      ('social_report_schedules','social_report_schedules_scope_ck','CHECK ((scope = ANY (ARRAY[''all''::text, ''chosen''::text])))'),
      ('social_report_schedules','social_report_schedules_clients_ck','CHECK (%(scope = ''chosen''::text) = (cardinality(engagement_ids) > 0)%cardinality(engagement_ids) <= 200%array_position(engagement_ids, NULL%IS NULL%'),
      ('social_report_schedules','social_report_schedules_timing_ck','CHECK ((jsonb_typeof(timing) = ''object''::text))'),
      ('social_report_schedules','social_report_schedules_paused_reason_ck','CHECK (((paused_reason IS NULL) OR (paused_reason = ANY (ARRAY[''manual''::text, ''owner_not_allowed''::text, ''owner_inactive''::text, ''kind_off''::text, ''ai_drafting_off''::text]))))'),
      ('social_report_schedules','social_report_schedules_paused_ck','CHECK (((enabled = (paused_reason IS NULL)) AND (enabled = (paused_at IS NULL))))'),
      ('social_report_schedules','social_report_schedules_paused_by_ck','CHECK (((paused_by IS NOT NULL) = %paused_reason IS %DISTINCT FROM ''manual''::text%'),
      ('social_report_schedules','social_report_schedules_next_ck','CHECK (((enabled = (next_run_at IS NOT NULL)) AND ((next_run_at IS NULL) = (next_period IS NULL))))'),
      ('social_report_schedules','social_report_schedules_last_ck','CHECK (((last_run_at IS NULL) = (last_period IS NULL)))'),
      ('social_report_schedules','social_report_schedules_periods_ck','CHECK (%next_period IS NULL%CASE kind%coalesce((next_period ~ %ELSE false%last_period IS NULL%CASE kind%coalesce((last_period ~ %ELSE false%'),
      ('social_report_schedules','social_report_schedules_deleted_ck','CHECK (((deleted_at IS NULL) = (deleted_by IS NULL)))'),
      ('social_report_runs','social_report_runs_kind_ck','CHECK ((kind = ANY (ARRAY[''daily''::text, ''weekly''::text, ''monthly''::text, ''quarterly''::text, ''semester''::text, ''yearly''::text])))'),
      ('social_report_runs','social_report_runs_period_ck','CHECK (%CASE kind%coalesce((period ~ %monthly%(0[1-9]|1[0-2])$%ELSE false%'),
      ('social_report_runs','social_report_runs_rules_ref_ck','CHECK ((rules_ref ~ ''^(company:[1-9][0-9]{0,9}|default:[A-Za-z0-9][A-Za-z0-9._-]{0,59})$''::text))'),
      ('social_report_runs','social_report_runs_via_ck','CHECK ((((via IS NULL) OR (jsonb_typeof(via) = ''object''::text)) AND ((trigger <> ''schedule''::text) OR (via IS NOT NULL))))'),
      ('social_report_runs','social_report_runs_trigger_ck','CHECK (((trigger = ANY (ARRAY[''person''::text, ''schedule''::text, ''run_now''::text])) AND ((trigger = ''person''::text) = (schedule_id IS NULL))))'),
      ('social_report_runs','social_report_runs_status_ck','CHECK ((status = ANY (ARRAY[''queued''::text, ''running''::text, ''done''::text, ''failed''::text])))'),
      ('social_report_runs','social_report_runs_finished_ck','CHECK (((status = ANY (ARRAY[''done''::text, ''failed''::text])) = (finished_at IS NOT NULL)))'),
      ('social_report_runs','social_report_runs_started_ck','CHECK (((status = ''queued''::text) OR (started_at IS NOT NULL)))'),
      ('social_report_runs','social_report_runs_counts_ck','CHECK (((done_count >= 0) AND (done_count <= total)))'),
      ('social_report_runs','social_report_runs_results_ck','CHECK ((jsonb_typeof(results) = ''array''::text))')
    ) AS want(t, c, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass(want.t) AND pc.conname = want.c AND pc.contype = 'c'
                        AND pg_get_constraintdef(pc.oid) ILIKE want.def);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301300: CHECKs missing or with another expression: %', missing;
  END IF;

  -- Keys and FKs.
  SELECT string_agg(want.t || '.' || want.c, ', ') INTO missing
    FROM (VALUES
      ('social_report_schedules','ux_social_report_schedules_id_tenant','UNIQUE (id, tenant_id)'),
      ('social_report_runs','fk_social_report_runs_schedule_tenant','FOREIGN KEY (schedule_id, tenant_id) REFERENCES %social_report_schedules(id, tenant_id)')
    ) AS want(t, c, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass(want.t) AND pc.conname = want.c AND pg_get_constraintdef(pc.oid) LIKE want.def);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301300: keys or FKs missing or misshapen: %', missing;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND conrelid = to_regclass('social_report_schedules') AND confrelid IN (to_regclass('companies'), to_regclass('users'));
  IF n <> 5 THEN
    RAISE EXCEPTION '202610301300: social_report_schedules needs its FKs to companies and users (tenant, owner, paused_by, updated_by, deleted_by), found % of 5', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND conrelid = to_regclass('social_report_runs') AND confrelid IN (to_regclass('companies'), to_regclass('users'));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301300: social_report_runs needs its FKs to companies and users (tenant, requested_by), found % of 2', n;
  END IF;

  -- Indexes, with their exact definitions (partial predicates included).
  SELECT string_agg(want.i, ', ') INTO missing
    FROM (VALUES
      ('social_reports','ux_social_reports_periodic','CREATE UNIQUE INDEX ux_social_reports_periodic ON % USING btree (tenant_id, engagement_id, kind, period) WHERE ((kind = ANY (ARRAY[''daily''::text, ''weekly''::text, ''quarterly''::text, ''semester''::text, ''yearly''::text])) AND (deleted_at IS NULL))'),
      ('social_report_schedules','ux_social_report_schedules_all','CREATE UNIQUE INDEX ux_social_report_schedules_all ON % USING btree (tenant_id, kind) WHERE ((scope = ''all''::text) AND (deleted_at IS NULL))'),
      ('social_report_schedules','ix_social_report_schedules_due','CREATE INDEX ix_social_report_schedules_due ON % USING btree (next_run_at) WHERE (enabled AND (deleted_at IS NULL))'),
      ('social_report_runs','ux_social_report_runs_active','CREATE UNIQUE INDEX ux_social_report_runs_active ON % USING btree (tenant_id, kind, period) WHERE (status = ANY (ARRAY[''queued''::text, ''running''::text]))'),
      ('social_report_runs','ux_social_report_runs_running','CREATE UNIQUE INDEX ux_social_report_runs_running ON % USING btree (tenant_id) WHERE (status = ''running''::text)'),
      ('social_report_runs','ux_social_report_runs_schedule','CREATE UNIQUE INDEX ux_social_report_runs_schedule ON % USING btree (schedule_id, period) WHERE (schedule_id IS NOT NULL)'),
      ('social_report_runs','ix_social_report_runs_recent','CREATE INDEX ix_social_report_runs_recent ON % USING btree (tenant_id, created_at DESC)'),
      ('social_report_runs','ix_social_report_runs_schedule_recent','CREATE INDEX ix_social_report_runs_schedule_recent ON % USING btree (schedule_id, created_at DESC) WHERE (schedule_id IS NOT NULL)')
    ) AS want(t, i, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_indexes pi
                      WHERE pi.schemaname = current_schema() AND pi.tablename = want.t AND pi.indexname = want.i
                        AND pi.indexdef LIKE replace(want.def, '%', '%' || want.t));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301300: indexes missing or misshapen: %', missing;
  END IF;

  -- The third wall on the two new tables: RLS enabled and forced, exactly one policy, tenant + module on both sides.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid IN (to_regclass('social_report_schedules'), to_regclass('social_report_runs')) AND relrowsecurity AND relforcerowsecurity;
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301300: social_report_schedules and social_report_runs must have RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND tablename IN ('social_report_schedules','social_report_runs')
     AND policyname = 'tenant_isolation' AND cmd = 'ALL'
     AND qual LIKE '%app_current_tenants()%' AND qual LIKE '%app_module_allowed(''social''::text)%'
     AND with_check LIKE '%app_current_tenants()%' AND with_check LIKE '%app_module_allowed(''social''::text)%';
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301300: social_report_schedules and social_report_runs need the third-wall policy on USING and WITH CHECK, found % of 2', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND tablename IN ('social_report_schedules','social_report_runs');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301300: social_report_schedules and social_report_runs must carry one policy each, found %', n;
  END IF;

  -- The walls of the two existing tables are untouched (third wall, forced).
  SELECT count(*) INTO n FROM pg_class
   WHERE oid IN (to_regclass('social_reports'), to_regclass('social_engagements')) AND relrowsecurity AND relforcerowsecurity;
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301300: social_reports and social_engagements must keep RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND tablename IN ('social_reports','social_engagements') AND qual LIKE '%app_module_allowed%';
  IF n < 2 THEN
    RAISE EXCEPTION '202610301300: social_reports and social_engagements must keep their module wall (app_module_allowed) policies';
  END IF;
END $$;
