-- TR-06 (Work Tracker / Reports / Appraisal program, §4 "0056") —
-- report_work_calendars, report_checkins, report_work_facts + THE THIRD RLS WALL for the
-- 'reports' module (mirrors 0028_module_hr.sql's 'hr' wall byte-for-byte).
--
-- ─────────────────────────── NUMBERING ───────────────────────────
-- Claimed AT IMPLEMENTATION TIME per migrations/README.md rule 5 and the doc's §15 PROCESS RULE
-- (never trust the number written in the doc/README without re-checking `ls migrations | tail`).
-- `ls migrations` showed head = 0055_org_unit_memberships.sql (TR-03, merged) with 0056 still
-- free — the doc's and README's `0056` reservation held this time, no further rebase needed. If a
-- later ticket in this program finds 0056 taken, the same rule applies: take the next free slot
-- and record the rebase in migrations/README.md, exactly as TR-01 did for 0050->0054.
--
-- ─────────────────────────── WHAT THIS IS FOR ───────────────────────────
-- The atomic fact grain (§4a invariant 1: person x project x day) plus its two supporting tables:
--   report_work_calendars — per-tenant working-day/holiday/workday-length config, the substrate
--     the check-in compliance model (§5.3) uses to decide which days are even "expected".
--   report_checkins       — one mandatory check-in row per person per expected day; auto_missed
--     rows are only ever written for expected days (§5.3's false-negative guard — a person on
--     approved leave loses nothing against the compliance metric).
--   report_work_facts     — the additive-measures-only atomic grain every department/company/
--     week/month number is a SUM over (§4a invariant 1). Computed by TR-07's nightly job as a
--     (tenant, fact_date)-sliced DELETE+INSERT (§4a invariant 5) — NOT backfilled by this
--     migration; there is no historical data to derive it from yet, so this file ships schema
--     only, no DML, matching the brief's explicit allowance.
--
-- All three sit behind the reports module's third wall: appraisal/check-in data is HR-grade
-- sensitive, hence a full module-scope wall rather than only the tenant wall. `app_module_allowed`
-- itself is NOT redefined here — it already exists globally since 0028 (CREATE OR REPLACE, GRANT
-- EXECUTE TO PUBLIC); this migration only composes it into three new policies with mod='reports'.
--
-- ─────────────────────── RULINGS FROM §15 APPLIED (binding, not preference) ───────────────────────
-- (1) `origin_site text NOT NULL` with NO DEFAULT on all three tables. The doc's own §4 DDL block
--     (reproduced above the amendment log) still reads `DEFAULT 'central'` — not yet rewritten
--     there; §15's later amendment overrides that for every table in the 0055-0059 range. A
--     default is wrong under the sync engine's site/central topology: a site-originated row would
--     silently mislabel itself 'central'. No default means every writer (TR-09's check-in
--     endpoints, TR-07's fact job, any calendar-config admin write) MUST pass config.originSite
--     explicitly.
-- (2) Composite-FK-to-tenant-scoped-parent rule (0027 precedent, restated by TR-01's fix #2 and
--     applied again by TR-03). CHECKED against every column in these three tables:
--       - `tenant_id -> companies(id)` (all three tables): companies IS the tenant, not a
--         tenant-scoped CHILD of it — plain FK, same as every other table.
--       - `updated_by -> users(id)`, `user_id -> users(id)`, `excused_by -> users(id)`: users is
--         NOT tenant-scoped (confirmed by the ticket brief and by every precedent migration in
--         this program) — plain FK.
--       - `provider_tenant_id -> companies(id)` (report_work_facts): also companies, the tenant
--         identity table itself — plain FK, same reasoning as tenant_id.
--       - `project_id -> projects(id)` (report_work_facts): projects IS a tenant-scoped CHILD of
--         companies. APPLIES. A plain `REFERENCES projects(id)` would let a report_work_facts row
--         carry tenant A's tenant_id while project_id points at tenant B's project — invisible to
--         every RLS-scoped SELECT (§4a invariant 1's atomic grain would then silently misattribute
--         a fact to the wrong company). Closed with the composite FK
--         `(project_id, tenant_id) REFERENCES projects(id, tenant_id)`, exactly as 0027 closed the
--         same class on `service_assignments.unit_id` and TR-01 closed it on
--         `pm_task_assignees.task_id`. `projects` had NO existing `UNIQUE(id, tenant_id)` (checked:
--         only the plain PK on `id`), so this migration adds one additively below — it cannot fail
--         on existing data, `id` is already the PK. project_id stays NULLable (non-project work,
--         §3.1); Postgres's default MATCH SIMPLE means a NULL project_id short-circuits the FK
--         check entirely (nothing to smuggle when there is no project reference), so the
--         composite form costs nothing on the common non-project-work row.
--     `unit_node_id`, `department_node_id`, `provider_unit_node_id` (report_work_facts) carry NO
--     FK at all (0029 convention — org-node ids are a free-form JSONB-tree id, not a database
--     table row) — same posture as `org_unit_memberships.unit_node_id` and `projects.department_id`.
-- (3) `*_node_id` columns: covered directly above — no FK, per (2)'s tail and the 0029 convention.
-- (4) Backfill / NOBYPASSRLS-role test rule: THIS MIGRATION SHIPS NO BACKFILL DML. All three
--     tables are freshly CREATE TABLE'd here with zero pre-existing rows to backfill from —
--     report_work_calendars is per-tenant config (defaults are fine until an admin edits it),
--     report_checkins has no historical source to derive from (that's TR-09's nightly job,
--     going forward only), and report_work_facts is computed entirely by TR-07's job, never
--     backfilled by DDL. Per the brief: "If so, say so" — said here, and no NOBYPASSRLS-role test
--     is shipped because there is no backfill to prove.
--
-- ─────────────────────── PG15+ ASSERTION (UNIQUE NULLS NOT DISTINCT) ───────────────────────
-- `UNIQUE NULLS NOT DISTINCT` (report_work_facts' idempotency key) is PG15+ syntax. The stack runs
-- postgres:17-alpine (verified: 0055's own header confirms PG17 live), but a future downgrade or a
-- misconfigured test/CI Postgres must fail LOUDLY at migration time, not with an obscure syntax
-- error three statements later. Asserted below via server_version_num (150000 = 15.0).
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'migration 0056 requires PostgreSQL 15+ (UNIQUE NULLS NOT DISTINCT on report_work_facts); '
      'server_version_num = %', current_setting('server_version_num');
  END IF;
END $$;

-- Composite UNIQUE so projects can be the target of report_work_facts' two-column FK below
-- (Postgres requires the referenced columns to be covered by a UNIQUE or PRIMARY KEY). Redundant
-- with the PK on id alone, so it CANNOT fail on existing data — the standard tenant-scoped-
-- foreign-key pattern (0027, restated by TR-01/TR-03).
ALTER TABLE projects ADD CONSTRAINT ux_projects_id_tenant UNIQUE (id, tenant_id);

-- ══ (1) report_work_calendars — per-tenant working-day/holiday config, one row per tenant v1
--        (per-unit calendars deferred, §13). Feeds the check-in compliance "expected(user,date)"
--        predicate (§5.3) and the fact job's on-time/business-day math.
CREATE TABLE report_work_calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  working_days    int[] NOT NULL DEFAULT '{1,2,3,4,5}',   -- ISO dow, Mon=1
  holidays        jsonb NOT NULL DEFAULT '[]',            -- [{date:'2026-08-17', label:'Independence Day'}]
  workday_minutes int NOT NULL DEFAULT 480,               -- matches hr leave day=480 convention
  updated_by      uuid REFERENCES users(id),
  origin_site     text NOT NULL,                          -- ruling (1): NO default
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)                                       -- one per tenant v1; per-unit deferred (§13)
);

-- ══ (2) report_checkins — one mandatory check-in row per person per expected day (§5.3).
--        auto_missed rows are written ONLY for expected days by the nightly job (TR-09), so
--        compliance is a real queryable entity, not derived-only.
CREATE TABLE report_checkins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  checkin_date   date NOT NULL,
  status         text NOT NULL CHECK (status IN ('submitted','auto_missed','excused')),
  summary        text NOT NULL DEFAULT '',       -- person-edited; TR-09 enforces non-empty on submit
  blockers       text,
  prefill        jsonb NOT NULL DEFAULT '{}',    -- the derived draft shown (audit: what was prefilled)
  edited         boolean NOT NULL DEFAULT false, -- did the person change the prefill before submit
  source         text NOT NULL DEFAULT 'ui' CHECK (source IN ('ui','wa','mcp','system')),
  submitted_at   timestamptz,
  excused_reason text,                           -- set by manager/HR on 'excused'
  excused_by     uuid REFERENCES users(id),
  origin_site    text NOT NULL,                  -- ruling (1): NO default
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, checkin_date)       -- one check-in per person per day
);
CREATE INDEX ix_report_checkins_day ON report_checkins (tenant_id, checkin_date, status);

