-- HR wave D — PAYROLL AND SEPARATION.
--
-- ⚠ SEQUENCING NOTE, recorded because this contradicts a written plan and a future reader deserves
--    to know it was deliberate. `docs/blueprints/employee-portal-foundation.md` §6 assigns the
--    payroll ENGINE to the employee-portal program and gates it on "statutory facts". The owner
--    directed on 2026-08-24 that payroll be built as part of the HR department instead. That
--    decision is honoured here, and the gate it was protecting is honoured differently: every
--    statutory number lives in ONE effective-dated table (hr_statutory_parameters) with a
--    `ratified_by` column that is NULL until an owner signs off. Seeded values are therefore
--    explicitly UNRATIFIED — the engine computes with them and every payslip it produces carries the
--    parameter-set id it used, so a later correction is a re-run against ratified numbers rather
--    than an archaeology exercise. Nothing here claims the seeded rates are legally verified.
--
-- ── Why a payroll RUN is a first-class object ───────────────────────────────────────────────────
-- Payroll is not "compute a number per person". It is a period-scoped batch that is drafted,
-- reviewed, approved, paid, and — crucially — must be reproducible afterwards. So:
--   hr_payroll_runs        the batch  (period, status, who approved, which parameters were used)
--   hr_payslips            one per employee per run (the FROZEN result)
--   hr_payslip_lines       the itemization (earnings, deductions, employer contributions)
-- The lines are materialized, not recomputed on read, for exactly the reason 0081 froze the loan
-- schedule: the payslip is the artefact the employee was given. A later change to a rounding rule
-- or a tax rate must NEVER silently rewrite what somebody was told they earned.
--
-- ── Employer contributions are LINES, not a separate concept ────────────────────────────────────
-- BPJS employer contributions are not deducted from the employee but they ARE part of the run's
-- cost and must appear on the statutory report. Making them a line with `side='employer'` means one
-- itemization serves the payslip (employee lines only) and the cost report (all lines), instead of
-- two tables that drift.
--
-- MODULE THIRD WALL: byte-identical 0028 predicate on every table. Additive; no DML.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) hr_statutory_parameters — every regulated number, effective-dated, in ONE place.
--
-- This table is the whole answer to "payroll is blocked on statutory facts". The facts are DATA:
-- versioned by date, attributed to a legal source, and marked ratified or not. Nothing in the
-- engine hard-codes a rate, a cap, or a bracket — a regulation change is an INSERT, and last year's
-- payroll still recomputes with last year's numbers because the run records which set it used.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_statutory_parameter_sets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deliberately NOT tenant-scoped by nature (a national rate is national), but tenant_id is kept
  -- NOT NULL and the third wall applies: the group's companies may sit in different jurisdictions,
  -- and a shared row would be a cross-tenant read the rest of this schema forbids. The cost is
  -- duplicated rows per company; the benefit is that the isolation model has no exception in it.
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  country_code  text NOT NULL DEFAULT 'ID' CHECK (length(country_code) = 2),
  name          text NOT NULL,                        -- 'Indonesia 2026'
  effective_from date NOT NULL,
  effective_to   date,
  -- NULL until an owner (or the finance/legal function) signs the numbers off. The payroll runner
  -- REFUSES to move a run past 'draft' against an unratified set unless explicitly forced, and
  -- records the force. That is the gate, expressed as data.
  ratified_by   uuid REFERENCES users(id),
  ratified_at   timestamptz,
  source_note   text,                                 -- the regulation reference
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_hr_param_set_range CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_hr_param_set_ratified CHECK ((ratified_by IS NULL) = (ratified_at IS NULL)),
  CONSTRAINT ux_hr_statutory_parameter_sets_id_tenant UNIQUE (id, tenant_id)
);
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE hr_statutory_parameter_sets ADD CONSTRAINT ex_hr_param_sets_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    country_code WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );

CREATE TABLE hr_statutory_parameters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  set_id      uuid NOT NULL,
  -- Namespaced key. Examples:
  --   bpjs.kesehatan.employer_rate | bpjs.kesehatan.wage_cap | bpjs.jht.employee_rate
  --   bpjs.jp.wage_cap             | pph21.ptkp.K/1         | pph21.ter.A
  --   pph21.bracket.1              | thr.min_service_months  | severance.multiplier.<years>
  key         text NOT NULL CHECK (length(key) > 0),
  -- One of these carries the value. `value_num` for rates/amounts, `value_json` for anything with
  -- structure (a bracket table, the TER band list). Two columns rather than a stringly-typed one so
  -- the engine never parses a number out of text.
  value_num   numeric(18,6),
  value_json  jsonb,
  unit        text CHECK (unit IS NULL OR unit IN ('rate','amount','months','years','count')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (set_id, tenant_id) REFERENCES hr_statutory_parameter_sets (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, set_id, key),
  CONSTRAINT ck_hr_param_one_value CHECK ((value_num IS NOT NULL)::int + (value_json IS NOT NULL)::int = 1)
);
CREATE INDEX ix_hr_statutory_parameters_key ON hr_statutory_parameters (tenant_id, set_id, key);

