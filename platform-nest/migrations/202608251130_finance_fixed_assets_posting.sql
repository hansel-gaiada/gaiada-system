-- Finance F8b — CAPITALISATION, THE DEPRECIATION RUN, AND THE TIE-OUT.
--
-- 202608251030 built the register and the schedule. Neither touches the ledger, so at this point
-- the fixed-asset module is a spreadsheet with better constraints. This migration is what makes it
-- a SUBLEDGER: cost lands in the GL, depreciation posts, and the two are checked against each
-- other by a function that can only report — never repair.
--
--     SUM(cost of assets not disposed)     ==  `1210 Aset Tetap` balance
--     SUM(book depreciation POSTED)        ==  `1220 Akumulasi Penyusutan` balance
--
-- ── WHY CAPITALISATION HAS TO EXIST BEFORE THE RECONCILIATION IS MEANINGFUL ────────────────────
-- A register full of assets and a GL with nothing in `1210` reconciles to "everything is wrong".
-- That is technically correct and practically useless — a check that is red by construction gets
-- ignored, which is the precise failure the AR suite already taught this program. So the asset
-- gets into the ledger the same way an invoice does: through a function that posts in the SAME
-- transaction as the record it describes.
--
-- ── THE RUN POSTS ONE JOURNAL, NOT ONE PER ASSET ───────────────────────────────────────────────
-- A hundred assets in a month is a hundred lines, not a hundred journals. Lines are aggregated per
-- (expense account, accumulated account) pair, because that is what an accountant expects to see in
-- the GL and what a bank expects in a movement schedule. The per-asset detail is not lost — it is
-- in `finance_depreciation_lines`, which is what the register reconciles against.
--
-- ── TAX DEPRECIATION IS COMPUTED AND RECORDED, BUT NOT POSTED ──────────────────────────────────
-- ★ This is the single most important line in this file.
--
-- Book depreciation is an ENTRY IN THE BOOKS. Tax depreciation is not — it is a figure on a tax
-- computation. Posting it to the GL would put the tax authority's view of an asset into the
-- financial statements and the balance sheet would stop meaning anything under PSAK.
--
-- So the run records `tax_charge` on every line (it is needed for the deferred-tax calculation and
-- for the annual return) and posts ONLY `book_charge`. An engine that posted both would produce
-- statements that look plausible and are wrong in a way no reconciliation here would catch,
-- because both sides would be consistently wrong together.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) The asset carries its capitalisation journal
-- ════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE finance_assets
  ADD COLUMN acquisition_journal_id uuid,
  ADD COLUMN disposal_journal_id    uuid;