-- ══ (3) report_work_facts — THE atomic fact grain (§4a invariant 1: person x project x day).
--        Additive measures ONLY — no ratios, no percentages, no pre-divided values (§4a invariant
--        2; ratios live as numerator/denominator in rollup_metrics, TR-08). Computed by TR-07's
--        nightly job as a (tenant, fact_date)-sliced DELETE+INSERT (§4a invariant 5) — idempotent
--        re-derivation from append-only substrate, which is what makes historical backfill safe.
CREATE TABLE report_work_facts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES companies(id),
  fact_date             date NOT NULL,
  user_id               uuid REFERENCES users(id),        -- NULL = unit-attributed only (§3.1)
  project_id            uuid,                              -- composite FK below; NULL = non-project work
  unit_node_id          text,                              -- exact as-of unit (NO FK, 0029)
  department_node_id    text,                              -- division rolled to department (NO FK, 0029)
  provider_tenant_id    uuid REFERENCES companies(id),     -- shared-service stamp (§3.2)
  provider_unit_node_id text,                               -- NO FK, 0029
  -- additive measures ONLY; ratios are NEVER stored here (numerator/denominator live in rollups)
  tasks_completed            int NOT NULL DEFAULT 0,
  tasks_completed_on_time    int NOT NULL DEFAULT 0,
  tasks_completed_estimated  int NOT NULL DEFAULT 0,       -- completed tasks that carried an estimate
  estimate_minutes_completed int NOT NULL DEFAULT 0,       -- Σ estimates of completed (anti-slicing weight)
  tasks_reopened             int NOT NULL DEFAULT 0,
  tasks_created              int NOT NULL DEFAULT 0,
  minutes_logged             int NOT NULL DEFAULT 0,
  minutes_billable           int NOT NULL DEFAULT 0,
  minutes_contributed        int NOT NULL DEFAULT 0,       -- contributor-role minutes (collab axis)
  comments_authored          int NOT NULL DEFAULT 0,
  docs_updated               int NOT NULL DEFAULT 0,
  activity_events            int NOT NULL DEFAULT 0,
  activity_linked_exact      int NOT NULL DEFAULT 0,       -- work_activity_links confidence='exact'
  activity_by_source         jsonb NOT NULL DEFAULT '{}',  -- {"pm":4,"github":7,...}
  computed_at  timestamptz NOT NULL DEFAULT now(),
  job_run_id   uuid,                                        -- which fact-job run wrote this row
  origin_site  text NOT NULL,                                -- ruling (1): NO default
  -- ruling (2): tenant-scoped composite FK, NOT `REFERENCES projects(id)`
  CONSTRAINT fk_report_work_facts_project_tenant
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id),
  -- PG15+ (asserted above): makes the daily upsert idempotent even for rows with NULL user/project.
  UNIQUE NULLS NOT DISTINCT (tenant_id, fact_date, user_id, project_id, unit_node_id)
);
CREATE INDEX ix_rwf_person ON report_work_facts (tenant_id, user_id, fact_date);
CREATE INDEX ix_rwf_project ON report_work_facts (tenant_id, project_id, fact_date);
CREATE INDEX ix_rwf_dept ON report_work_facts (tenant_id, department_node_id, fact_date);
CREATE INDEX ix_rwf_provider ON report_work_facts (provider_tenant_id, provider_unit_node_id, fact_date)
  WHERE provider_tenant_id IS NOT NULL;