COMMENT ON TABLE hr_statutory_parameter_sets IS
  'Effective-dated bundle of every regulated payroll number. `ratified_by IS NULL` means the '
  'numbers are UNVERIFIED — the runner will not finalize a run against an unratified set without an '
  'explicit, recorded force. This is the "blocked on statutory facts" gate, expressed as data.';
COMMENT ON TABLE hr_statutory_parameters IS
  'One regulated value. The engine reads THESE, never a constant in code — so a regulation change is '
  'an INSERT and a past period still recomputes with its own period''s numbers.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) hr_payroll_runs — the batch.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_payroll_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  reference     text NOT NULL,                        -- 'PR-2026-08'
  -- 'regular' | 'thr' (the Indonesian religious-holiday allowance, a separate statutory run paid
  -- 7 days before the holiday) | 'bonus' | 'final' (a leaver's last pay, including severance) |
  -- 'correction' (an off-cycle re-run that adjusts a finalized period)
  kind          text NOT NULL DEFAULT 'regular'
    CHECK (kind IN ('regular','thr','bonus','final','correction')),
  period_start  date NOT NULL,
  period_end    date NOT NULL CHECK (period_end >= period_start),
  pay_date      date,
  currency      text NOT NULL DEFAULT 'IDR',
  status        text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','calculated','pending_approval','approved','paid','cancelled')),
  -- WHICH numbers this run used. Frozen at calculation. This is what makes a run reproducible and
  -- what a correction run compares against.
  parameter_set_id uuid,
  -- Set when a run was finalized against an UNRATIFIED parameter set. Never cleared. The audit
  -- trail for the gate above.
  unratified_override_by uuid REFERENCES users(id),
  unratified_override_at timestamptz,
  unratified_override_reason text,
  -- Denormalized totals, written in the same transaction as the payslips so the list view needs no
  -- aggregate. Recomputed on every calculate; meaningless before then, hence nullable.
  total_gross   numeric(16,2),
  total_net     numeric(16,2),
  total_employer_cost numeric(16,2),
  employee_count int,
  approval_id   uuid,                                 -- automation_approvals (origin='hr')
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  calculated_at timestamptz,
  paid_at       timestamptz,
  note          text,
  created_by    uuid NOT NULL REFERENCES users(id),
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  FOREIGN KEY (parameter_set_id, tenant_id) REFERENCES hr_statutory_parameter_sets (id, tenant_id),
  CONSTRAINT ck_hr_payroll_override CHECK (
    (unratified_override_by IS NULL) = (unratified_override_at IS NULL)
  ),
  CONSTRAINT ux_hr_payroll_runs_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX ux_hr_payroll_runs_reference ON hr_payroll_runs (tenant_id, reference) WHERE deleted_at IS NULL;
-- At most ONE live REGULAR run per period. Corrections, THR and bonus runs are deliberately exempt —
-- those legitimately coexist with the regular run for the same month, which is the entire reason
-- `kind` exists.
CREATE UNIQUE INDEX ux_hr_payroll_runs_regular_period
  ON hr_payroll_runs (tenant_id, period_start, period_end)
  WHERE kind = 'regular' AND status <> 'cancelled' AND deleted_at IS NULL;
CREATE INDEX ix_hr_payroll_runs_status ON hr_payroll_runs (tenant_id, status, period_end DESC) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) hr_payslips + hr_payslip_lines — the frozen result.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_payslips (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  run_id          uuid NOT NULL,
  employee_id     uuid NOT NULL REFERENCES employees(id),
  -- Denormalized so the employee's own payslip read (`/me/pay`) never has to join `employees`,
  -- which is behind a policy the employee themself cannot satisfy.
  subject_user_id uuid REFERENCES users(id),
  -- The inputs, frozen. Copied at calculation rather than referenced, because the compensation row
  -- can be superseded and the payslip must keep showing what it was actually computed from.
  base_amount     numeric(14,2) NOT NULL DEFAULT 0,
  fte             numeric(4,3) NOT NULL DEFAULT 1.000,
  working_days    numeric(6,2),
  paid_days       numeric(6,2),
  unpaid_days     numeric(6,2),
  overtime_minutes int NOT NULL DEFAULT 0,
  ptkp_status     text,
  has_npwp        boolean,
  -- The results.
  gross           numeric(14,2) NOT NULL DEFAULT 0,
  taxable_gross   numeric(14,2) NOT NULL DEFAULT 0,
  bpjs_base       numeric(14,2) NOT NULL DEFAULT 0,
  employee_deductions numeric(14,2) NOT NULL DEFAULT 0,
  tax_withheld    numeric(14,2) NOT NULL DEFAULT 0,
  net             numeric(14,2) NOT NULL DEFAULT 0,
  employer_cost   numeric(14,2) NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'IDR',
  status          text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','final','paid','void')),
  -- Whether the employee has been shown it. Distinct from `paid`: a payslip can be published before
  -- the money lands, and often is.
  published_at    timestamptz,
  file_id         uuid REFERENCES files(id),          -- the rendered PDF, when one exists
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, tenant_id) REFERENCES hr_payroll_runs (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, run_id, employee_id),
  CONSTRAINT ux_hr_payslips_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_hr_payslips_employee ON hr_payslips (tenant_id, employee_id, created_at DESC);