COMMENT ON COLUMN finance_assets.acquisition_journal_id IS
  'The journal that put this asset''s cost into the GL. NULL means the asset is in the register but '
  'NOT in the ledger — which finance_fa_reconcile() reports as UNCAPITALISED_ASSET rather than '
  'silently excluding it from the comparison.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_capitalise_asset() — cost into the GL
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- DR the class's asset account, CR wherever the money came from (bank, AP, or a CIP account).
CREATE OR REPLACE FUNCTION finance_capitalise_asset(
  p_asset          uuid,
  p_credit_account text,
  p_date           date DEFAULT NULL,
  p_actor          uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_a      finance_assets%ROWTYPE;
  v_c      finance_asset_classes%ROWTYPE;
  v_lines  jsonb;
  v_entry  uuid;
BEGIN
  SELECT * INTO v_a FROM finance_assets WHERE id = p_asset AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_ASSET_NOT_FOUND: no asset %', p_asset;
  END IF;
  IF v_a.acquisition_journal_id IS NOT NULL THEN
    -- Not idempotent-by-silence: capitalising twice would double the cost in `1210` and the
    -- reconciliation would then report a difference with no way to tell which posting was the
    -- duplicate. Refuse loudly instead.
    RAISE EXCEPTION 'FINANCE_ASSET_ALREADY_CAPITALISED: asset % already has journal %',
      p_asset, v_a.acquisition_journal_id;
  END IF;
  IF v_a.cost = 0 THEN
    RAISE EXCEPTION 'FINANCE_ASSET_ZERO_COST: asset % has no cost to capitalise', p_asset;
  END IF;

  SELECT * INTO v_c FROM finance_asset_classes WHERE id = v_a.class_id AND tenant_id = v_a.tenant_id;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', v_c.asset_account_code, 'side', 'debit',
                       'amount', v_a.cost, 'memo', 'Capitalise ' || v_a.code),
    jsonb_build_object('account_code', p_credit_account, 'side', 'credit',
                       'amount', v_a.cost, 'memo', 'Capitalise ' || v_a.code)
  );

  -- p_subledger := 'fixed_assets' is what permits touching `1210` at all: it is a control account
  -- and manual journals are barred from it, precisely so the register cannot drift from the GL.
  v_entry := finance_post_journal(
    v_a.tenant_id, COALESCE(p_date, v_a.acquisition_date),
    'fa-acquire:' || p_asset::text,
    'Acquisition ' || v_a.code || ' — ' || v_a.name,
    v_lines, p_actor, 'standard', NULL, NULL, NULL, NULL, 'fixed_assets');

  UPDATE finance_assets SET acquisition_journal_id = v_entry, updated_at = now() WHERE id = p_asset;
  RETURN v_entry;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_run_depreciation() — the monthly charge
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_run_depreciation(
  p_company uuid,
  p_period  uuid,
  p_actor   uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_p        finance_fiscal_periods%ROWTYPE;
  v_run      uuid;
  v_lines    jsonb := '[]'::jsonb;
  v_entry    uuid;
  v_book_tot numeric := 0;
  v_tax_tot  numeric := 0;
  v_count    integer := 0;
  r          record;
BEGIN
  SELECT * INTO v_p FROM finance_fiscal_periods WHERE id = p_period AND tenant_id = p_company;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_PERIOD_NOT_FOUND: no period % for company %', p_period, p_company;
  END IF;
  IF v_p.state <> 'OPEN' THEN
    -- Same rule as any other posting: a closed period is terminal. A missed depreciation run is
    -- corrected by charging it in an OPEN period, never by reopening a closed one.
    RAISE EXCEPTION 'FINANCE_PERIOD_NOT_OPEN: period % is %', v_p.name, v_p.state;
  END IF;

  v_run := gen_random_uuid();
  -- Inserted FIRST, so the UNIQUE index on (tenant_id, period_id) rejects a concurrent second run
  -- before any journal is posted. Doing this after the posting would leave an orphan journal behind
  -- when the second caller lost the race.
  INSERT INTO finance_depreciation_runs (id, tenant_id, period_id, run_by)
  VALUES (v_run, p_company, p_period, p_actor);

  -- One row per asset for this period, from the DERIVED schedule.
  FOR r IN
    SELECT a.id AS asset_id, s.seq, s.book_charge, s.tax_charge,
           c.expense_account_code, c.accum_account_code
      FROM finance_assets a
      JOIN finance_asset_classes c ON c.id = a.class_id AND c.tenant_id = a.tenant_id
      CROSS JOIN LATERAL finance_asset_depreciation_schedule(a.id) s
     WHERE a.tenant_id = p_company
       AND a.deleted_at IS NULL
       AND a.status IN ('active','fully_depreciated')
       AND s.period_start = date_trunc('month', v_p.start_date)::date
       AND (s.book_charge > 0 OR s.tax_charge > 0)
  LOOP
    INSERT INTO finance_depreciation_lines (id, tenant_id, run_id, asset_id, seq, book_charge, tax_charge)
    VALUES (gen_random_uuid(), p_company, v_run, r.asset_id, r.seq, r.book_charge, r.tax_charge);
    v_book_tot := v_book_tot + r.book_charge;
    v_tax_tot  := v_tax_tot  + r.tax_charge;
    v_count    := v_count + 1;
  END LOOP;

  -- ── The journal: BOOK ONLY (see the header) ──────────────────────────────────────────────────
  IF v_book_tot > 0 THEN
    SELECT jsonb_agg(l) INTO v_lines FROM (
      SELECT jsonb_build_object('account_code', x.expense_account_code, 'side', 'debit',
                                'amount', x.amt, 'memo', 'Depreciation ' || v_p.name) AS l
        FROM (SELECT c.expense_account_code, sum(dl.book_charge) AS amt
                FROM finance_depreciation_lines dl
                JOIN finance_assets a ON a.id = dl.asset_id AND a.tenant_id = dl.tenant_id
                JOIN finance_asset_classes c ON c.id = a.class_id AND c.tenant_id = a.tenant_id
               WHERE dl.run_id = v_run AND dl.book_charge > 0
               GROUP BY c.expense_account_code) x
      UNION ALL
      SELECT jsonb_build_object('account_code', y.accum_account_code, 'side', 'credit',
                                'amount', y.amt, 'memo', 'Depreciation ' || v_p.name)
        FROM (SELECT c.accum_account_code, sum(dl.book_charge) AS amt
                FROM finance_depreciation_lines dl
                JOIN finance_assets a ON a.id = dl.asset_id AND a.tenant_id = dl.tenant_id
                JOIN finance_asset_classes c ON c.id = a.class_id AND c.tenant_id = a.tenant_id
               WHERE dl.run_id = v_run AND dl.book_charge > 0
               GROUP BY c.accum_account_code) y
    ) z;

    v_entry := finance_post_journal(
      p_company, v_p.end_date,
      'fa-depreciation:' || v_run::text,
      'Depreciation ' || v_p.name,
      v_lines, p_actor, 'standard', NULL, NULL, NULL, NULL, 'fixed_assets');
  END IF;

  UPDATE finance_depreciation_runs
     SET journal_id = v_entry, asset_count = v_count, book_total = v_book_tot, tax_total = v_tax_tot
   WHERE id = v_run;

  -- Assets whose book life has finished are marked, so the next run skips them without recomputing.
  UPDATE finance_assets a
     SET status = 'fully_depreciated', updated_at = now()
   WHERE a.tenant_id = p_company AND a.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM finance_asset_depreciation_schedule(a.id) s
        WHERE s.period_start > date_trunc('month', v_p.start_date)::date AND s.book_charge > 0
     );

  RETURN v_run;
