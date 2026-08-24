-- HR wave A — TIME AND LIFECYCLE: the pieces the HR department has been operating without.
--
-- Audited 2026-08-24 against docs/blueprints/hr-department-foundation.md §3 and the standard HCM
-- capability map (core HR / time & attendance / performance / compliance). Six capability gaps are
-- closed here, and every one of them is something 0028 left as a bare counter or a container:
--
--   0028 gave us          this migration adds                          because
--   ─────────────────     ──────────────────────────────────────────   ───────────────────────────
--   hr_leave_balances     hr_leave_policies + hr_leave_accruals        a balance nobody computes is
--   (allocated/used)      (the RULE, and the LEDGER that fills it)     a number somebody typed
--   —                     hr_holiday_calendars + hr_holidays           a leave day that lands on a
--                                                                      public holiday is not a
--                                                                      leave day
--   employees (0109)      hr_job_events                                a person's history was
--   (current state only)  (effective-dated lifecycle ledger)           being OVERWRITTEN
--   hr_records            expires_on / issued_on / reference           an expired contract looked
--                         + hr_record_reminders                        exactly like a valid one
--   hr_cases.kind=        hr_review_cycles + hr_review_participants    a container is not a cycle
--     'review'
--   hr_cases.kind=        hr_case_events                               a grievance with no
--     'grievance'         (append-only case timeline)                  timeline is not a case file
--
-- MODULE THIRD WALL: every table below carries the byte-identical composed predicate established by
-- 0028 —  `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr')`  — applied through
-- the same DO-loop shape so it cannot drift per-table. A caller that reaches these tables WITHOUT
-- `withTenants(..., { modules: ["hr"] })` reads and writes ZERO rows and gets NO error.
--
-- ⚠ ONE CORRECTION TO 0028's OWN HEADER, verified against a live Postgres while writing this file
--   (src/db/hr-full-rls.test.ts pins it): 0028 says an empty/unset `app.scopes` GUC makes
--   app_module_allowed() return "false (fail-closed)". It actually returns **NULL** —
--   `string_to_array(NULLIF(current_setting(...), ''), ',')` is NULL, and `mod = ANY(NULL)` is NULL,
--   not false. The WALL IS UNAFFECTED: an RLS policy admits a row only on TRUE, and treats NULL
--   exactly as it treats false. But the distinction matters to anything OUTSIDE a policy — an
--   `IF NOT app_module_allowed('hr') THEN ...` guard in a future migration would not fire on NULL,
--   because `NOT NULL` is NULL. Test against `IS NOT TRUE`, never against `= false`.
--   0028 is already applied on the live estate, so its comment is left alone and corrected here.
--
-- PII posture: label-only PD comments, matching the owner decision recorded on 0109's `employees`
-- (2026-08-13). No encryption, no scrubbing this wave. Legal Gate 1 still blocks INGESTING real
-- employee data; it does not block defining where that data will live.
--
-- Additive throughout. Two pre-existing tables are touched, both ADD COLUMN only:
--   hr_records            three nullable compliance columns
--   hr_leave_requests     two nullable columns (policy provenance + working-day count)
-- No UPDATE, no DELETE, no INSERT..SELECT anywhere in this file.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) hr_holiday_calendars / hr_holidays — the working-day source of truth.
--
-- Why a calendar is a ROW SET and not a config blob: a holiday is per-COUNTRY and per-YEAR, moves
-- (Indonesian religious holidays follow the lunar calendar and are fixed by joint ministerial decree
-- each year), and the group operates across companies that may not share one. A blob cannot be
-- queried by `leave overlaps a holiday`, which is the only question anyone actually asks of it.
--
-- Why `weekend_days` lives on the calendar: the working week is not universal, and pinning it beside
-- the holidays keeps "is 2026-08-24 a working day for this employee" a single lookup.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_holiday_calendars (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  name         text NOT NULL,
  country_code text NOT NULL DEFAULT 'ID' CHECK (length(country_code) = 2),
  -- ISO-8601 day numbers (1=Mon .. 7=Sun). Default Sat+Sun. Stored as int[] rather than a bitmask
  -- so the value is readable in psql and indexable with `= ANY(...)` against EXTRACT(isodow).
  weekend_days int[] NOT NULL DEFAULT ARRAY[6,7],
  is_default   boolean NOT NULL DEFAULT false,
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT ck_hr_holiday_calendars_weekend CHECK (
    weekend_days <@ ARRAY[1,2,3,4,5,6,7] AND array_length(weekend_days, 1) BETWEEN 0 AND 7
  ),
  -- Composite-FK anchor (the 0027/0081 pattern): a child row can never point at a parent in a
  -- different tenant, because the FK carries tenant_id and must match this key.
  CONSTRAINT ux_hr_holiday_calendars_id_tenant UNIQUE (id, tenant_id)
);
-- Exactly ONE default calendar per tenant. A plain UNIQUE(tenant_id, is_default) would forbid a
-- SECOND non-default calendar, which is the opposite of what is wanted — hence the partial index.
CREATE UNIQUE INDEX ux_hr_holiday_calendars_default
  ON hr_holiday_calendars (tenant_id) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE hr_holidays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  calendar_id uuid NOT NULL,
  day         date NOT NULL,
  name        text NOT NULL,
  -- 'public'      — statutory, everybody is off
  -- 'joint_leave' — Indonesian `cuti bersama`: a government-declared bridging day that, unlike a
  --                 public holiday, is normally DEDUCTED from the annual leave entitlement. The
  --                 distinction is load-bearing for the accrual engine, not decorative.
  -- 'company'     — a company-declared closure day
  kind        text NOT NULL DEFAULT 'public' CHECK (kind IN ('public','joint_leave','company')),
  -- Only meaningful for joint_leave; nullable elsewhere so the column reads as "not applicable"
  -- rather than as a false.
  deducts_entitlement boolean,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (calendar_id, tenant_id) REFERENCES hr_holiday_calendars (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, calendar_id, day)
);
CREATE INDEX ix_hr_holidays_calendar_day ON hr_holidays (tenant_id, calendar_id, day);