-- The self-read path: an employee listing their own published payslips.
CREATE INDEX ix_hr_payslips_subject ON hr_payslips (tenant_id, subject_user_id, created_at DESC)
  WHERE subject_user_id IS NOT NULL AND published_at IS NOT NULL;

CREATE TABLE hr_payslip_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  payslip_id  uuid NOT NULL,
  -- 'employee' lines net out to the employee's pay; 'employer' lines are cost only and never touch
  -- `net`. One itemization serves the payslip and the employer-cost report (see the header note).
  side        text NOT NULL DEFAULT 'employee' CHECK (side IN ('employee','employer')),
  category    text NOT NULL CHECK (category IN (
    'base','allowance','overtime','bonus','thr','leave_encashment','reimbursement',
    'tax','bpjs','loan_repayment','unpaid_leave','advance','other_deduction','severance'
  )),
  code        text NOT NULL,                          -- 'transport', 'bpjs.jht', 'pph21'
  label       text NOT NULL,
  -- Signed: positive adds to gross/cost, negative subtracts. One signed column instead of a
  -- direction flag plus a magnitude, so a sum is a sum.
  amount      numeric(14,2) NOT NULL,
  taxable     boolean NOT NULL DEFAULT false,
  bpjs_base   boolean NOT NULL DEFAULT false,
  -- Where this line came from, so a disputed number can be traced back to its source row.
  source_kind text CHECK (source_kind IS NULL OR source_kind IN (
    'compensation','allowance','statutory','loan','leave','attendance','manual','severance'
  )),
  source_id   uuid,
  meta        jsonb NOT NULL DEFAULT '{}',            -- the calculation's own workings
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payslip_id, tenant_id) REFERENCES hr_payslips (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ix_hr_payslip_lines_payslip ON hr_payslip_lines (tenant_id, payslip_id, side, sort_order);

COMMENT ON TABLE hr_payslips IS
  'The FROZEN per-employee result of a run. Inputs are copied, not referenced — a superseded '
  'compensation row must never change what a past payslip says it was computed from (the 0081 '
  'frozen-schedule reasoning, applied to pay).';
COMMENT ON COLUMN hr_payslip_lines.amount IS
  'SIGNED. Positive adds, negative subtracts. side=employer lines are cost only and never enter net.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) hr_payroll_inputs — the per-period variable facts.
--
-- Overtime hours, a one-off bonus, a reimbursement, an unpaid-leave day. These are neither standing
-- compensation (wave C) nor a computed result — they are what makes THIS period different, and they
-- must be capturable before the run is calculated and auditable after.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_payroll_inputs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  period_start date NOT NULL,
  period_end   date NOT NULL CHECK (period_end >= period_start),
  category    text NOT NULL CHECK (category IN (
    'overtime','bonus','commission','reimbursement','deduction','advance','leave_encashment','other'
  )),
  code        text,
  label       text NOT NULL,
  quantity    numeric(12,3),                          -- hours, for overtime
  amount      numeric(14,2),                          -- explicit money, when not derived from quantity
  taxable     boolean NOT NULL DEFAULT true,
  note        text,
  -- Set once the input has been consumed by a run, so a re-calculate does not double-count and the
  -- console can show "3 unprocessed inputs".
  consumed_by_run_id uuid,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (consumed_by_run_id, tenant_id) REFERENCES hr_payroll_runs (id, tenant_id),
  CONSTRAINT ck_hr_payroll_input_value CHECK (quantity IS NOT NULL OR amount IS NOT NULL)
);
CREATE INDEX ix_hr_payroll_inputs_pending
  ON hr_payroll_inputs (tenant_id, period_end, employee_id) WHERE consumed_by_run_id IS NULL;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) hr_separations — the offboarding money-and-compliance record.
