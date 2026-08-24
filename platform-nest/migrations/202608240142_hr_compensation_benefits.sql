-- HR wave C — COMPENSATION AND BENEFITS. The data layer the payroll engine (wave D) reads.
--
-- Nothing in the platform models what anyone is paid. `hr_offers.base_amount` (wave B) records what
-- was OFFERED, which stops being true at the first raise. This migration adds the standing facts:
-- the grade structure, the effective-dated compensation record, recurring allowances/deductions,
-- and statutory + voluntary benefit enrolment.
--
-- ── The one rule that governs this whole file: COMPENSATION IS EFFECTIVE-DATED, NEVER OVERWRITTEN ─
-- A salary column on `employees` would be the obvious shortcut and it breaks three things at once:
-- payroll for a past period can no longer be recomputed or audited, a mid-month raise cannot be
-- pro-rated, and severance (which depends on the wage at termination and sometimes on an average of
-- prior months) becomes guesswork. Every money fact here therefore carries `effective_from` /
-- `effective_to` and is closed rather than edited. Wave D's payroll engine resolves "the comp in
-- force on date D" by range, and that is the only way it ever reads these tables.
--
-- ── Indonesian statutory framing (the facts this schema must be able to hold) ────────────────────
-- The group operates in Indonesia, so the benefit tables are shaped by what BPJS actually requires:
--   * BPJS Kesehatan (health)        — employer 4% / employee 1% of a CAPPED wage
--   * BPJS Ketenagakerjaan (labour)  — four separate programs (JHT, JP, JKK, JKM) with DIFFERENT
--                                      rates, different caps, and different employer/employee splits;
--                                      JKK's rate depends on the employer's industry risk class
--   * JKP (job-loss)                 — employer + government funded, not deducted from the employee
-- Modelling these as one "BPJS" flag would make every one of those distinctions unrepresentable.
-- So a benefit PLAN carries its own rates and caps as DATA, and the rates themselves live in wave
-- D's statutory-parameter table where they are effective-dated (they change by regulation, roughly
-- annually) rather than compiled into code.
--
-- MODULE THIRD WALL: byte-identical 0028 predicate on every table. Additive; no DML.
-- PII posture: label-only PD comments (0109 owner decision, 2026-08-13). Compensation is the most
-- sensitive tier in the module and authorizes as the new `hr_payroll` Cerbos kind, not `hr_record`.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) hr_pay_grades — the structure compensation is checked against.
--
-- Optional by design: a company can run compensation with no grades at all (hr_compensation.grade_id
-- is nullable). Where grades DO exist they give the offer and raise flows a range to validate
-- against, which is the only thing that makes "is this offer in band" answerable.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_pay_grades (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  code        text NOT NULL,                          -- 'E3', 'M2'
  name        text NOT NULL,
  -- The career track this grade sits on. Two tracks at the same level is normal (a senior engineer
  -- and a manager are peers in pay, not in ladder), and a single ordinal cannot express that.
  track       text NOT NULL DEFAULT 'individual'
    CHECK (track IN ('individual','management','executive','support')),
  level       int NOT NULL DEFAULT 1 CHECK (level >= 1),
  min_amount  numeric(14,2) NOT NULL CHECK (min_amount >= 0),
  mid_amount  numeric(14,2) CHECK (mid_amount IS NULL OR mid_amount >= 0),
  max_amount  numeric(14,2) NOT NULL CHECK (max_amount >= 0),
  currency    text NOT NULL DEFAULT 'IDR',
  pay_period  text NOT NULL DEFAULT 'monthly' CHECK (pay_period IN ('monthly','annual','hourly','daily')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT ck_hr_pay_grade_band CHECK (max_amount >= min_amount
    AND (mid_amount IS NULL OR (mid_amount >= min_amount AND mid_amount <= max_amount))),
  CONSTRAINT ux_hr_pay_grades_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX ux_hr_pay_grades_code ON hr_pay_grades (tenant_id, code) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) hr_compensation — the effective-dated base pay record.
--
-- One row per compensation FACT, not per employee. A raise closes the old row (effective_to) and
-- opens a new one in the same transaction. The GiST EXCLUDE constraint below is what enforces that
-- discipline in the database rather than in the handler's good intentions: two overlapping open
-- compensation rows for the same employee are structurally impossible, so payroll can never find
-- two answers to "what were they paid on the 15th".
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_compensation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  subject_user_id uuid REFERENCES users(id),          -- denormalized for the self-read path
  grade_id        uuid,
  base_amount     numeric(14,2) NOT NULL CHECK (base_amount >= 0),
  currency        text NOT NULL DEFAULT 'IDR',
  pay_period      text NOT NULL DEFAULT 'monthly' CHECK (pay_period IN ('monthly','annual','hourly','daily')),
  -- Full-time equivalent. 0.5 for a half-timer. Payroll multiplies by this; keeping it here rather
  -- than on `employees` means a temporary part-time arrangement is an effective-dated fact like any
  -- other, and reverts by closing the row.
  fte             numeric(4,3) NOT NULL DEFAULT 1.000 CHECK (fte > 0 AND fte <= 2),
  effective_from  date NOT NULL,
  effective_to    date,                               -- NULL = currently in force
  change_reason   text CHECK (change_reason IS NULL OR change_reason IN (
    'hire','annual_review','promotion','market_adjustment','demotion','correction','contract_renewal','other'
  )),
  -- The lifecycle event that produced this row, when there was one. Keeps the money record and the
  -- job history from telling different stories about the same promotion.
  job_event_id    uuid REFERENCES hr_job_events(id),
  approval_id     uuid,                               -- automation_approvals (origin='hr')
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  note            text,
  created_by      uuid REFERENCES users(id),
  origin_site     text NOT NULL DEFAULT 'central',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (grade_id, tenant_id) REFERENCES hr_pay_grades (id, tenant_id),
  CONSTRAINT ck_hr_compensation_range CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ux_hr_compensation_id_tenant UNIQUE (id, tenant_id)
);
-- btree_gist is already installed (0055, restated by 0109); restating is idempotent and cheap.
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- NO TWO OVERLAPPING COMPENSATION PERIODS FOR ONE EMPLOYEE. daterange with '[]' bounds and a NULL
-- upper meaning "open-ended" — exactly the 0063/0109 assignee-interval pattern. This is the
-- constraint that makes payroll's point-in-time lookup provably single-valued.
ALTER TABLE hr_compensation ADD CONSTRAINT ex_hr_compensation_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
CREATE INDEX ix_hr_compensation_employee ON hr_compensation (tenant_id, employee_id, effective_from DESC);
CREATE INDEX ix_hr_compensation_current ON hr_compensation (tenant_id, employee_id) WHERE effective_to IS NULL;

