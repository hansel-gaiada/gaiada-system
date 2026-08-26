-- HR — SPLIT RATE BASIS FROM PAY FREQUENCY.
--
-- `hr_compensation.pay_period` was `monthly | annual | hourly | daily`, which conflates two
-- independent facts:
--
--   RATE BASIS    — the unit the amount is QUOTED in (hourly, daily, monthly, annual…)
--   PAY FREQUENCY — how often a payslip is PRODUCED (weekly, biweekly, semi-monthly, monthly…)
--
-- An annual salary paid monthly and an hourly rate paid weekly are both ordinary, and both need two
-- fields. Adding `weekly` to the single column would have entrenched the conflation rather than
-- fixed it — which is exactly what the owner's request ("monthly, weekly, biweekly, daily, hourly")
-- would have produced if taken as one list.
--
-- Confirmed against how the major HRIS platforms model it: Workday keeps `Pay Rate Type` separate
-- from a compensation plan's `Frequency` and VALIDATES one against the other — a validation that
-- can only exist because they are distinct. SAP SuccessFactors makes Frequency a Foundation Object
-- in its own right, carrying an annualisation factor.
--
-- ── DONE NOW BECAUSE THE TABLES ARE EMPTY ──────────────────────────────────────────────────────
-- hr_compensation, hr_payroll_runs, hr_payslips and employees all hold ZERO rows on the live
-- estate. Splitting a column with no data in it is a schema edit; splitting it afterwards is a data
-- migration over people's pay, which is the worst category of migration to get wrong.
--
-- ── WHO OWNS WHICH FIELD ───────────────────────────────────────────────────────────────────────
-- Industry practice (practitioner consensus, not a standard — treat as a default, not a law):
--   HR owns RATE BASIS and the amount. It is a fact about the person's contract.
--   FINANCE owns PAY FREQUENCY. It is an operational cadence tied to the banking and tax calendar,
--   not a property of the employee.
-- The columns live on one row for practical reasons; the authorization split is enforced by the
-- existing hr_payroll / finance Cerbos kinds, not by table layout.

-- ── THREE TABLES, BUT ONLY ONE NEEDS BOTH FIELDS ───────────────────────────────────────────────
-- `pay_period` also sits on `hr_pay_grades` and `hr_offers`. Neither has a cadence: a grade band
-- and an offer QUOTE an amount, and the payslip cadence is set by Finance at hire, not agreed in a
-- salary band. So those two are RENAMED to `rate_basis` and gain no second column.
--
-- Renaming them rather than leaving them is not tidiness. `recruitment.controller.ts` copies an
-- accepted offer's `pay_period` directly into `hr_compensation` at hire; if the same word meant
-- "rate basis" in one table and "rate basis OR frequency" in another, that copy would be the exact
-- place the two meanings silently merged back together.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) The columns
-- ════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE hr_pay_grades RENAME COLUMN pay_period TO rate_basis;
ALTER TABLE hr_offers     RENAME COLUMN pay_period TO rate_basis;

-- The CHECK constraints travel with the rename but still name the old set. Widen both to the same
-- vocabulary `hr_compensation` gets below, so an offer can be quoted weekly and survive the copy
-- into compensation — a narrower offer constraint would reject at HIRE time, which is the worst
-- possible moment to discover a vocabulary mismatch.
ALTER TABLE hr_pay_grades DROP CONSTRAINT IF EXISTS hr_pay_grades_pay_period_check;
ALTER TABLE hr_pay_grades ADD CONSTRAINT hr_pay_grades_rate_basis_check
  CHECK (rate_basis IN ('hourly','daily','weekly','monthly','annual','piece_rate'));
ALTER TABLE hr_offers DROP CONSTRAINT IF EXISTS hr_offers_pay_period_check;
ALTER TABLE hr_offers ADD CONSTRAINT hr_offers_rate_basis_check
  CHECK (rate_basis IN ('hourly','daily','weekly','monthly','annual','piece_rate'));

ALTER TABLE hr_compensation
  ADD COLUMN rate_basis text NOT NULL DEFAULT 'monthly'
    CHECK (rate_basis IN ('hourly','daily','weekly','monthly','annual','piece_rate')),
  -- `four_weekly` is deliberately ABSENT from this estate's vocabulary. A 28-day cycle sits
  -- ambiguously against PP 36/2021 Pasal 55(4) ("not more than 1 (one) month") and the ambiguity is
  -- not worth carrying for a pattern nobody here uses. It can be added with a legal opinion behind
  -- it; it should not arrive by accident.
  ADD COLUMN pay_frequency text NOT NULL DEFAULT 'monthly'
    CHECK (pay_frequency IN ('weekly','biweekly','semi_monthly','monthly'));

-- Carry any existing value across before the old column goes. Zero rows today, written anyway:
-- a migration that only works on an empty table is a migration that fails the first time it meets
-- a real one.
--
-- ⚠ WRAPPED PER TENANT, AND THAT IS NOT OPTIONAL. Migrations run as `platform_owner`, which is
-- NOBYPASSRLS, and `hr_compensation` carries FORCE RLS composed as
-- `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr')`. A bare UPDATE here would
-- match ZERO rows and report success — no error, no warning, and the old column dropped one
-- statement later taking the data with it. Both GUCs are required: the tenant list AND the module
-- scope, because either one unset fails the predicate on its own.
DO $$
DECLARE co record;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    PERFORM set_config('app.scopes', 'hr', true);
    UPDATE hr_compensation
       SET rate_basis = CASE WHEN pay_period IN ('hourly','daily','monthly','annual') THEN pay_period
                             ELSE 'monthly' END
     WHERE tenant_id = co.id;
  END LOOP;