COMMENT ON TABLE hr_holiday_calendars IS
  'Working-day definition per tenant: weekend pattern + the holiday set. Consumed by the leave '
  'working-day counter and the accrual engine (src/modules/hr/leave-accrual.ts).';
COMMENT ON COLUMN hr_holidays.kind IS
  'public = statutory | joint_leave = Indonesian cuti bersama (normally DEDUCTS annual entitlement) '
  '| company = employer-declared closure.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) hr_leave_policies / hr_leave_policy_assignments — the RULE behind a balance.
--
-- 0028's hr_leave_balances holds `allocated_minutes` with nothing that computes it. That is a
-- number a human typed, and it silently stops being true the moment somebody joins mid-year,
-- goes unpaid, or carries days over. A policy makes the allocation DERIVABLE and therefore
-- auditable: given (policy, employee, year) the engine can always restate how it got the number.
--
-- Assignment is deliberately a separate table rather than a column on `employees`: an employee can
-- hold one policy per leave_type simultaneously (annual vacation policy + a separate sick policy),
-- and the assignment is effective-dated so a mid-year policy change is a new row, not an overwrite.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_leave_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  leave_type  text NOT NULL CHECK (leave_type IN ('vacation','sick','unpaid','other')),
  -- 'upfront'     — the whole entitlement lands on the accrual anchor (Indonesian statutory default:
  --                 12 days after 12 months of continuous service, UU 13/2003 art. 79)
  -- 'monthly'     — 1/12 of the entitlement accrues at each month end
  -- 'anniversary' — the whole entitlement lands on the employee's own hire anniversary
  -- 'none'        — no automatic accrual; the balance is granted by hand (sick leave, typically,
  --                 which in Indonesia is not a counted entitlement at all but a paid-wage rule)
  accrual_method text NOT NULL DEFAULT 'upfront'
    CHECK (accrual_method IN ('upfront','monthly','anniversary','none')),
  annual_entitlement_minutes int NOT NULL DEFAULT 0 CHECK (annual_entitlement_minutes >= 0),
  -- Service required before ANY entitlement exists. Indonesia: 12 months. Kept as months rather
  -- than a date so the rule is portable across hire dates.
  waiting_period_months int NOT NULL DEFAULT 0 CHECK (waiting_period_months BETWEEN 0 AND 60),
  -- Pro-rate the first (partial) year by completed months of service. Almost always true for
  -- 'monthly'; meaningful for 'upfront' too when the employer chooses to front-load pro-rata.
  prorate_first_year boolean NOT NULL DEFAULT true,
  carryover_max_minutes int NOT NULL DEFAULT 0 CHECK (carryover_max_minutes >= 0),
  -- Months after year-end that carried-over minutes survive. 0 = they expire at year end.
  carryover_expiry_months int NOT NULL DEFAULT 0 CHECK (carryover_expiry_months BETWEEN 0 AND 24),
  -- Whether a request may drive the balance negative (advance leave).
  allow_negative_balance boolean NOT NULL DEFAULT false,
  -- Whether the working-day counter skips weekends/holidays for this type. Unpaid and 'other'
  -- leave are sometimes counted in calendar days instead.
  excludes_holidays boolean NOT NULL DEFAULT true,
  -- Requests longer than this need a second approver. NULL = single approval always.
  escalate_over_minutes int CHECK (escalate_over_minutes IS NULL OR escalate_over_minutes > 0),
  min_notice_days int NOT NULL DEFAULT 0 CHECK (min_notice_days >= 0),
  is_active   boolean NOT NULL DEFAULT true,
  origin_site text NOT NULL DEFAULT 'central',
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT ux_hr_leave_policies_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_hr_leave_policies_type ON hr_leave_policies (tenant_id, leave_type) WHERE deleted_at IS NULL AND is_active;

