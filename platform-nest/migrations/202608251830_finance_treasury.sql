-- Finance F11 — TREASURY: loans, bonds, leases.
--
-- Owner ruling (B3): "ensure all of possible finance and accounting is ready for user to fill in as
-- needed. and this can be add or removed from the book as needed by user." So every instrument kind
-- is modelled, and an instrument is user-managed data rather than a fixed list in code.
--
-- ── ONE MODEL, FOUR KINDS ──────────────────────────────────────────────────────────────────────
-- A bank loan, a shareholder loan, a bond and a lease are the same arithmetic wearing different
-- words: a principal, a rate, a schedule of payments, and a liability that unwinds. Modelling them
-- as one table with a `kind` means the schedule generator, the accrual posting and the tie-out are
-- written once. Four near-identical tables would drift, and the first thing to drift would be the
-- interest calculation.
--
-- ── THE INTEREST SPLIT IS THE WHOLE POINT ──────────────────────────────────────────────────────
-- A payment is not an expense. Of a 10,000,000 instalment, part settles principal (a balance-sheet
-- movement that costs nothing) and part is interest (a real cost). Booking the whole instalment to
-- expense overstates cost and understates the liability, and the two errors hide each other because
-- the bank balance is right either way.
--
-- ── PSAK 73: A LEASE CREATES AN ASSET ──────────────────────────────────────────────────────────
-- ★ A lease is not just a liability. The lessee recognises a RIGHT-OF-USE ASSET and depreciates it,
-- so a lease instrument hands off to F8 — `finance_lease_recognise()` creates the `finance_assets`
-- row. That is why F11 could not be built before F8: half of a lease lives there.
--
-- ── EFFECTIVE INTEREST (PSAK 71) ───────────────────────────────────────────────────────────────
-- When an instrument is issued at a premium or discount, or carries transaction costs, the CASH
-- coupon is not the true cost of borrowing. Amortised cost spreads the difference over the life so
-- each period bears its real charge. Modelled as an `effective_rate` on the instrument, used
-- instead of the nominal rate when present — NULL means "the nominal rate is the effective rate",
-- which is true for an ordinary bank loan at par and avoids forcing a computation nobody needs.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (0) CoA additions for the instruments that had no home
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ `control_subledger` is a CHECK-constrained vocabulary ('ar','ap','inventory','fixed_assets',
-- 'payroll','tax','bank','cash'). Treasury is a NEW subledger and the constraint has to admit it
-- before an account can name it — the migration failed on exactly this. Widened on BOTH the
-- template and the instantiated table, because the two carry independent copies of the same CHECK
-- and widening one would let a template line through that the company's own chart then refused.
ALTER TABLE finance_coa_template_lines DROP CONSTRAINT IF EXISTS finance_coa_template_lines_control_subledger_check;
ALTER TABLE finance_coa_template_lines
  ADD CONSTRAINT finance_coa_template_lines_control_subledger_check
  CHECK (control_subledger IN ('ar','ap','inventory','fixed_assets','payroll','tax','bank','cash','treasury'));
ALTER TABLE finance_accounts DROP CONSTRAINT IF EXISTS finance_accounts_control_subledger_check;
ALTER TABLE finance_accounts
  ADD CONSTRAINT finance_accounts_control_subledger_check
  CHECK (control_subledger IN ('ar','ap','inventory','fixed_assets','payroll','tax','bank','cash','treasury'));

-- Template only — see 202608251030's note on why a migration cannot back-instantiate these.
INSERT INTO finance_coa_template_lines
  (template_id, code, name, parent_code, account_type, normal_balance, is_postable, is_control, control_subledger, sort_order)
