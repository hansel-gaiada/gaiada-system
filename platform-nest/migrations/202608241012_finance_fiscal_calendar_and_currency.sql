-- Finance F0-05/F0-06 — FISCAL CALENDAR (with the lock state machine) AND CURRENCY.
--
-- Third and last structural F0 migration. Together with 202608241010 (ownership/scope) and
-- 202608241011 (CoA/dimensions) this completes the vocabulary F1's ledger will post into.
--
-- ── WHY THE PERIOD LOCK IS A DATABASE STATE MACHINE AND NOT A FLAG ───────────────────────────────
-- Blueprint section 3.2: "No posting into a hard-locked period, ever, by anyone, including an
-- admin." A boolean `is_locked` cannot express that, because a boolean can be flipped back and
-- nothing records that it was. The three states are the accounting reality:
--
--   OPEN       normal posting
--   SOFT_LOCK  closed to ordinary posting; adjustments still possible under authority. The state
--              a period sits in during close, while recs and accruals are finalised.
--   HARD_LOCK  TERMINAL. Signed, filed, audited. Nothing may post, and the period may not reopen.
--
-- HARD_LOCK being terminal is a deliberate divergence from project-hug, which shipped a
-- `POST fiscal-periods/:id/reopen`. A reopenable hard lock is not a lock; it is a speed bump with
-- an audit-log entry. If a figure in a filed period turns out wrong, the accounting answer is a
-- correcting entry in an OPEN period — never a rewrite of a period someone has already signed.
--
-- ── THE ACCOUNTANT SIGN-OFF GATE (owner ruling D-F5) ─────────────────────────────────────────────
-- We are building the books before the accountant is hired. That is fine for OPEN and SOFT_LOCK —
-- but a HARD_LOCK asserts "these figures are final", and nobody in the building today has the
-- standing to assert that. So `signed_off_by` + `signed_off_at` are REQUIRED for HARD_LOCK, and the
-- trigger refuses the transition without them. The ruling is enforced by the schema rather than
-- remembered by a process.
--
-- Additive. No existing table is touched.

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- already installed by 0055; idempotent no-op here

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_currencies — GLOBAL reference data (ISO 4217). No tenant, same reasoning as the CoA
--     templates: a currency belongs to nobody and carries no company's figures.
--
-- `minor_unit` matters and is not decoration: IDR is conventionally handled with 0 decimals, USD
-- with 2, and rounding a journal to the wrong precision is a real imbalance. Amount columns
-- throughout finance are `numeric` and store what they are given; this column tells presentation
-- and rounding what the currency's convention is.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_currencies (
  code       text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name       text NOT NULL,
  symbol     text,
  minor_unit smallint NOT NULL DEFAULT 2 CHECK (minor_unit BETWEEN 0 AND 4),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO finance_currencies (code, name, symbol, minor_unit) VALUES
  ('IDR','Indonesian Rupiah','Rp',0),
  ('USD','US Dollar','$',2),
  ('SGD','Singapore Dollar','S$',2),
  ('AUD','Australian Dollar','A$',2),
  ('EUR','Euro','€',2),
  ('JPY','Japanese Yen','¥',0),
  ('GBP','Pound Sterling','£',2),
  ('MYR','Malaysian Ringgit','RM',2),
  ('CNY','Chinese Yuan','¥',2);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_company_settings — one row per company. The accounting basis everything else reads.