CREATE TABLE hr_leave_policy_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  policy_id       uuid NOT NULL,
  -- Assignment target: exactly one of subject_user_id (a person) or unit_node_id (an org-chart
  -- subtree) or NEITHER (the tenant-wide default). Enforced by the CHECK below — three targeting
  -- levels, and the engine resolves most-specific-wins.
  subject_user_id uuid REFERENCES users(id),
  unit_node_id    text,
  effective_from  date NOT NULL,
  effective_to    date,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (policy_id, tenant_id) REFERENCES hr_leave_policies (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ck_hr_leave_assign_one_target CHECK (
    (subject_user_id IS NOT NULL)::int + (unit_node_id IS NOT NULL)::int <= 1
  ),
  CONSTRAINT ck_hr_leave_assign_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX ix_hr_leave_assign_subject ON hr_leave_policy_assignments (tenant_id, subject_user_id, effective_from DESC);
CREATE INDEX ix_hr_leave_assign_unit ON hr_leave_policy_assignments (tenant_id, unit_node_id, effective_from DESC);

COMMENT ON TABLE hr_leave_policies IS
  'The RULE that produces hr_leave_balances.allocated_minutes. Indonesian statutory default is '
  'accrual_method=upfront, annual_entitlement_minutes=5760 (12 days x 480), waiting_period_months=12 '
  '(UU 13/2003 art. 79). Seeded, never assumed — see seed:hr-policies.';
COMMENT ON TABLE hr_leave_policy_assignments IS
  'Effective-dated policy targeting at three levels: person > org-unit subtree > tenant default '
  '(most specific wins). A mid-year policy change is a NEW row, never an overwrite.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) hr_leave_accruals — the append-only ledger that FILLS a balance.
--
-- Same reasoning as 0081's repayment ledger, applied to time instead of money: hr_leave_balances
-- keeps the running total for cheap reads, and this ledger keeps WHY it is that number. Without
-- it, "your balance is 7.5 days" is unanswerable the moment anybody disputes it.
--
-- Every row moves `hr_leave_balances.allocated_minutes` by `minutes` (which may be negative — an
-- expiry or a correction). The balance row stays the fast path; this stays the truth.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_leave_accruals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  year            int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  leave_type      text NOT NULL CHECK (leave_type IN ('vacation','sick','unpaid','other')),
  -- 'accrual'    — the engine granting entitlement for a period
  -- 'carryover'  — minutes carried in from the prior year (capped by policy)
  -- 'expiry'     — carried-over minutes timing out (negative)
  -- 'adjustment' — a human correction, always with a reason
  -- 'encashment' — minutes paid out instead of taken (negative); the payroll seam
  kind            text NOT NULL CHECK (kind IN ('accrual','carryover','expiry','adjustment','encashment')),
  minutes         int NOT NULL,
  policy_id       uuid,
  -- The period this row accounts for. For 'monthly' accrual this is the month end; for 'upfront'
  -- the anchor date. Makes the engine idempotent: it can ask "did I already post this period?".
  period_start    date,
  period_end      date,
  reason          text,
  created_by      uuid REFERENCES users(id),   -- NULL = posted by the engine, not by a person
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (policy_id, tenant_id) REFERENCES hr_leave_policies (id, tenant_id)
);
CREATE INDEX ix_hr_leave_accruals_subject
  ON hr_leave_accruals (tenant_id, subject_user_id, year, leave_type, created_at);