SELECT t.id, x.code, x.name, x.parent_code, x.account_type, x.normal_balance, x.is_postable, x.is_control, x.control_subledger, x.sort_order
FROM finance_coa_templates t,
(VALUES
  ('1270','Piutang Pinjaman',              '1200','asset',    'debit',  true, true,  'treasury', 127),
  ('2220','Utang Obligasi',                '2200','liability','credit', true, true,  'treasury', 232),
  ('2225','Diskonto/Premium Obligasi',     '2200','liability','debit',  true, false, NULL,       233),
  ('2230','Liabilitas Sewa',               '2200','liability','credit', true, true,  'treasury', 234),
  ('1215','Aset Hak-Guna (ROU)',           '1200','asset',    'debit',  true, false, NULL,       128)
) AS x(code, name, parent_code, account_type, normal_balance, is_postable, is_control, control_subledger, sort_order)
WHERE t.key = 'id_psak_general_v1'
  AND NOT EXISTS (SELECT 1 FROM finance_coa_template_lines l WHERE l.template_id = t.id AND l.code = x.code);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_instruments
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_instruments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES companies(id),
  code              text NOT NULL,
  name              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('loan_payable','loan_receivable','bond_issued','lease')),

  counterparty_name text,
  -- F11-10: an intercompany loan must be visible to consolidation, or the group reports itself as
  -- both borrower and lender.
  counterparty_company_id uuid REFERENCES companies(id),

  currency_code     text NOT NULL DEFAULT 'IDR' REFERENCES finance_currencies(code),
  principal         numeric(20,2) NOT NULL CHECK (principal > 0),
  -- Annual nominal rate, percent. 0 is legitimate (an interest-free shareholder loan).
  nominal_rate      numeric(9,6) NOT NULL DEFAULT 0 CHECK (nominal_rate >= 0),
  -- PSAK 71. NULL = the nominal rate IS the effective rate, which is true for an ordinary loan at
  -- par. Forcing a computation for the common case would invite a wrong one.
  effective_rate    numeric(9,6) CHECK (effective_rate IS NULL OR effective_rate >= 0),

  start_date        date NOT NULL,
  maturity_date     date NOT NULL,
  payment_months    integer NOT NULL DEFAULT 1 CHECK (payment_months > 0),
  repayment_method  text NOT NULL DEFAULT 'annuity'
                      CHECK (repayment_method IN ('annuity','straight_principal','bullet')),

  -- GL wiring. Configuration, so a company that splits its borrowings by lender needs no code change.
  liability_account_code text NOT NULL DEFAULT '2210',
  interest_account_code  text NOT NULL DEFAULT '7500',
  accrual_account_code   text NOT NULL DEFAULT '2130',

  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','settled','cancelled')),
  notes             text,
  origin_site       text NOT NULL DEFAULT 'central',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  CONSTRAINT ck_finance_instruments_dates CHECK (maturity_date > start_date),
  CONSTRAINT ck_finance_instruments_not_self CHECK (
    counterparty_company_id IS NULL OR counterparty_company_id <> tenant_id
  ),
  CONSTRAINT ux_finance_instruments_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX ux_finance_instruments_code
  ON finance_instruments (tenant_id, code) WHERE deleted_at IS NULL;
CREATE INDEX ix_finance_instruments_counterparty
  ON finance_instruments (tenant_id, counterparty_company_id)
  WHERE counterparty_company_id IS NOT NULL;

COMMENT ON TABLE finance_instruments IS
  'F11: loans, bonds and leases as ONE model with a kind — the same arithmetic wearing different '
  'words. Four near-identical tables would drift, and the interest calculation would drift first.';
COMMENT ON COLUMN finance_instruments.effective_rate IS
  'PSAK 71 amortised cost. NULL means the nominal rate IS the effective rate (an ordinary loan at '
  'par) rather than an unknown to be guessed at.';

-- ROU asset link for a lease (PSAK 73).
ALTER TABLE finance_instruments ADD COLUMN rou_asset_id uuid;

CREATE TABLE finance_instrument_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  instrument_id  uuid NOT NULL,
  period_id      uuid,
  seq            integer NOT NULL,
  due_date       date NOT NULL,
  interest       numeric(20,2) NOT NULL DEFAULT 0,
  principal      numeric(20,2) NOT NULL DEFAULT 0,
  journal_id     uuid,
  posted_at      timestamptz,
  CONSTRAINT fk_finance_instr_payments
    FOREIGN KEY (instrument_id, tenant_id) REFERENCES finance_instruments (id, tenant_id) ON DELETE CASCADE
);
-- One posting per instrument per instalment. Idempotency as a constraint, as everywhere else.
CREATE UNIQUE INDEX ux_finance_instr_payment_seq ON finance_instrument_payments (instrument_id, seq);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_instruments','finance_instrument_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''finance''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''finance''))', t);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_instrument_schedule() — F11-02, F11-04
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Derived, never stored: a rate revision or an early repayment changes every remaining row, and a
-- stored schedule would go stale exactly when it matters.
CREATE OR REPLACE FUNCTION finance_instrument_schedule(p_instrument uuid)
  RETURNS TABLE (
    seq        integer,
    due_date   date,
    opening    numeric,
    interest   numeric,
    principal  numeric,
    closing    numeric
  )
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  i         finance_instruments%ROWTYPE;
  n         integer;
  rate_p    numeric;   -- rate per PERIOD, not per year
  bal       numeric;
  pmt       numeric;
  v_int     numeric;
  v_prin    numeric;
  k         integer;