--
-- Functional vs presentation currency is not pedantry (blueprint section 3.5): the FUNCTIONAL
-- currency is the one the company actually operates in and whose amounts the ledger stores as base;
-- the PRESENTATION currency is what a statement is expressed in. They are usually the same and
-- occasionally are not, and a group total that mixes them without saying so is unreproducible
-- (section 10.3a).
--
-- `fiscal_year_start_month` exists because a fiscal year is not always the calendar year. Indonesian
-- companies commonly use January, but the group may acquire one that does not.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_company_settings (
  tenant_id               uuid PRIMARY KEY REFERENCES companies(id),
  functional_currency     text NOT NULL REFERENCES finance_currencies(code),
  presentation_currency   text NOT NULL REFERENCES finance_currencies(code),
  fiscal_year_start_month smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  -- PKP status drives whether PPN applies at all (blueprint section 3.6). NULL = not yet known,
  -- which is the honest state until open question Q4 is answered; it is not the same as 'false'.
  is_pkp                  boolean,
  npwp                    text,
  -- Which CoA template this company was instantiated from, for later diffing against the standard.
  coa_template_key        text,
  origin_site             text NOT NULL DEFAULT 'central',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN finance_company_settings.is_pkp IS
  'NULL = unknown (open question Q4), which is NOT the same as false. A false here asserts the '
  'company is not VAT-registered; do not let an unanswered question become that assertion.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_exchange_rates — tenanted, because a rate USED is part of a company's books.
--
-- Auditors test the rate applied to a revaluation, so it must be stored with what it was, where it
-- came from, and on what basis — not recomputed later from a market feed that has since moved.
--
-- `basis` is the column most systems omit and then cannot reproduce a statement: IFRS/PSAK
-- translation uses the CLOSING rate for balance-sheet items and the AVERAGE rate for P&L items.
-- One rate per (currency pair, date) is therefore wrong by construction.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_exchange_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  from_currency text NOT NULL REFERENCES finance_currencies(code),
  to_currency   text NOT NULL REFERENCES finance_currencies(code),
  rate_date     date NOT NULL,
  basis         text NOT NULL CHECK (basis IN ('spot','closing','average')),
  -- numeric(20,10): a rate is not money and needs the precision. IDR/USD alone spans five orders
  -- of magnitude from the reciprocal direction.
  rate          numeric(20,10) NOT NULL CHECK (rate > 0),
  source        text NOT NULL DEFAULT 'manual',
  note          text,
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  CONSTRAINT ck_finance_exchange_rates_pair CHECK (from_currency <> to_currency),
  CONSTRAINT ux_finance_exchange_rates_key UNIQUE (tenant_id, from_currency, to_currency, rate_date, basis)
);
CREATE INDEX ix_finance_exchange_rates_lookup
  ON finance_exchange_rates (tenant_id, from_currency, to_currency, basis, rate_date DESC);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_fiscal_years / finance_fiscal_periods.
--
-- Periods within a year may not overlap. Enforced with a btree_gist EXCLUDE over a daterange —
-- the 0055/0063 pattern — rather than by application code, because an overlap means a transaction
-- belongs to two periods at once and every subsequent total is ambiguous. `[)` bounds: a period
-- ends the instant the next begins, with no shared day.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_fiscal_years (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  code        text NOT NULL,                       -- 'FY2026'
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  origin_site text NOT NULL DEFAULT 'central',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_finance_fiscal_years_range CHECK (end_date > start_date),
  CONSTRAINT ux_finance_fiscal_years_code UNIQUE (tenant_id, code),
  CONSTRAINT ux_finance_fiscal_years_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ex_finance_fiscal_years_no_overlap
    EXCLUDE USING gist (tenant_id WITH =, daterange(start_date, end_date, '[)') WITH &&)
);