COMMENT ON TABLE hr_compensation IS
  'Effective-dated base pay. NEVER updated in place — a raise CLOSES the prior row and opens a new '
  'one in the same transaction. ex_hr_compensation_no_overlap makes two simultaneous answers '
  'structurally impossible, which is what lets payroll recompute any past period exactly.';
COMMENT ON COLUMN hr_compensation.base_amount IS 'PD/sensitive — compensation. Label only, 0109 posture.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) hr_allowance_types / hr_employee_allowances — recurring pay components beyond base.
--
-- Split into a TYPE (the company's catalog: transport, meal, housing, phone) and an ASSIGNMENT
-- (this employee gets this one, at this amount, for this period). Without the type table, every
-- allowance is a free-text string and payroll cannot know whether "Transport" and "transport
-- allowance" are taxable, or the same thing.
--
-- `taxable` and `bpjs_base` are separate flags on purpose: Indonesian practice is that some
-- components count toward income tax but NOT toward the BPJS contribution base, and vice versa.
-- One "included" boolean cannot express that, and getting it wrong is a statutory error, not a
-- rounding one.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_allowance_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  code        text NOT NULL,                          -- 'transport', 'meal', 'position'
  label       text NOT NULL,
  -- 'allowance' adds to pay; 'deduction' subtracts. One table because they share every other
  -- property and payroll treats them as signed components of the same sum.
  direction   text NOT NULL DEFAULT 'allowance' CHECK (direction IN ('allowance','deduction')),
  -- 'fixed'      — a flat amount
  -- 'percentage' — a percentage of base pay
  -- 'formula'    — computed by the engine (attendance-linked meal allowance, e.g.)
  calc_kind   text NOT NULL DEFAULT 'fixed' CHECK (calc_kind IN ('fixed','percentage','formula')),
  default_amount  numeric(14,2) CHECK (default_amount IS NULL OR default_amount >= 0),
  default_percent numeric(6,3) CHECK (default_percent IS NULL OR (default_percent >= 0 AND default_percent <= 100)),
  taxable     boolean NOT NULL DEFAULT true,          -- enters the PPh 21 gross
  bpjs_base   boolean NOT NULL DEFAULT false,         -- enters the BPJS contribution base
  -- Whether this component is prorated when the employee works part of the period.
  prorated    boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT ux_hr_allowance_types_id_tenant UNIQUE (id, tenant_id)
);