-- ══ FORCE RLS + the ONE composed tenant_isolation policy per report_* table — THE THIRD WALL for
--    the 'reports' module. Byte-identical idiom to 0028_module_hr.sql's DO loop, with
--    app_module_allowed('reports') instead of ('hr'); app_module_allowed itself already exists
--    globally (defined once in 0028, GRANT EXECUTE TO PUBLIC) and is reused here unmodified.
--    Written once in a DO loop so the third-wall predicate can never drift per-table — every
--    report_* table gets the same
--    `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports')`, on BOTH USING
--    (reads) and WITH CHECK (writes: you cannot INSERT a report_* row without declaring the
--    reports module scope). Each table has a tenant_id column, so the rls.test.ts FORCE-RLS sweep
--    covers all three for free.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'report_work_calendars','report_checkins','report_work_facts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''reports''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''reports''))',
      t
    );
  END LOOP;
END $$;

COMMENT ON TABLE report_work_calendars IS
  'TR-06 — per-tenant working-day/holiday/workday-length config (one row per tenant v1). Feeds the '
  'check-in compliance expected(user,date) predicate (§5.3) and the fact job''s business-day math. '
  'Third wall: reports module scope required (app_module_allowed(''reports'')).';
COMMENT ON TABLE report_checkins IS
  'TR-06 — one mandatory check-in row per person per expected day (§5.3 false-negative guard). '
  'auto_missed rows are written ONLY for expected days by the nightly job — compliance is a real '
  'queryable entity, not derived-only. Third wall: reports module scope required.';
COMMENT ON TABLE report_work_facts IS
  'TR-06 — the atomic fact grain (§4a invariant 1: person x project x day). Additive measures ONLY '
  '— never a ratio or percentage (§4a invariant 2; ratios live as numerator/denominator in '
  'rollup_metrics). Computed by TR-07''s nightly job as a (tenant, fact_date)-sliced DELETE+INSERT '
  '(§4a invariant 5) — NOT backfilled by this migration (no historical source yet). Third wall: '
  'reports module scope required.';