CREATE TABLE finance_fiscal_periods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  fiscal_year_id uuid NOT NULL,
  period_no      smallint NOT NULL CHECK (period_no BETWEEN 1 AND 13),  -- 13 = adjustment period
  name           text NOT NULL,
  start_date     date NOT NULL,
  end_date       date NOT NULL,

  state          text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','SOFT_LOCK','HARD_LOCK')),
  soft_locked_at timestamptz,
  soft_locked_by uuid REFERENCES users(id),
  hard_locked_at timestamptz,
  hard_locked_by uuid REFERENCES users(id),

  -- The D-F5 gate. A HARD_LOCK without a named human who signed the numbers is refused.
  signed_off_by  uuid REFERENCES users(id),
  signed_off_at  timestamptz,

  -- The close checklist (blueprint section 3.2). jsonb rather than a table because the checklist is
  -- a per-close artefact read as a whole, never queried item-by-item across periods.
  close_checklist jsonb NOT NULL DEFAULT '{}',

  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_finance_fiscal_periods_range CHECK (end_date >= start_date),
  CONSTRAINT fk_finance_fiscal_periods_year
    FOREIGN KEY (fiscal_year_id, tenant_id) REFERENCES finance_fiscal_years (id, tenant_id),
  CONSTRAINT ux_finance_fiscal_periods_no UNIQUE (fiscal_year_id, period_no),
  CONSTRAINT ux_finance_fiscal_periods_id_tenant UNIQUE (id, tenant_id),
  -- Sign-off is a pair or neither; half of it is a half-truth.
  CONSTRAINT ck_finance_fiscal_periods_signoff CHECK (
    num_nonnulls(signed_off_by, signed_off_at) <> 1
  ),
  CONSTRAINT ex_finance_fiscal_periods_no_overlap
    EXCLUDE USING gist (fiscal_year_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);
CREATE INDEX ix_finance_fiscal_periods_lookup
  ON finance_fiscal_periods (tenant_id, start_date, end_date);
CREATE INDEX ix_finance_fiscal_periods_state
  ON finance_fiscal_periods (tenant_id, state);

COMMENT ON COLUMN finance_fiscal_periods.state IS
  'OPEN -> SOFT_LOCK -> HARD_LOCK. HARD_LOCK is TERMINAL: no posting, no reopen. A wrong figure in '
  'a filed period is fixed by a correcting entry in an open period, never by rewriting the period.';
COMMENT ON COLUMN finance_fiscal_periods.signed_off_by IS
  'Owner ruling D-F5: HARD_LOCK requires a named human who signed the figures. Enforced by trigger, '
  'not by process — we are building the books before the accountant is hired.';

-- ── The state-machine trigger ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION finance_fiscal_period_transition()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    -- HARD_LOCK is terminal, in every direction, for everyone.
    IF OLD.state = 'HARD_LOCK' THEN
      RAISE EXCEPTION 'FINANCE_PERIOD_HARD_LOCKED: period % is hard-locked and cannot change state', OLD.name
        USING HINT = 'Post a correcting entry in an open period. A filed period is never reopened.';
    END IF;

    IF OLD.state = 'OPEN' AND NEW.state = 'HARD_LOCK' THEN
      RAISE EXCEPTION 'FINANCE_PERIOD_TRANSITION: % must pass through SOFT_LOCK before HARD_LOCK', OLD.name
        USING HINT = 'Soft-lock first, finish the close checklist, then hard-lock.';
    END IF;

    IF NEW.state = 'HARD_LOCK' THEN
      IF NEW.signed_off_by IS NULL OR NEW.signed_off_at IS NULL THEN
        RAISE EXCEPTION 'FINANCE_PERIOD_UNSIGNED: % cannot be hard-locked without an accountant sign-off', OLD.name
          USING HINT = 'Owner ruling D-F5: set signed_off_by/signed_off_at. Nobody may assert final figures anonymously.';
      END IF;
      NEW.hard_locked_at := COALESCE(NEW.hard_locked_at, now());
    END IF;

    IF NEW.state = 'SOFT_LOCK' THEN
      NEW.soft_locked_at := COALESCE(NEW.soft_locked_at, now());
    END IF;

    -- SOFT_LOCK -> OPEN is a legitimate reopen (the close found something). Clear the stamps so the
    -- record does not claim a lock that is no longer in force.
    IF OLD.state = 'SOFT_LOCK' AND NEW.state = 'OPEN' THEN
      NEW.soft_locked_at := NULL;
      NEW.soft_locked_by := NULL;
    END IF;
  END IF;

  -- Dates are the period's identity once it is locked in any way.
  IF OLD.state <> 'OPEN' AND (NEW.start_date, NEW.end_date) IS DISTINCT FROM (OLD.start_date, OLD.end_date) THEN
    RAISE EXCEPTION 'FINANCE_PERIOD_LOCKED: % is locked; its dates cannot move', OLD.name;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_finance_fiscal_period_transition
  BEFORE UPDATE ON finance_fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION finance_fiscal_period_transition();