-- IDEMPOTENCE, enforced in the database rather than in the engine's head: the accrual runner can be
-- re-run for the same period (a retry, a cron double-fire, a manual catch-up) and the second insert
-- fails instead of silently doubling somebody's leave. Scoped to engine-posted rows only — a human
-- 'adjustment' has no period and must be repeatable.
CREATE UNIQUE INDEX ux_hr_leave_accruals_engine_period
  ON hr_leave_accruals (tenant_id, subject_user_id, leave_type, kind, period_end)
  WHERE created_by IS NULL AND period_end IS NOT NULL;

COMMENT ON TABLE hr_leave_accruals IS
  'Append-only ledger of every movement in allocated leave. hr_leave_balances.allocated_minutes is '
  'the running total of these rows; this table is the audit trail behind it. Engine-posted rows '
  '(created_by IS NULL) are idempotent per period via ux_hr_leave_accruals_engine_period.';

-- Provenance + the computed working-day count on the request itself. Both nullable: existing rows
-- predate the policy engine and must keep reading exactly as they do today.
ALTER TABLE hr_leave_requests
  ADD COLUMN policy_id uuid,
  -- Working days actually consumed after weekends/holidays are excluded. `minutes` stays the
  -- canonical charged unit (0028's decision); this is the human-facing number and the thing the
  -- holiday calendar changes. Storing it rather than recomputing means a later calendar edit does
  -- not retroactively rewrite what somebody was charged.
  ADD COLUMN working_days numeric(6,2) CHECK (working_days IS NULL OR working_days >= 0);
ALTER TABLE hr_leave_requests
  ADD CONSTRAINT fk_hr_leave_requests_policy
  FOREIGN KEY (policy_id, tenant_id) REFERENCES hr_leave_policies (id, tenant_id);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) hr_job_events — the effective-dated lifecycle ledger.
--
-- `employees` (0109) holds CURRENT state: one employment_status, one manager, one hire_date. Every
-- promotion, transfer, status change and pay change therefore OVERWRITES the previous fact, and the
-- person's history is gone. That is the single largest core-HR gap in the schema: it makes tenure
-- analysis, turnover reporting, "what was their grade in March" and any statutory severance
-- calculation (which depends on continuous service) impossible to answer from the database.
--
-- This is the standard HCM "worker history" spine: an append-only, effective-dated event log where
-- `employees` is the materialized head. Nothing here mutates; a correction is a new event.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_job_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  subject_user_id uuid REFERENCES users(id),   -- denormalized for the self-read path; may be NULL pre-link
  effective_on    date NOT NULL,
  event_type      text NOT NULL CHECK (event_type IN (
    'hire','probation_start','probation_pass','probation_fail','confirm',
    'promotion','transfer','demotion','status_change','manager_change',
    'compensation_change','contract_renewal','suspension','return_from_leave',
    'termination','rehire','correction'
  )),
  -- The before/after pair. JSONB rather than typed columns because the shape differs per event_type
  -- (a transfer moves unit_node_id; a compensation_change moves an amount) and a typed union across
  -- sixteen event types would be sixteen mostly-NULL columns. Both sides are stored so a single row
  -- is self-describing without needing its predecessor.
  previous        jsonb NOT NULL DEFAULT '{}',
  current         jsonb NOT NULL DEFAULT '{}',
  reason          text,
  -- What produced this row: a case (onboarding/offboarding), an approval, or a direct HR action.
  source_kind     text CHECK (source_kind IS NULL OR source_kind IN ('hr_case','approval','payroll','manual','import')),
  source_id       uuid,
  position_id     uuid,                        -- the seat as of this event, when applicable
  created_by      uuid REFERENCES users(id),
  origin_site     text NOT NULL DEFAULT 'central',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_hr_job_events_employee ON hr_job_events (tenant_id, employee_id, effective_on DESC, created_at DESC);