BEGIN
  SELECT * INTO i FROM finance_instruments WHERE id = p_instrument AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_INSTRUMENT_NOT_FOUND: no instrument %', p_instrument;
  END IF;

  -- Number of instalments over the life.
  n := GREATEST(1, (EXTRACT(YEAR FROM age(i.maturity_date, i.start_date)) * 12
                    + EXTRACT(MONTH FROM age(i.maturity_date, i.start_date)))::integer / i.payment_months);

  -- PSAK 71: the effective rate governs the charge when the instrument was not issued at par.
  rate_p := COALESCE(i.effective_rate, i.nominal_rate) / 100.0 * i.payment_months / 12.0;

  bal := i.principal;

  IF i.repayment_method = 'annuity' AND rate_p > 0 THEN
    -- Level instalment: P * r / (1 - (1+r)^-n).
    pmt := round(i.principal * rate_p / (1 - power(1 + rate_p, -n)), 2);
  END IF;

  FOR k IN 1 .. n LOOP
    v_int := round(bal * rate_p, 2);

    IF i.repayment_method = 'bullet' THEN
      -- Interest only until maturity, then the whole principal.
      v_prin := CASE WHEN k = n THEN bal ELSE 0 END;
    ELSIF i.repayment_method = 'straight_principal' THEN
      v_prin := CASE WHEN k = n THEN bal ELSE round(i.principal / n, 2) END;
    ELSE
      IF rate_p = 0 THEN
        v_prin := CASE WHEN k = n THEN bal ELSE round(i.principal / n, 2) END;
      ELSE
        v_prin := CASE WHEN k = n THEN bal ELSE pmt - v_int END;
      END IF;
    END IF;

    -- ★ The final instalment absorbs rounding, as in the depreciation engine and for the same
    -- reason: rounded periodic figures do not sum to the principal, and a few rupiah of liability
    -- left on a settled loan never reconciles against the GL.
    v_prin := LEAST(v_prin, bal);
    v_prin := GREATEST(v_prin, 0);

    seq       := k;
    due_date  := (i.start_date + make_interval(months => k * i.payment_months))::date;
    opening   := bal;
    interest  := v_int;
    principal := v_prin;
    bal       := bal - v_prin;
    closing   := bal;
    RETURN NEXT;
  END LOOP;