END $$;
COMMENT ON FUNCTION finance_run_depreciation(uuid,uuid,uuid) IS
  'F8: posts one aggregated journal of BOOK depreciation for a period and records per-asset book '
  'AND tax charges. Tax is recorded, never posted — it belongs on a tax computation, not in the '
  'financial statements. The run row is inserted before any posting so the one-run-per-period '
  'UNIQUE index rejects a concurrent caller before a journal exists.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_fa_reconcile() — a CHECK, never a fixer
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_fa_reconcile(p_company uuid)
  RETURNS TABLE (problem text, detail text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_reg_cost   numeric;
  v_gl_cost    numeric;
  v_reg_accum  numeric;
  v_gl_accum   numeric;
BEGIN
  -- An asset in the register with no capitalisation journal is not a difference to be netted off —
  -- it is a specific, findable problem, and naming it is more useful than a total that is out.
  RETURN QUERY
    SELECT 'UNCAPITALISED_ASSET'::text,
           'asset ' || a.code || ' (' || a.name || ') has cost ' || a.cost::text ||
             ' but no acquisition journal'
      FROM finance_assets a
     WHERE a.tenant_id = p_company AND a.deleted_at IS NULL
       AND a.acquisition_journal_id IS NULL AND a.cost > 0
       AND a.status <> 'cip';

  SELECT COALESCE(sum(a.cost), 0) INTO v_reg_cost
    FROM finance_assets a
   WHERE a.tenant_id = p_company AND a.deleted_at IS NULL
     AND a.status NOT IN ('disposed','written_off')
     AND a.acquisition_journal_id IS NOT NULL;

  SELECT COALESCE(sum(m.balance), 0) INTO v_gl_cost
    FROM finance_account_movement(p_company, NULL, NULL) m
    JOIN finance_accounts acc ON acc.id = m.account_id
   WHERE acc.is_control AND acc.control_subledger = 'fixed_assets'
     AND acc.normal_balance = 'debit';

  IF v_reg_cost <> v_gl_cost THEN
    RETURN QUERY SELECT 'COST_MISMATCH'::text,
      'register ' || v_reg_cost::text || ' vs GL ' || v_gl_cost::text ||
      ' (difference ' || (v_reg_cost - v_gl_cost)::text || ')';
  END IF;

  SELECT COALESCE(sum(dl.book_charge), 0) INTO v_reg_accum
    FROM finance_depreciation_lines dl
   WHERE dl.tenant_id = p_company;

  -- `1220` is an ASSET with a CREDIT normal balance. finance_account_movement returns balance in
  -- the account's OWN normal direction, so a credit-normal account reports its accumulated
  -- depreciation as a positive number — no sign flip here, and no list of "contra" codes.
  SELECT COALESCE(sum(m.balance), 0) INTO v_gl_accum
    FROM finance_account_movement(p_company, NULL, NULL) m
    JOIN finance_accounts acc ON acc.id = m.account_id
   WHERE acc.is_control AND acc.control_subledger = 'fixed_assets'
     AND acc.normal_balance = 'credit';

  IF v_reg_accum <> v_gl_accum THEN
    RETURN QUERY SELECT 'ACCUM_DEPRECIATION_MISMATCH'::text,
      'depreciation lines ' || v_reg_accum::text || ' vs GL ' || v_gl_accum::text ||
      ' (difference ' || (v_reg_accum - v_gl_accum)::text || ')';
  END IF;
END $$;
COMMENT ON FUNCTION finance_fa_reconcile(uuid) IS
  'F8 tie-out: register cost vs the fixed-asset control account, and posted depreciation vs '
  'accumulated depreciation. Reports problems and repairs nothing — a repaired difference is a '
  'difference nobody investigated.';