CREATE INDEX ix_hr_job_events_type ON hr_job_events (tenant_id, event_type, effective_on DESC);
CREATE INDEX ix_hr_job_events_subject ON hr_job_events (tenant_id, subject_user_id, effective_on DESC)
  WHERE subject_user_id IS NOT NULL;

COMMENT ON TABLE hr_job_events IS
  'Append-only effective-dated worker history. `employees` is the materialized HEAD of this log; '
  'this is the log. A correction is a NEW event (event_type=correction), never an UPDATE. Continuous '
  'service for severance is derived from hire/termination/rehire rows here, not from employees.hire_date.';
COMMENT ON COLUMN hr_job_events.previous IS 'PD — may carry personal data (names, compensation). Label only, per the 0109 posture.';
COMMENT ON COLUMN hr_job_events.current  IS 'PD — may carry personal data (names, compensation). Label only, per the 0109 posture.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) Document compliance — expiry tracking on hr_records, plus a reminder ledger.
--
-- 0028's hr_records holds contracts, documents and notes with no notion of validity. An expired
-- work permit, an expired contract and a current one are byte-identical to every query in the
-- system. The blueprint lists this under "Compliance & documents"; three nullable columns and one
-- small table close it.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE hr_records
  ADD COLUMN issued_on   date,
  ADD COLUMN expires_on  date,
  -- Free-text external identifier: contract number, permit number, certificate serial. Deliberately
  -- NOT unique — the same permit legitimately appears against two employees in a group company.
  ADD COLUMN reference   text;
ALTER TABLE hr_records
  ADD CONSTRAINT ck_hr_records_validity CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on);
-- The compliance question is always "what expires in the next N days", so the index is on the
-- expiry date and covers only rows that HAVE one.
CREATE INDEX ix_hr_records_expiry ON hr_records (tenant_id, expires_on)
  WHERE expires_on IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE hr_record_reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  record_id   uuid NOT NULL REFERENCES hr_records(id) ON DELETE CASCADE,
  -- Days before expiry this reminder represents (90/30/7 by convention). Stored rather than derived
  -- so the sweep is idempotent: it inserts (record, offset) and a re-run conflicts instead of
  -- re-notifying.
  days_before int NOT NULL CHECK (days_before >= 0),
  due_on      date NOT NULL,
  notified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, record_id, days_before)
);
CREATE INDEX ix_hr_record_reminders_due ON hr_record_reminders (tenant_id, due_on) WHERE notified_at IS NULL;

COMMENT ON TABLE hr_record_reminders IS
  'Idempotent expiry-reminder ledger for hr_records. UNIQUE(record, days_before) is what makes the '
  'nightly sweep safe to re-run: a second pass conflicts rather than re-notifying.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) hr_review_cycles / hr_review_participants — probation and review as a CYCLE, not a container.
--
-- `hr_cases.kind='review'` is a per-person container with no notion of a cohort, a window, or a
-- completion rate. The blueprint's §3 calls this out and adds a warning worth repeating here:
-- APPRAISALS ARE OWNED BY THE TR-* REPORTS PROGRAM (resource_appraisal.yaml, its own sealing rules).
-- This is deliberately NOT an appraisal engine. It is the HR-side CYCLE: who is in scope, what the
-- window is, who owes a review, and did it happen. The outcome links OUT to the appraisal the
-- reports program owns (`appraisal_id`), and never duplicates its content.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_review_cycles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  -- 'probation' — driven per-employee off the hire date, not off a shared window
  -- 'periodic'  — an org-wide cohort (annual, semi-annual)
  -- 'project'   — an ad-hoc cohort tied to a delivery
  kind        text NOT NULL DEFAULT 'periodic' CHECK (kind IN ('probation','periodic','project')),
  period_start date NOT NULL,
  period_end   date NOT NULL CHECK (period_end >= period_start),
  -- The window in which reviews must be COMPLETED (distinct from the period being reviewed).
  opens_on    date,
  closes_on   date,
  status      text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','open','closed','cancelled')),
  -- Free-form scoring/competency definition for this cycle; the shape is the cycle's own business.
  template    jsonb NOT NULL DEFAULT '{}',
  created_by  uuid REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT ck_hr_review_window CHECK (closes_on IS NULL OR opens_on IS NULL OR closes_on >= opens_on),
  CONSTRAINT ux_hr_review_cycles_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_hr_review_cycles_status ON hr_review_cycles (tenant_id, status, period_end DESC) WHERE deleted_at IS NULL;