CREATE TABLE hr_employee_allowances (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  employee_id    uuid NOT NULL REFERENCES employees(id),
  allowance_type_id uuid NOT NULL,
  amount         numeric(14,2) CHECK (amount IS NULL OR amount >= 0),
  percent        numeric(6,3) CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100)),
  effective_from date NOT NULL,
  effective_to   date,
  note           text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (allowance_type_id, tenant_id) REFERENCES hr_allowance_types (id, tenant_id),
  CONSTRAINT ck_hr_emp_allowance_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
-- Same non-overlap discipline as compensation, scoped per allowance type: an employee cannot hold
-- two simultaneous transport allowances.
ALTER TABLE hr_employee_allowances ADD CONSTRAINT ex_hr_employee_allowances_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    allowance_type_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
CREATE INDEX ix_hr_employee_allowances_emp ON hr_employee_allowances (tenant_id, employee_id, effective_from DESC);

COMMENT ON COLUMN hr_allowance_types.taxable IS
  'Enters the PPh 21 gross. Deliberately INDEPENDENT of bpjs_base — Indonesian practice treats the '
  'two bases differently per component, and collapsing them into one flag is a statutory error.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) hr_benefit_plans / hr_benefit_enrollments — statutory and voluntary benefits.
--
-- A plan carries its own rate/cap shape so BPJS's four labour programs, BPJS health, and a private
-- insurance scheme are all representable without a schema change per scheme. `statutory_code` is
-- what lets the payroll engine recognize the ones it must compute by regulation rather than by the
-- plan's own numbers.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_benefit_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  code          text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'statutory'
    CHECK (kind IN ('statutory','insurance','pension','wellness','allowance_in_kind','other')),
  -- The regulatory identity, when there is one. The payroll engine switches on THIS, never on the
  -- free-text code — so a tenant renaming their plan cannot break statutory computation.
  --   bpjs_kesehatan | bpjs_jht (old-age) | bpjs_jp (pension) | bpjs_jkk (accident)
  --   bpjs_jkm (death) | bpjs_jkp (job-loss)
  statutory_code text CHECK (statutory_code IS NULL OR statutory_code IN (
    'bpjs_kesehatan','bpjs_jht','bpjs_jp','bpjs_jkk','bpjs_jkm','bpjs_jkp'
  )),
  provider      text,
  -- Plan-level rates. For statutory plans these are a MIRROR of the effective-dated parameters in
  -- hr_statutory_parameters (wave D) kept for display; the engine reads the parameter table, which
  -- is versioned by date, and never these. Recorded here so the console can show a plan sheet
  -- without joining the parameter history.
  employer_rate numeric(6,4) CHECK (employer_rate IS NULL OR (employer_rate >= 0 AND employer_rate <= 1)),
  employee_rate numeric(6,4) CHECK (employee_rate IS NULL OR (employee_rate >= 0 AND employee_rate <= 1)),
  -- Wage ceiling the rate applies to. BPJS Kesehatan and JP each have one, and they DIFFER.
  wage_cap      numeric(14,2) CHECK (wage_cap IS NULL OR wage_cap >= 0),
  wage_floor    numeric(14,2) CHECK (wage_floor IS NULL OR wage_floor >= 0),
  currency      text NOT NULL DEFAULT 'IDR',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT ux_hr_benefit_plans_id_tenant UNIQUE (id, tenant_id)
);