-- ── finance_period_accepts_posting(company, date) — the guard F1 will call before every post ─────
-- Returns TRUE only for a date inside an OPEN period of that company. A date with NO period is
-- FALSE, not TRUE: an unmapped date is an unconfigured calendar, and defaulting it to postable is
-- how transactions land outside every period and vanish from every report.
CREATE OR REPLACE FUNCTION finance_period_accepts_posting(p_company uuid, p_date date)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1 FROM finance_fiscal_periods p
     WHERE p.tenant_id = p_company
       AND p_date BETWEEN p.start_date AND p.end_date
       AND p.state = 'OPEN'
  )
$$;
COMMENT ON FUNCTION finance_period_accepts_posting(uuid, date) IS
  'F1 posting guard. FALSE for soft/hard-locked periods AND for a date with no period at all — an '
  'unconfigured calendar must not silently accept postings that no report will ever include.';
GRANT EXECUTE ON FUNCTION finance_period_accepts_posting(uuid, date) TO PUBLIC;

-- ── finance_generate_periods(year, monthly|quarterly) — calendar builder ─────────────────────────
CREATE OR REPLACE FUNCTION finance_generate_periods(p_fiscal_year uuid, p_grain text DEFAULT 'monthly')
  RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_fy       finance_fiscal_years%ROWTYPE;
  v_step     interval;
  v_cursor   date;
  v_end      date;
  v_no       smallint := 1;
  v_created  integer := 0;
BEGIN
  SELECT * INTO v_fy FROM finance_fiscal_years WHERE id = p_fiscal_year;
  IF v_fy.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_FY_UNKNOWN: no fiscal year %', p_fiscal_year;
  END IF;
  IF EXISTS (SELECT 1 FROM finance_fiscal_periods WHERE fiscal_year_id = p_fiscal_year) THEN
    RETURN 0;   -- idempotent: never re-cut a calendar that already has periods
  END IF;

  v_step := CASE p_grain WHEN 'monthly' THEN interval '1 month'
                         WHEN 'quarterly' THEN interval '3 months'
                         ELSE NULL END;
  IF v_step IS NULL THEN
    RAISE EXCEPTION 'FINANCE_GRAIN_UNKNOWN: % (expected monthly|quarterly)', p_grain;
  END IF;

  v_cursor := v_fy.start_date;
  WHILE v_cursor < v_fy.end_date LOOP
    v_end := LEAST((v_cursor + v_step - interval '1 day')::date, (v_fy.end_date - interval '1 day')::date);
    INSERT INTO finance_fiscal_periods (tenant_id, fiscal_year_id, period_no, name, start_date, end_date)
    VALUES (v_fy.tenant_id, v_fy.id, v_no, to_char(v_cursor, 'Mon YYYY'), v_cursor, v_end);
    v_created := v_created + 1;
    v_no := v_no + 1;
    v_cursor := (v_cursor + v_step)::date;
  END LOOP;
  RETURN v_created;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) The finance third wall — the same shape, applied to the tenanted tables only.
--     finance_currencies is global reference data and carries no tenant_id, exactly like the CoA
--     templates in 202608241011.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_company_settings','finance_exchange_rates',
    'finance_fiscal_years','finance_fiscal_periods'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''finance''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''finance''))',
      t
    );
  END LOOP;
END $$;