CREATE TABLE hr_review_participants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  cycle_id        uuid NOT NULL,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  reviewer_user_id uuid REFERENCES users(id),   -- NULL until assigned; defaults to the org-chart line
  due_on          date,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','submitted','acknowledged','waived')),
  -- The probation verdict, and the ONLY place a probation outcome is recorded. NULL for a periodic
  -- cycle. 'extend' is real and common — it produces a new probation cycle, not a status change.
  outcome         text CHECK (outcome IS NULL OR outcome IN ('pass','extend','fail')),
  outcome_note    text,
  -- The OUTWARD link to the reports program's artifact. This table never holds appraisal content.
  appraisal_id    uuid,
  -- The per-person container 0028 already models, when one was opened for this participant.
  case_id         uuid,
  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (cycle_id, tenant_id) REFERENCES hr_review_cycles (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, cycle_id, subject_user_id)
);
CREATE INDEX ix_hr_review_participants_subject ON hr_review_participants (tenant_id, subject_user_id, created_at DESC);
CREATE INDEX ix_hr_review_participants_reviewer ON hr_review_participants (tenant_id, reviewer_user_id, status)
  WHERE status IN ('pending','in_progress');

COMMENT ON TABLE hr_review_cycles IS
  'HR-side review/probation CYCLE (cohort + window + completion). NOT an appraisal engine — '
  'appraisal content is owned by the TR-* reports program (resource_appraisal.yaml); this links out '
  'via hr_review_participants.appraisal_id and never duplicates it.';
COMMENT ON COLUMN hr_review_participants.outcome IS
  'Probation verdict only. `extend` produces a NEW probation cycle rather than mutating this row.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (7) hr_case_events — the append-only case timeline.
--
-- `hr_cases.kind='grievance'` exists with no workflow: a grievance is a title, a status and a JSONB
-- blob. A grievance or disciplinary file whose history can be edited is not evidence of anything,
-- which is precisely when a case file matters most. One append-only timeline serves every case
-- kind — discipline, grievance, onboarding, review — and gives the console something to render.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_case_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  case_id     uuid NOT NULL REFERENCES hr_cases(id) ON DELETE CASCADE,
  event_type  text NOT NULL CHECK (event_type IN (
    'opened','note','evidence','meeting','statement','warning_issued','action_taken',
    'status_change','assigned','escalated','resolved','closed','reopened','appeal'
  )),
  body        text,
  -- Structured payload for the typed events: {level} for warning_issued, {from,to} for
  -- status_change, {attendees,heldOn} for meeting.
  data        jsonb NOT NULL DEFAULT '{}',
  file_id     uuid REFERENCES files(id),
  -- 'hr_only'      — never visible to the subject (investigation notes; the same reasoning that
  --                  keeps hr_records.record_type='note' off the employee portal)
  -- 'participants' — subject + HR
  visibility  text NOT NULL DEFAULT 'hr_only' CHECK (visibility IN ('hr_only','participants')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_hr_case_events_case ON hr_case_events (tenant_id, case_id, occurred_at, created_at);

COMMENT ON TABLE hr_case_events IS
  'Append-only timeline for any hr_case. No UPDATE and no DELETE path exists in the controller — a '
  'retraction is a NEW event. `visibility=hr_only` is the default so an investigation note is never '
  'exposed to the subject by omission.';
COMMENT ON COLUMN hr_case_events.body IS 'PD — may carry personal data. Label only, per the 0109 posture.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the composed third-wall policy, in the 0028/0081 DO-loop shape so the predicate is
-- byte-identical across every hr_* table and cannot drift per-table.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_holiday_calendars','hr_holidays','hr_leave_policies','hr_leave_policy_assignments',
    'hr_leave_accruals','hr_job_events','hr_record_reminders','hr_review_cycles',
    'hr_review_participants','hr_case_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''hr''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''hr''))',
      t
    );
  END LOOP;
END $$;