END $$;

ALTER TABLE hr_compensation DROP COLUMN pay_period;

COMMENT ON COLUMN hr_compensation.rate_basis IS
  'The unit the amount is QUOTED in. HR''s field — a fact about the contract.';
COMMENT ON COLUMN hr_compensation.pay_frequency IS
  'How often a payslip is PRODUCED. Finance''s field — an operational cadence tied to the banking '
  'and tax calendar, independent of how the rate is quoted.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) Annualisation — the thing that makes mixed populations comparable
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Without this, an hourly worker and a salaried one cannot be summed, budgeted or compared, and
-- every report that tries invents its own multiplier. One function, so there is one answer.
--
-- The hourly and daily factors encode an ASSUMPTION (2080 hours = 40h x 52w; 260 working days) and
-- that assumption is exactly the kind of thing that differs by contract. It is the default for a
-- full-time equivalent; a contract with different hours must scale via `fte`, not by quietly
-- meaning something else by "hourly".
CREATE OR REPLACE FUNCTION hr_annualisation_factor(p_rate_basis text)
  RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_rate_basis
    WHEN 'hourly'  THEN 2080      -- 40h x 52w, full-time equivalent
    WHEN 'daily'   THEN 260       -- 5d x 52w
    WHEN 'weekly'  THEN 52
    WHEN 'monthly' THEN 12
    WHEN 'annual'  THEN 1
    -- piece_rate cannot be annualised from a rate alone: the annual figure depends on output, which
    -- is not in this row. NULL rather than a guess — a caller must handle it.
    ELSE NULL
  END::numeric;
$$;
COMMENT ON FUNCTION hr_annualisation_factor(text) IS
  'Multiplier from a quoted rate to an annual figure. Returns NULL for piece_rate, which cannot be '
  'annualised from a rate alone — a guess there would be a fabricated salary.';

/** Payslips per year for a frequency. Semi-monthly (24, fixed dates) and biweekly (26, every 14
 *  days) are genuinely different and are the pair most often conflated. */
CREATE OR REPLACE FUNCTION hr_periods_per_year(p_pay_frequency text)
  RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_pay_frequency
    WHEN 'weekly'       THEN 52
    WHEN 'biweekly'     THEN 26
    WHEN 'semi_monthly' THEN 24
    WHEN 'monthly'      THEN 12
  END;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) The jurisdiction rule — PP 36/2021 Pasal 55(4)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ★ Indonesian law permits daily, weekly and monthly wage payment (Pasal 55(3)) but caps the
-- INTERVAL between payments at one month (Pasal 55(4)). That is a rule about the EMPLOYER'S
-- JURISDICTION, not about the enum — a future non-Indonesian entity may legitimately pay
-- four-weekly or monthly-plus.
--
-- So it lives as a per-company rule rather than as a narrower CHECK. Encoding it in the column
-- constraint would make the model unportable and would hide the reason: a reader would see
-- "four_weekly is not allowed" with no way to learn that it is a wage regulation rather than a
-- design preference.
CREATE TABLE hr_payroll_jurisdiction_rules (
  tenant_id             uuid PRIMARY KEY REFERENCES companies(id),
  country_code          text NOT NULL DEFAULT 'ID',
  /** Maximum permitted days between wage payments. NULL = no statutory cap. */
  max_payment_interval_days integer CHECK (max_payment_interval_days IS NULL OR max_payment_interval_days > 0),
  /** Why the cap is what it is. A number with no citation is unauditable, and the person who has
   *  to defend it to a labour inspector is not the person who typed it. */
  basis                 text,
  ratified_by           uuid REFERENCES users(id),
  ratified_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE hr_payroll_jurisdiction_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_payroll_jurisdiction_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hr_payroll_jurisdiction_rules;
CREATE POLICY tenant_isolation ON hr_payroll_jurisdiction_rules FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr'));

CREATE OR REPLACE FUNCTION hr_pay_frequency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_max integer;
  v_days integer;
BEGIN
  SELECT max_payment_interval_days INTO v_max
    FROM hr_payroll_jurisdiction_rules WHERE tenant_id = NEW.tenant_id;
  IF v_max IS NULL THEN
    RETURN NEW;   -- no rule recorded for this company: not this trigger's business to invent one
  END IF;

  v_days := CASE NEW.pay_frequency
    WHEN 'weekly'       THEN 7
    WHEN 'biweekly'     THEN 14
    WHEN 'semi_monthly' THEN 16   -- worst case within a 31-day month
    WHEN 'monthly'      THEN 31
  END;

  IF v_days > v_max THEN
    RAISE EXCEPTION
      'HR_PAY_FREQUENCY_NOT_PERMITTED: % implies up to % days between payments, and this company''s '
      'jurisdiction caps it at %', NEW.pay_frequency, v_days, v_max
      USING HINT = 'See hr_payroll_jurisdiction_rules.basis for the rule this company is held to.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_hr_pay_frequency_guard
  BEFORE INSERT OR UPDATE ON hr_compensation
  FOR EACH ROW EXECUTE FUNCTION hr_pay_frequency_guard();

COMMENT ON TABLE hr_payroll_jurisdiction_rules IS
  'Per-company statutory limits on payroll cadence. Indonesia: PP 36/2021 Pasal 55(4) caps the '
  'interval between wage payments at one month, while Pasal 55(3) expressly permits daily, weekly '
  'and monthly. Kept as DATA rather than a column CHECK so the model stays portable and the reason '
  'stays visible — and so a rate that changes by regulation can be re-ratified rather than '
  'redeployed.';