END $$;
COMMENT ON FUNCTION finance_instrument_schedule(uuid) IS
  'F11-02/04: annuity, straight-principal or bullet, at the EFFECTIVE rate when one is set. Derived '
  'never stored — a rate revision changes every remaining row. The final instalment absorbs '
  'rounding so a settled instrument closes at exactly zero.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_post_instrument_accrual() — F11-03
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_post_instrument_accrual(
  p_instrument uuid,
  p_seq        integer,
  p_actor      uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  i       finance_instruments%ROWTYPE;
  s       record;
  v_lines jsonb;
  v_entry uuid;
BEGIN
  SELECT * INTO i FROM finance_instruments WHERE id = p_instrument AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_INSTRUMENT_NOT_FOUND: no instrument %', p_instrument;
  END IF;
  SELECT * INTO s FROM finance_instrument_schedule(p_instrument) sc WHERE sc.seq = p_seq;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_INSTRUMENT_NO_SUCH_INSTALMENT: instrument % has no instalment %',
      i.code, p_seq;
  END IF;

  IF s.interest = 0 THEN
    RAISE EXCEPTION 'FINANCE_INSTRUMENT_NO_INTEREST: instalment % of % carries no interest to accrue',
      p_seq, i.code;
  END IF;

  -- ★ ACCRUAL, NOT PAYMENT. This recognises the COST of the period; settling the cash is a separate
  -- event. Collapsing them is how interest on an unpaid instalment goes unrecorded — the expense
  -- belongs to the period that consumed the borrowing, whether or not anyone has paid yet.
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', i.interest_account_code, 'side',
                       CASE WHEN i.kind = 'loan_receivable' THEN 'credit' ELSE 'debit' END,
                       'amount', s.interest, 'memo', 'Interest ' || i.code || ' #' || p_seq),
    jsonb_build_object('account_code', i.accrual_account_code, 'side',
                       CASE WHEN i.kind = 'loan_receivable' THEN 'debit' ELSE 'credit' END,
                       'amount', s.interest, 'memo', 'Accrued interest ' || i.code || ' #' || p_seq));

  v_entry := finance_post_journal(
    i.tenant_id, s.due_date,
    'instrument-accrual:' || p_instrument::text || ':' || p_seq::text,
    'Interest accrual ' || i.code || ' instalment ' || p_seq,
    v_lines, p_actor, 'standard', NULL, NULL, NULL, NULL, 'treasury');

  INSERT INTO finance_instrument_payments
    (tenant_id, instrument_id, seq, due_date, interest, principal, journal_id, posted_at)
  VALUES (i.tenant_id, p_instrument, p_seq, s.due_date, s.interest, s.principal, v_entry, now());

  RETURN v_entry;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) F11-07 — a lease creates a right-of-use asset (PSAK 73)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_lease_recognise(
  p_instrument uuid,
  p_class      uuid,
  p_actor      uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  i        finance_instruments%ROWTYPE;
  v_asset  uuid;
  v_months integer;
BEGIN
  SELECT * INTO i FROM finance_instruments WHERE id = p_instrument AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_INSTRUMENT_NOT_FOUND: no instrument %', p_instrument;
  END IF;
  IF i.kind <> 'lease' THEN
    RAISE EXCEPTION 'FINANCE_NOT_A_LEASE: % is a %', i.code, i.kind;
  END IF;
  IF i.rou_asset_id IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCE_LEASE_ALREADY_RECOGNISED: % already has ROU asset %', i.code, i.rou_asset_id;
  END IF;

  v_months := GREATEST(1, (EXTRACT(YEAR FROM age(i.maturity_date, i.start_date)) * 12
                           + EXTRACT(MONTH FROM age(i.maturity_date, i.start_date)))::integer);

  -- ★ The asset is depreciated over the LEASE TERM, not the asset's useful life — the lessee's
  -- right ends when the lease does, whatever the underlying asset would otherwise last.
  v_asset := gen_random_uuid();
  INSERT INTO finance_assets
    (id, tenant_id, class_id, code, name, acquisition_date, in_service_date, cost, status,
     book_method, book_life_months)
  VALUES (v_asset, i.tenant_id, p_class, 'ROU-' || i.code, 'Right-of-use: ' || i.name,
          i.start_date, i.start_date, i.principal, 'active', 'straight_line', v_months);

  UPDATE finance_instruments SET rou_asset_id = v_asset, updated_at = now() WHERE id = p_instrument;
  RETURN v_asset;
END $$;
COMMENT ON FUNCTION finance_lease_recognise(uuid,uuid,uuid) IS
  'PSAK 73: a lease is not only a liability. The ROU asset depreciates over the LEASE TERM, not the '
  'underlying asset''s useful life — the right ends when the lease does.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) F11-08 — current vs non-current, which is what a bank reads first
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_instrument_maturity_split(p_company uuid, p_as_of date)
  RETURNS TABLE (
    instrument_id uuid,
    code          text,
    kind          text,
    outstanding   numeric,
    current_portion numeric,
    non_current_portion numeric,
    maturity_date date
  )
  LANGUAGE sql STABLE AS $$
  WITH sched AS (
    SELECT i.id, i.code, i.kind, i.maturity_date, s.due_date, s.principal
      FROM finance_instruments i
      CROSS JOIN LATERAL finance_instrument_schedule(i.id) s
     WHERE i.tenant_id = p_company AND i.deleted_at IS NULL AND i.status = 'active'
  )
  SELECT id, code, kind,
         COALESCE(sum(principal) FILTER (WHERE due_date > p_as_of), 0),
         -- Current = falling due within twelve months of the reporting date. The definition a
         -- lender applies, and the reason this split is on the balance sheet at all.
         COALESCE(sum(principal) FILTER (WHERE due_date > p_as_of AND due_date <= p_as_of + 365), 0),
         COALESCE(sum(principal) FILTER (WHERE due_date > p_as_of + 365), 0),
         maturity_date
    FROM sched
   GROUP BY id, code, kind, maturity_date
   ORDER BY maturity_date;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) F11-12 / F11-13 — the tie-out and the close interlock
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_treasury_reconcile(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (problem text, detail text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_sched numeric;
  v_gl    numeric;
BEGIN
  -- An instrument whose liability never reached the GL is a specific, findable problem.
  RETURN QUERY
    SELECT 'INSTRUMENT_NOT_DRAWN'::text,
           'instrument ' || i.code || ' is active with principal ' || i.principal::text ||
             ' but nothing has been posted to ' || i.liability_account_code
      FROM finance_instruments i
     WHERE i.tenant_id = p_company AND i.deleted_at IS NULL AND i.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM finance_journal_lines l
           JOIN finance_accounts a ON a.id = l.account_id
          WHERE l.tenant_id = p_company AND a.code = i.liability_account_code);

  -- ★ THE GL SIDE IS KEYED OFF THE INSTRUMENTS' OWN ACCOUNTS, NOT OFF THE 'treasury' TAG.
  --
  -- The first version summed control accounts tagged `treasury` (1270 / 2220 / 2230). But an
  -- instrument's liability account is CONFIGURATION and defaults to `2210 Utang Bank Jangka
  -- Panjang`, which is deliberately NOT a control account — an ordinary bank loan is drawn by a
  -- manual journal, and barring that would leave no way to record one.
  --
  -- So the common case, a plain bank loan, contributed to the schedule side and to nothing on the
  -- GL side, and this function reported a permanent mismatch equal to the whole loan. A tie-out
  -- that is red by construction gets ignored, which is the precise failure it exists to prevent.
  SELECT COALESCE(sum(m.outstanding), 0) INTO v_sched
    FROM finance_instrument_maturity_split(p_company, COALESCE(p_as_of, CURRENT_DATE)) m
   WHERE m.kind IN ('loan_payable','bond_issued','lease');

  SELECT COALESCE(sum(mv.balance), 0) INTO v_gl
    FROM finance_account_movement(p_company, NULL, p_as_of) mv
    JOIN finance_accounts a ON a.id = mv.account_id
   WHERE a.account_type = 'liability'
     AND a.code IN (
       SELECT DISTINCT i.liability_account_code
         FROM finance_instruments i
        WHERE i.tenant_id = p_company AND i.deleted_at IS NULL AND i.status = 'active'
          AND i.kind IN ('loan_payable','bond_issued','lease')
     );

  IF v_sched <> v_gl THEN
    RETURN QUERY SELECT 'TREASURY_BALANCE_MISMATCH'::text,
      'schedules outstanding ' || v_sched::text || ' vs GL ' || v_gl::text ||
      ' (difference ' || (v_sched - v_gl)::text || ')';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION finance_treasury_close_blockers(p_company uuid, p_period uuid)
  RETURNS TABLE (blocker text, detail text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE v_p finance_fiscal_periods%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM finance_fiscal_periods WHERE id = p_period AND tenant_id = p_company;
  IF v_p.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_UNKNOWN_PERIOD: no period % for this company', p_period;
  END IF;

  -- F11-13: an instalment that fell due in the period and was never accrued means the period's
  -- interest cost is understated, and closing is terminal.
  RETURN QUERY
    SELECT 'INTEREST_NOT_ACCRUED'::text,
           'instrument ' || i.code || ' instalment ' || s.seq::text || ' due ' || s.due_date::text ||
             ' carries interest ' || s.interest::text || ' that has not been accrued'
      FROM finance_instruments i
      CROSS JOIN LATERAL finance_instrument_schedule(i.id) s
     WHERE i.tenant_id = p_company AND i.deleted_at IS NULL AND i.status = 'active'
       AND s.due_date BETWEEN v_p.start_date AND v_p.end_date
       AND s.interest > 0
       AND NOT EXISTS (
         SELECT 1 FROM finance_instrument_payments p
          WHERE p.instrument_id = i.id AND p.seq = s.seq AND p.journal_id IS NOT NULL);

  RETURN QUERY
    SELECT 'TREASURY_RECONCILIATION'::text, r.problem || ': ' || r.detail
      FROM finance_treasury_reconcile(p_company, v_p.end_date) r;
END $$;
COMMENT ON FUNCTION finance_treasury_close_blockers(uuid,uuid) IS
  'F11-13: an unaccrued instalment understates the period''s interest cost, and a close is '
  'terminal — so it blocks rather than warns.';