--
-- `hr_cases.kind='offboarding'` already holds the CHECKLIST (return the laptop, revoke access).
-- This holds the parts a checklist cannot: the legal ground for the separation, the notice period,
-- and the severance computation — which under Indonesian law (UU 13/2003 as amended by UU 6/2023,
-- Cipta Kerja, and PP 35/2021) is a formula over continuous service and the reason for termination,
-- not a negotiated number.
--
-- The three components are stored SEPARATELY because the statute treats them separately and the
-- multipliers differ per ground: uang pesangon (severance), uang penghargaan masa kerja (long-service
-- reward), and uang penggantian hak (compensation of entitlements, e.g. unused leave).
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_separations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  subject_user_id uuid REFERENCES users(id),
  case_id         uuid REFERENCES hr_cases(id),       -- the offboarding checklist, when opened
  -- The legal ground. Drives the severance multipliers, so it is a constrained set, not free text.
  ground          text NOT NULL CHECK (ground IN (
    'resignation','contract_end','retirement','mutual_agreement','redundancy',
    'efficiency','misconduct','prolonged_illness','death','probation_fail','other'
  )),
  initiated_by    text NOT NULL DEFAULT 'employee' CHECK (initiated_by IN ('employee','employer','mutual','statutory')),
  notice_given_on date,
  notice_days     int CHECK (notice_days IS NULL OR notice_days >= 0),
  last_working_day date,
  effective_on    date NOT NULL,
  -- Continuous service, frozen at calculation. Derived from hr_job_events (hire/rehire/termination),
  -- not from employees.hire_date — a rehired employee's service is not one contiguous span.
  service_years   numeric(6,3) CHECK (service_years IS NULL OR service_years >= 0),
  -- The three statutory components, each stored on its own because the multipliers differ per ground.
  severance_amount      numeric(14,2) CHECK (severance_amount IS NULL OR severance_amount >= 0),
  service_reward_amount numeric(14,2) CHECK (service_reward_amount IS NULL OR service_reward_amount >= 0),
  entitlement_compensation_amount numeric(14,2) CHECK (entitlement_compensation_amount IS NULL OR entitlement_compensation_amount >= 0),
  other_amount    numeric(14,2),
  total_amount    numeric(14,2),
  currency        text NOT NULL DEFAULT 'IDR',
  -- The parameter set the multipliers came from, same freezing discipline as a payroll run.
  parameter_set_id uuid,
  -- The 'final' payroll run that actually pays it.
  final_run_id    uuid,
  -- Exit formalities that are not checklist items.
  exit_interview_on date,
  rehire_eligible boolean,
  status          text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','approved','completed','cancelled')),
  approval_id     uuid,
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  note            text,
  created_by      uuid NOT NULL REFERENCES users(id),
  origin_site     text NOT NULL DEFAULT 'central',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  FOREIGN KEY (parameter_set_id, tenant_id) REFERENCES hr_statutory_parameter_sets (id, tenant_id),
  FOREIGN KEY (final_run_id, tenant_id) REFERENCES hr_payroll_runs (id, tenant_id)
);
-- One LIVE separation per employee. A cancelled one does not block a later, real one.
CREATE UNIQUE INDEX ux_hr_separations_live ON hr_separations (tenant_id, employee_id)
  WHERE status <> 'cancelled' AND deleted_at IS NULL;
CREATE INDEX ix_hr_separations_effective ON hr_separations (tenant_id, effective_on DESC) WHERE deleted_at IS NULL;

COMMENT ON TABLE hr_separations IS
  'The money-and-compliance half of offboarding (hr_cases.kind=offboarding holds the checklist). '
  'The three statutory components are stored separately because UU 13/2003 as amended by UU 6/2023 '
  'and PP 35/2021 applies DIFFERENT multipliers to each per termination ground. service_years is '
  'derived from hr_job_events, never from employees.hire_date (a rehire is not one contiguous span).';
COMMENT ON COLUMN hr_separations.severance_amount IS 'PD/sensitive — compensation. Label only, 0109 posture.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) automation_approvals learns the payroll origins.
--
-- 0028 widened `origin` to include 'hr'. Payroll runs, offers, requisitions and separations all
-- route through that same unified surface — no fork — so nothing needs widening again. This block
-- exists only to state that explicitly, because the absence of a change here is the kind of thing a
-- reader later assumes was an oversight.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the composed third-wall policy (0028 DO-loop shape, byte-identical predicate).
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_statutory_parameter_sets','hr_statutory_parameters','hr_payroll_runs','hr_payslips',
    'hr_payslip_lines','hr_payroll_inputs','hr_separations'
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
