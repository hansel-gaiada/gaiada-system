-- 0081_hr_loans.sql — EMPLOYEE LOANS (employee-portal wave E).
--
-- An employee requests a loan; a human decides it on the EXISTING unified approvals surface
-- (automation_approvals, origin='hr' — the same path 0028's leave requests use, no fork); on
-- approval an amortization schedule is materialized and repayments accrue against it.
--
-- Three tables, and the split is deliberate:
--   hr_loan_requests      the agreement    (one row, the thing that is approved)
--   hr_loan_installments  what is OWED     (materialized once at approval — see below)
--   hr_loan_repayments    what was PAID    (append-only ledger)
--
-- Why installments are MATERIALIZED rather than recomputed on read: the schedule is the contract.
-- Recomputing it from (principal, rate, term) on every read means a later change to the rounding
-- rule silently rewrites what an employee already agreed to owe. Freezing the rows at approval
-- makes the schedule auditable and lets a future amendment be an explicit new revision.
--
-- Why repayments are a LEDGER and not a `paid` flag per installment: allocation (which installment
-- a payment settles) is a policy that changes — FIFO today, oldest-interest-first later. Storing
-- money once and deriving allocation in a pure, tested function (src/modules/hr/loan-schedule.ts)
-- keeps the two concerns separable and makes the arithmetic testable without a database.
--
-- MODULE THIRD WALL: every table below carries the byte-identical composed predicate from 0028
--   `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr')`
-- so a caller that reaches these tables WITHOUT `withTenants(..., { modules: ["hr"] })` reads and
-- writes ZERO rows and gets no error. That is the intended in-DB behaviour, and it is also the
-- single easiest way to write a silently-broken feature against this schema.

-- ══ (1) hr_loan_requests — the agreement.
CREATE TABLE hr_loan_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  principal_amount numeric(14,2) NOT NULL CHECK (principal_amount > 0),
  currency text NOT NULL DEFAULT 'IDR',
  term_months int NOT NULL CHECK (term_months BETWEEN 1 AND 120),
  -- Nominal ANNUAL rate as a percentage (0 = interest-free, which is the common staff-loan case
  -- and the reason the schedule generator has a dedicated zero-rate branch rather than dividing
  -- by a rate that is 0).
  annual_interest_rate numeric(6,3) NOT NULL DEFAULT 0
    CHECK (annual_interest_rate >= 0 AND annual_interest_rate <= 100),
  purpose text,
  -- 'approved' is the ACTIVE/repaying state; 'settled' is reached when the ledger covers the
  -- schedule (no separate 'repaying' state — it would be a second name for 'approved' and the two
  -- would drift). 'denied'/'cancelled' are terminal.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','cancelled','settled')),
  approval_id uuid,                                    -- automation_approvals row (origin='hr')
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  -- Set at approval, alongside the installment rows, so the header can be read without summing
  -- the schedule. Kept consistent by being written in the SAME transaction that inserts them.
  first_due_on date,
  total_payable numeric(14,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_hr_loan_subject ON hr_loan_requests(tenant_id, subject_user_id, created_at DESC);
-- Target of the tenant-scoped composite FKs below (the 0027 pattern): a child row cannot point at
-- a parent in a DIFFERENT tenant, because the FK carries tenant_id and must match this key.
CREATE UNIQUE INDEX ux_hr_loan_requests_id_tenant ON hr_loan_requests(id, tenant_id);

-- ══ (2) hr_loan_installments — the frozen amortization schedule (what is owed, and when).
CREATE TABLE hr_loan_installments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  loan_request_id uuid NOT NULL,
  seq int NOT NULL CHECK (seq >= 1),
  due_on date NOT NULL,
  principal_due numeric(14,2) NOT NULL CHECK (principal_due >= 0),
  interest_due numeric(14,2) NOT NULL CHECK (interest_due >= 0),
  total_due numeric(14,2) NOT NULL CHECK (total_due > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (loan_request_id, tenant_id) REFERENCES hr_loan_requests(id, tenant_id),
  UNIQUE (tenant_id, loan_request_id, seq)
);
CREATE INDEX ix_hr_loan_installments_loan ON hr_loan_installments(tenant_id, loan_request_id, seq);

-- ══ (3) hr_loan_repayments — append-only money ledger.
CREATE TABLE hr_loan_repayments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  loan_request_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_on date NOT NULL,
  -- 'payroll_deduction' is the DEFERRED SEAM: employee-portal wave D (payroll) is not built, so
  -- nothing creates these rows automatically yet. Recording one by hand today is a legitimate
  -- manual entry, and when payroll lands it becomes the automated writer of exactly this row —
  -- the ledger shape does not have to change for that to happen.
  method text NOT NULL DEFAULT 'transfer'
    CHECK (method IN ('payroll_deduction','transfer','cash','other')),
  note text,
  -- The employee may REQUEST a loan but must never be able to declare it repaid: the controller
  -- authorizes this write as hr_case:update, which the `member` derived role does not hold.
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (loan_request_id, tenant_id) REFERENCES hr_loan_requests(id, tenant_id)
);
CREATE INDEX ix_hr_loan_repayments_loan ON hr_loan_repayments(tenant_id, loan_request_id, paid_on);

-- ══ FORCE RLS + the composed third-wall policy, in the same DO-loop shape as 0028 so the predicate
--    is byte-identical across all nine hr_* tables and cannot drift per-table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_loan_requests','hr_loan_installments','hr_loan_repayments'
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

COMMENT ON TABLE hr_loan_requests IS
  'Employee loan agreement. Approved via automation_approvals (origin=hr); schedule frozen at approval.';
COMMENT ON TABLE hr_loan_installments IS
  'Frozen amortization schedule for a loan (what is owed). Written once, in the approval transaction.';
COMMENT ON TABLE hr_loan_repayments IS
  'Append-only repayment ledger. Allocation to installments is derived, not stored (see loan-schedule.ts).';
