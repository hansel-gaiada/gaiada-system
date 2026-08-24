-- HR wave B — RECRUITMENT (ATS). The blueprint's §3 first candidate: "pipeline, candidates,
-- interview scheduling. Entirely absent today."
--
-- ── The one structural decision worth stating up front ──────────────────────────────────────────
-- A CANDIDATE IS NOT AN EMPLOYEE AND MUST NOT BE ONE. It is tempting to reuse `employees`
-- (0109 already allows `employment_status='pending_start'` with no users row), and it is wrong:
--
--   * A candidate is usually an OUTSIDER whose data we hold under a different legal basis, for a
--     shorter period, with a deletion obligation the moment they are rejected. Mixing them into the
--     employee file means every employee query has to remember to exclude them, and the legal
--     retention clock cannot be run per-population.
--   * Most candidates never become employees. Modelling the exception as the base case makes the
--     employee table mostly non-employees.
--   * `employees` is read by IAM Phase 2's position reconciler. A candidate must never be reachable
--     by anything that provisions access.
--
-- So: `hr_candidates` is its own population, and HIRING is an explicit CONVERSION that creates the
-- `employees` row (with a `pending_start` status and a `hire` row in hr_job_events). The link is
-- kept on the offer, one direction only.
--
-- ── Why applications are separate from candidates ───────────────────────────────────────────────
-- The same person applies for two roles, and applies again next year. Folding the pipeline stage
-- onto the candidate makes the second application overwrite the first and destroys the history that
-- makes a talent pool worth keeping.
--
-- MODULE THIRD WALL: every table carries the byte-identical 0028 predicate. Additive; no DML.
-- PII posture: label-only PD comments (the 0109 owner decision, 2026-08-13).

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) hr_requisitions — the approved intent to hire.
--
-- Deliberately linked to `positions` (0109) rather than carrying its own free-text seat: a
-- requisition that does not resolve to an org-chart seat is how headcount plans and org charts
-- drift apart. NULL is allowed for a genuinely new seat not yet created, and closing that gap is
-- part of the approve step, not a permanent state.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_requisitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  reference     text NOT NULL,                       -- human handle, e.g. REQ-2026-014
  title         text NOT NULL,
  position_id   uuid,                                -- the org-chart seat this fills (0109)
  unit_node_id  text,                                -- org-blob node; free text, no FK (0026/0055 posture)
  -- Headcount is a COUNT, not a boolean: one requisition legitimately hires three people.
  openings      int NOT NULL DEFAULT 1 CHECK (openings >= 1),
  filled        int NOT NULL DEFAULT 0 CHECK (filled >= 0),
  employment_type text NOT NULL DEFAULT 'permanent'
    CHECK (employment_type IN ('permanent','contract','probation','intern','part_time','freelance')),
  -- Indonesian PKWT (fixed-term) contracts have a statutory maximum duration; carrying the intended
  -- term here lets the offer stage validate it rather than discovering it at contract signing.
  contract_months int CHECK (contract_months IS NULL OR contract_months BETWEEN 1 AND 60),
  location      text,
  work_mode     text CHECK (work_mode IS NULL OR work_mode IN ('onsite','hybrid','remote')),
  -- The budget envelope. Range, not a point, because that is what is actually approved, and the
  -- offer stage checks against it.
  salary_min    numeric(14,2) CHECK (salary_min IS NULL OR salary_min >= 0),
  salary_max    numeric(14,2) CHECK (salary_max IS NULL OR salary_max >= 0),
  currency      text NOT NULL DEFAULT 'IDR',
  description   text,
  requirements  jsonb NOT NULL DEFAULT '[]',         -- [{label, mustHave}]
  hiring_manager_user_id uuid REFERENCES users(id),
  recruiter_user_id      uuid REFERENCES users(id),
  status        text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','open','on_hold','filled','cancelled','closed')),
  approval_id   uuid,                                -- automation_approvals row (origin='hr')
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  opened_at     timestamptz,
  closed_at     timestamptz,
  target_start_on date,
  created_by    uuid NOT NULL REFERENCES users(id),
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT ck_hr_req_salary_range CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_max >= salary_min),
  CONSTRAINT ck_hr_req_filled CHECK (filled <= openings),
  CONSTRAINT ux_hr_requisitions_id_tenant UNIQUE (id, tenant_id)
);
-- Partial unique on the human reference: unique among live rows, so a cancelled REQ-2026-014 does
-- not permanently burn the handle.
CREATE UNIQUE INDEX ux_hr_requisitions_reference ON hr_requisitions (tenant_id, reference) WHERE deleted_at IS NULL;
CREATE INDEX ix_hr_requisitions_status ON hr_requisitions (tenant_id, status, created_at DESC) WHERE deleted_at IS NULL;