CREATE TABLE hr_benefit_enrollments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  employee_id    uuid NOT NULL REFERENCES employees(id),
  plan_id        uuid NOT NULL,
  -- The membership number with the provider (BPJS participant number). PD.
  member_number  text,
  -- Dependants covered, for schemes that price by family size (BPJS Kesehatan covers up to 5).
  dependants     int NOT NULL DEFAULT 0 CHECK (dependants >= 0),
  status         text NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending','active','suspended','terminated')),
  effective_from date NOT NULL,
  effective_to   date,
  note           text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, tenant_id) REFERENCES hr_benefit_plans (id, tenant_id),
  CONSTRAINT ck_hr_benefit_enrol_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE hr_benefit_enrollments ADD CONSTRAINT ex_hr_benefit_enrollments_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    plan_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
CREATE INDEX ix_hr_benefit_enrol_emp ON hr_benefit_enrollments (tenant_id, employee_id, status);

COMMENT ON COLUMN hr_benefit_plans.statutory_code IS
  'The regulatory identity the payroll engine switches on. NULL for voluntary plans. The engine '
  'reads RATES from hr_statutory_parameters (effective-dated), never from this table — these '
  'columns are the display mirror.';
COMMENT ON COLUMN hr_benefit_enrollments.member_number IS 'PD — participant number. Label only, 0109 posture.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) hr_tax_profiles — the per-employee facts PPh 21 needs.
--
-- Effective-dated for the same reason compensation is: PTKP status changes when someone marries or
-- has a child, and a recomputation of last March must use last March's status.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_tax_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  employee_id    uuid NOT NULL REFERENCES employees(id),
  -- NPWP (taxpayer number). Its ABSENCE is significant, not cosmetic: an employee without one is
  -- withheld at a higher rate by regulation, so the engine must be able to see the difference
  -- between "no NPWP" and "not recorded yet".
  npwp           text,
  has_npwp       boolean NOT NULL DEFAULT false,
  -- PTKP (non-taxable income) status: TK/0..TK/3, K/0..K/3, K/I/0..K/I/3. Held as a code because
  -- that is how the regulation expresses it and how the parameter table is keyed.
  ptkp_status    text NOT NULL DEFAULT 'TK/0'
    CHECK (ptkp_status IN ('TK/0','TK/1','TK/2','TK/3','K/0','K/1','K/2','K/3','K/I/0','K/I/1','K/I/2','K/I/3')),
  -- The TER (Tarif Efektif Rata-Rata) category the monthly withholding uses. Derived from PTKP
  -- status, but STORED because the derivation is itself a regulated mapping that can change.
  ter_category   text CHECK (ter_category IS NULL OR ter_category IN ('A','B','C')),
  -- Residency drives which regime applies at all (non-residents are withheld under a different
  -- article entirely).
  tax_resident   boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL,
  effective_to   date,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_hr_tax_profile_range CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_hr_tax_profile_npwp CHECK (NOT has_npwp OR npwp IS NOT NULL)
);
ALTER TABLE hr_tax_profiles ADD CONSTRAINT ex_hr_tax_profiles_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
CREATE INDEX ix_hr_tax_profiles_emp ON hr_tax_profiles (tenant_id, employee_id, effective_from DESC);

COMMENT ON COLUMN hr_tax_profiles.npwp IS
  'PD — national taxpayer number. Label only per the 0109 posture, BUT note the program-wide rule '
  'that national IDs are scrubbed before persist: NPWP is a TAX number, not a national identity '
  'number (NIK), and NIK is deliberately absent from this schema. Do not add it here.';
COMMENT ON COLUMN hr_tax_profiles.ter_category IS
  'Derived from ptkp_status by a REGULATED mapping (PP 58/2023). Stored rather than computed so a '
  'change to that mapping does not retroactively rewrite a past payroll run.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the composed third-wall policy (0028 DO-loop shape, byte-identical predicate).
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_pay_grades','hr_compensation','hr_allowance_types','hr_employee_allowances',
    'hr_benefit_plans','hr_benefit_enrollments','hr_tax_profiles'
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