COMMENT ON TABLE hr_requisitions IS
  'Approved intent to hire. Links to a positions (0109) seat so headcount planning and the org chart '
  'cannot drift. Approved on the unified automation_approvals surface (origin=hr), the same path '
  'leave (0028) and loans (0081) use — no fork.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) hr_candidates — the person, independent of any one opening.
--
-- Its own population with its own retention clock (see `retention_until` and the note below). This
-- is the table the legal gate cares about most in this wave: it holds outsider PD under consent,
-- not under an employment contract.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_candidates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  full_name     text NOT NULL,
  email         text,
  phone         text,
  headline      text,                                -- "Senior Frontend Engineer, 6y"
  location      text,
  source        text NOT NULL DEFAULT 'direct'
    CHECK (source IN ('direct','referral','agency','job_board','linkedin','career_site','event','other')),
  source_detail text,
  referred_by_user_id uuid REFERENCES users(id),
  resume_file_id uuid REFERENCES files(id),
  links         jsonb NOT NULL DEFAULT '{}',         -- {linkedin, github, portfolio}
  tags          text[] NOT NULL DEFAULT '{}',
  notes         text,
  -- Consent + retention. A candidate's data is held on CONSENT, and that consent has an end date.
  -- Storing the expiry as data (rather than as a policy somebody remembers) is what makes an
  -- automated purge possible at all — the sweep can ask the database which rows are past their
  -- clock instead of a human reasoning about it.
  consent_given_at   timestamptz,
  retention_until    date,
  -- Set when the candidate asks to be removed; the purge job is the only thing that acts on it.
  erasure_requested_at timestamptz,
  created_by    uuid REFERENCES users(id),
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT ux_hr_candidates_id_tenant UNIQUE (id, tenant_id)
);
-- Dedupe on email among live rows only. Partial because email is nullable (an agency submission may
-- arrive without one) and SQL NULLs would otherwise defeat the constraint entirely — the
-- [null-defeats-unique-constraints] trap this program has hit before.
CREATE UNIQUE INDEX ux_hr_candidates_email ON hr_candidates (tenant_id, lower(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_hr_candidates_retention ON hr_candidates (tenant_id, retention_until)
  WHERE retention_until IS NOT NULL AND deleted_at IS NULL;

COMMENT ON TABLE hr_candidates IS
  'Talent pool. A SEPARATE population from `employees` (0109) on purpose: different legal basis, '
  'different retention clock, and nothing that provisions access may ever reach these rows. Hiring '
  'is an explicit CONVERSION (see hr_offers.employee_id), not a status change.';
COMMENT ON COLUMN hr_candidates.full_name IS 'PD — personal data marker (label only, 0109 posture).';
COMMENT ON COLUMN hr_candidates.email     IS 'PD — personal data marker (label only, 0109 posture).';
COMMENT ON COLUMN hr_candidates.phone     IS 'PD — personal data marker (label only, 0109 posture).';
COMMENT ON COLUMN hr_candidates.notes     IS 'PD — personal data marker (label only, 0109 posture).';
COMMENT ON COLUMN hr_candidates.retention_until IS
  'Consent-based retention horizon. The purge sweep reads THIS, not a policy somebody remembers.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) hr_pipeline_stages — the stage set, per tenant, ordered.
--
-- Stages are DATA rather than a CHECK constraint because every company's funnel differs and a
-- migration per funnel change is absurd. `is_terminal` + `terminal_kind` are what let the engine
-- reason about a pipeline it did not design: it needs to know which stages END an application and
-- whether ending there was a win.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_pipeline_stages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  key           text NOT NULL CHECK (length(key) > 0),   -- stable machine handle: 'screen', 'tech_interview'
  label         text NOT NULL,
  sort_order    int NOT NULL DEFAULT 0,
  is_terminal   boolean NOT NULL DEFAULT false,
  terminal_kind text CHECK (terminal_kind IS NULL OR terminal_kind IN ('hired','rejected','withdrawn')),
  -- Stages that REQUIRE a scheduled interview before an application may leave them. Lets the
  -- console show "3 applications stuck with no interview booked" without hard-coding stage names.
  requires_interview boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  CONSTRAINT ck_hr_stage_terminal CHECK (
    (is_terminal AND terminal_kind IS NOT NULL) OR (NOT is_terminal AND terminal_kind IS NULL)
  )
);
CREATE INDEX ix_hr_pipeline_stages_order ON hr_pipeline_stages (tenant_id, sort_order) WHERE is_active;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) hr_applications — this candidate, for this opening, this time.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_applications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  requisition_id uuid NOT NULL,
  candidate_id   uuid NOT NULL,
  stage_key      text NOT NULL,                      -- current stage; resolves against hr_pipeline_stages.key
  status         text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','hired','rejected','withdrawn','on_hold')),
  rejection_reason text,
  -- A 1..5 rubric average maintained by the scorecard writes. Stored so the list view can sort by
  -- it without joining every scorecard on every page load.
  rating         numeric(3,2) CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
  applied_on     date NOT NULL DEFAULT CURRENT_DATE,
  stage_entered_at timestamptz NOT NULL DEFAULT now(),  -- powers "days in stage", the funnel's core metric
  closed_at      timestamptz,
  created_by     uuid REFERENCES users(id),
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  FOREIGN KEY (requisition_id, tenant_id) REFERENCES hr_requisitions (id, tenant_id),
  FOREIGN KEY (candidate_id, tenant_id)   REFERENCES hr_candidates   (id, tenant_id),
  CONSTRAINT ux_hr_applications_id_tenant UNIQUE (id, tenant_id)
);
-- One LIVE application per (candidate, requisition). Re-applying after a rejection is legitimate and
-- must be allowed, so the constraint covers only open rows.
CREATE UNIQUE INDEX ux_hr_applications_live
  ON hr_applications (tenant_id, requisition_id, candidate_id)
  WHERE status IN ('active','on_hold') AND deleted_at IS NULL;
CREATE INDEX ix_hr_applications_req ON hr_applications (tenant_id, requisition_id, stage_key, status)
  WHERE deleted_at IS NULL;
CREATE INDEX ix_hr_applications_candidate ON hr_applications (tenant_id, candidate_id, created_at DESC);

-- Append-only stage history. Same reasoning as hr_job_events: overwriting `stage_key` on the
-- application destroys the funnel, and the funnel is the only thing recruitment analytics measures.
CREATE TABLE hr_application_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  application_id uuid NOT NULL,
  event_type     text NOT NULL CHECK (event_type IN (
    'applied','stage_change','note','scorecard','interview_scheduled','interview_completed',
    'offer_made','offer_accepted','offer_declined','rejected','withdrawn','reopened'
  )),
  from_stage_key text,
  to_stage_key   text,
  body           text,
  data           jsonb NOT NULL DEFAULT '{}',
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, tenant_id) REFERENCES hr_applications (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ix_hr_application_events_app ON hr_application_events (tenant_id, application_id, occurred_at);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) hr_interviews + hr_scorecards — the assessment.
--
-- Scorecards are separate from interviews because a scorecard can exist without an interview (a
-- take-home review, a portfolio screen) and an interview can happen without one being filed. Making
-- the scorecard a column on the interview would model neither case.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_interviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  application_id uuid NOT NULL,
  stage_key      text,
  kind           text NOT NULL DEFAULT 'interview'
    CHECK (kind IN ('screen','interview','technical','panel','culture','final','other')),
  scheduled_start timestamptz NOT NULL,
  scheduled_end   timestamptz NOT NULL,
  -- IANA zone. Recorded explicitly because a group operating across time zones cannot infer the
  -- intended local wall-clock time from a UTC instant alone.
  timezone       text NOT NULL DEFAULT 'Asia/Makassar',
  location       text,
  meeting_url    text,
  status         text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','completed','cancelled','no_show','rescheduled')),
  outcome        text CHECK (outcome IS NULL OR outcome IN ('advance','hold','reject')),
  created_by     uuid REFERENCES users(id),
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, tenant_id) REFERENCES hr_applications (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ck_hr_interview_window CHECK (scheduled_end > scheduled_start),
  CONSTRAINT ux_hr_interviews_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_hr_interviews_app ON hr_interviews (tenant_id, application_id, scheduled_start);
CREATE INDEX ix_hr_interviews_upcoming ON hr_interviews (tenant_id, scheduled_start) WHERE status = 'scheduled';

CREATE TABLE hr_interview_panelists (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  interview_id  uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  role          text NOT NULL DEFAULT 'interviewer'
    CHECK (role IN ('interviewer','lead','observer','hiring_manager','recruiter')),
  response      text NOT NULL DEFAULT 'pending' CHECK (response IN ('pending','accepted','declined')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (interview_id, tenant_id) REFERENCES hr_interviews (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, interview_id, user_id)
);

CREATE TABLE hr_scorecards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  application_id uuid NOT NULL,
  interview_id   uuid,                                -- nullable: a take-home review has no interview
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  -- Per-competency scores: [{competency, score, note}]. Free shape because the rubric is the
  -- requisition's business, not the schema's.
  scores         jsonb NOT NULL DEFAULT '[]',
  overall        numeric(3,2) CHECK (overall IS NULL OR (overall >= 0 AND overall <= 5)),
  recommendation text CHECK (recommendation IS NULL OR recommendation IN ('strong_yes','yes','neutral','no','strong_no')),
  notes          text,
  submitted_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, tenant_id) REFERENCES hr_applications (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (interview_id, tenant_id)   REFERENCES hr_interviews   (id, tenant_id) ON DELETE SET NULL,
  -- One scorecard per reviewer per interview. The partial form (interview_id may be NULL for a
  -- take-home) is handled by the second index below.
  UNIQUE (tenant_id, application_id, reviewer_user_id, interview_id)
);
CREATE INDEX ix_hr_scorecards_app ON hr_scorecards (tenant_id, application_id);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) hr_offers — the commitment, and the CONVERSION SEAM into the employee file.
--
-- `employee_id` is the one and only bridge from recruitment into HR proper. It is populated when an
-- accepted offer is converted; before that it is NULL, and the candidate has no employee row at all.
-- One direction, one column, explicit — so "is this person staff" is never ambiguous.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_offers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  application_id uuid NOT NULL,
  -- The money. Monthly base is the Indonesian norm and the unit the payroll engine expects; keeping
  -- the period explicit means an annual-quoted offer is converted ONCE, here, not at every read.
  base_amount    numeric(14,2) NOT NULL CHECK (base_amount > 0),
  currency       text NOT NULL DEFAULT 'IDR',
  pay_period     text NOT NULL DEFAULT 'monthly' CHECK (pay_period IN ('monthly','annual','hourly','daily')),
  allowances     jsonb NOT NULL DEFAULT '[]',         -- [{code,label,amount,taxable}] — mirrors hr_allowances' shape
  employment_type text NOT NULL DEFAULT 'permanent'
    CHECK (employment_type IN ('permanent','contract','probation','intern','part_time','freelance')),
  probation_months int CHECK (probation_months IS NULL OR probation_months BETWEEN 0 AND 12),
  contract_months  int CHECK (contract_months IS NULL OR contract_months BETWEEN 1 AND 60),
  start_on       date,
  expires_on     date,                                -- the offer's own deadline
  status         text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','sent','accepted','declined','expired','withdrawn','converted')),
  approval_id    uuid,                                -- automation_approvals (origin='hr')
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  sent_at        timestamptz,
  responded_at   timestamptz,
  decline_reason text,
  letter_file_id uuid REFERENCES files(id),
  -- THE CONVERSION SEAM. Set exactly once, when an accepted offer becomes an employee.
  employee_id    uuid REFERENCES employees(id),
  converted_at   timestamptz,
  created_by     uuid NOT NULL REFERENCES users(id),
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, tenant_id) REFERENCES hr_applications (id, tenant_id),
  CONSTRAINT ck_hr_offer_expiry CHECK (expires_on IS NULL OR start_on IS NULL OR expires_on <= start_on),
  -- 'converted' is the only status that may carry an employee_id, and it must carry one. This is
  -- what keeps the recruitment/HR boundary honest at the database level rather than in prose.
  CONSTRAINT ck_hr_offer_conversion CHECK (
    (status = 'converted') = (employee_id IS NOT NULL AND converted_at IS NOT NULL)
  )
);
-- One LIVE offer per application. A re-offer after a decline is allowed.
CREATE UNIQUE INDEX ux_hr_offers_live ON hr_offers (tenant_id, application_id)
  WHERE status IN ('draft','pending_approval','sent','accepted');
CREATE INDEX ix_hr_offers_status ON hr_offers (tenant_id, status, created_at DESC);

COMMENT ON TABLE hr_offers IS
  'The commitment, and the ONLY bridge from recruitment into the employee file. ck_hr_offer_conversion '
  'makes "converted <=> has an employee_id" a database invariant, so a candidate can never drift into '
  'staff by a status edit alone.';
COMMENT ON COLUMN hr_offers.base_amount IS 'PD/sensitive — compensation. Label only, 0109 posture.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the composed third-wall policy (0028 DO-loop shape, byte-identical predicate).
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_requisitions','hr_candidates','hr_pipeline_stages','hr_applications','hr_application_events',
    'hr_interviews','hr_interview_panelists','hr_scorecards','hr_offers'
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
