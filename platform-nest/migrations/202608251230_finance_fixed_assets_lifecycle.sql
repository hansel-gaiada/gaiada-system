-- Finance F8c — DISPOSAL, IMPAIRMENT, DEFERRED TAX, AND THE CLOSE INTERLOCK.
--
-- F8a built the register and the two schedules; F8b made it a subledger. This is the rest of an
-- asset's life, plus the reason the owner asked for tax depreciation in the first place.
--
-- ── DEFERRED TAX IS WHY THERE ARE TWO SCHEDULES ────────────────────────────────────────────────
-- Book NBV and tax NBV diverge from the first month (different lives, different methods, and tax
-- recognises no residual). At any date:
--
--     temporary difference = book NBV - tax NBV
--
-- If book NBV is HIGHER, the asset carries more value in the books than the tax authority allows.
-- Future tax deductions are smaller than future book charges, so more tax will be paid later:
-- that is a deferred tax **LIABILITY**. If book NBV is LOWER, it is a deferred tax **ASSET**.
--
-- PSAK 46 measures it at the rate expected to apply when the difference reverses. We take the rate
-- as a parameter rather than storing a constant: the Indonesian corporate rate has moved twice in
-- recent memory, and a hardcoded 22 would be silently wrong the year it changes.
--
-- ⚠ The posting is an ADJUSTMENT TO A BALANCE, not a period charge. The deferred tax account should
-- END the period at the computed figure, so the entry is (target - current), which may be a debit
-- or a credit. Posting the full computed figure every period — the obvious implementation — would
-- accumulate it, and by year three the balance sheet would carry three times the real liability.
--
-- ── DISPOSAL MUST DERECOGNISE BOTH SIDES ───────────────────────────────────────────────────────
-- The gain or loss is proceeds less NET book value, and removing an asset means removing BOTH its
-- cost and its accumulated depreciation. Crediting cost alone leaves the accumulated depreciation
-- stranded in `1220` forever — the balance sheet then shows negative net fixed assets once enough
-- assets have been sold, and `finance_fa_reconcile()` would report a difference nobody could trace
-- to a specific asset.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_asset_book_values() — one place that answers "what is this asset worth"
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Book side comes from what was POSTED (finance_depreciation_lines), not from the schedule: an
-- asset depreciates in the books only when a run actually charged it. Tax side comes from the
-- SCHEDULE, because tax depreciation is never posted and the schedule is its only record.
--
-- That asymmetry is deliberate and is the subtlest thing in this file. Using the schedule for both
-- would report book values for depreciation that was never charged — the register would tie to a
-- GL that had not been posted to.
CREATE OR REPLACE FUNCTION finance_asset_book_values(p_asset uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (cost numeric, book_accum numeric, book_nbv numeric, tax_accum numeric, tax_nbv numeric)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_a finance_assets%ROWTYPE;
  v_book_accum numeric;
  v_tax_accum  numeric;
BEGIN
  SELECT * INTO v_a FROM finance_assets WHERE id = p_asset AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_ASSET_NOT_FOUND: no asset %', p_asset;
  END IF;

  SELECT COALESCE(sum(dl.book_charge), 0) INTO v_book_accum
    FROM finance_depreciation_lines dl
    JOIN finance_depreciation_runs r ON r.id = dl.run_id AND r.tenant_id = dl.tenant_id
    JOIN finance_fiscal_periods p ON p.id = r.period_id AND p.tenant_id = r.tenant_id
   WHERE dl.asset_id = p_asset
     AND (p_as_of IS NULL OR p.end_date <= p_as_of);

  SELECT COALESCE(sum(s.tax_charge), 0) INTO v_tax_accum
    FROM finance_asset_depreciation_schedule(p_asset) s
   WHERE p_as_of IS NULL OR s.period_start <= p_as_of;

  cost       := v_a.cost;
  book_accum := v_book_accum;
  book_nbv   := v_a.cost - v_book_accum;
  tax_accum  := v_tax_accum;
  tax_nbv    := v_a.cost - v_tax_accum;
  RETURN NEXT;
END $$;
COMMENT ON FUNCTION finance_asset_book_values(uuid, date) IS
  'F8c: book side from what was POSTED, tax side from the SCHEDULE. The asymmetry is deliberate — '
  'book value must reflect charges actually made to the GL, while tax depreciation is never posted '
  'and the schedule is its only record.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_dispose_asset()
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_dispose_asset(
  p_asset            uuid,
  p_proceeds         numeric,
  p_proceeds_account text DEFAULT '1120',
  p_date             date DEFAULT NULL,
  p_actor            uuid DEFAULT NULL,
  p_result_account   text DEFAULT '7400'
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_a      finance_assets%ROWTYPE;
  v_c      finance_asset_classes%ROWTYPE;
  v_v      record;
  v_lines  jsonb := '[]'::jsonb;
  v_entry  uuid;
  v_gain   numeric;
BEGIN
  SELECT * INTO v_a FROM finance_assets WHERE id = p_asset AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_ASSET_NOT_FOUND: no asset %', p_asset;
  END IF;
  IF v_a.status IN ('disposed','written_off') THEN
    RAISE EXCEPTION 'FINANCE_ASSET_ALREADY_DISPOSED: asset % was disposed on %', v_a.code, v_a.disposed_date;
  END IF;
  IF v_a.acquisition_journal_id IS NULL THEN
    -- Disposing something the GL never carried would credit a cost that was never debited.
    RAISE EXCEPTION 'FINANCE_ASSET_NOT_CAPITALISED: asset % is not in the ledger', v_a.code;
  END IF;

  SELECT * INTO v_c FROM finance_asset_classes WHERE id = v_a.class_id AND tenant_id = v_a.tenant_id;
  SELECT * INTO v_v FROM finance_asset_book_values(p_asset, COALESCE(p_date, CURRENT_DATE));

  v_gain := p_proceeds - v_v.book_nbv;

  -- Remove BOTH sides: credit the cost out of `1210`, debit the accumulated depreciation out of
  -- `1220`. See the header for what happens if only the cost is removed.
  v_lines := v_lines || jsonb_build_object(
    'account_code', v_c.asset_account_code, 'side', 'credit',
    'amount', v_v.cost, 'memo', 'Disposal ' || v_a.code);
  IF v_v.book_accum > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_code', v_c.accum_account_code, 'side', 'debit',
      'amount', v_v.book_accum, 'memo', 'Disposal ' || v_a.code || ' — accumulated depreciation');
  END IF;
  IF p_proceeds > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_code', p_proceeds_account, 'side', 'debit',
      'amount', p_proceeds, 'memo', 'Disposal proceeds ' || v_a.code);
  END IF;
  IF v_gain <> 0 THEN
    -- `7400` is revenue/credit-normal, so a GAIN is a credit and a LOSS is a debit to the same
    -- account. One account, sign carries the meaning — the alternative (separate gain and loss
    -- accounts) makes the movement schedule net two lines that are the same event.
    v_lines := v_lines || jsonb_build_object(
      'account_code', p_result_account,
      'side', CASE WHEN v_gain > 0 THEN 'credit' ELSE 'debit' END,
      'amount', abs(v_gain),
      'memo', CASE WHEN v_gain > 0 THEN 'Gain on disposal ' ELSE 'Loss on disposal ' END || v_a.code);
  END IF;

  v_entry := finance_post_journal(
    v_a.tenant_id, COALESCE(p_date, CURRENT_DATE),
    'fa-dispose:' || p_asset::text,
    'Disposal ' || v_a.code || ' — ' || v_a.name,
    v_lines, p_actor, 'standard', NULL, NULL, NULL, NULL, 'fixed_assets');

  UPDATE finance_assets
     SET status = 'disposed', disposed_date = COALESCE(p_date, CURRENT_DATE),
         disposal_journal_id = v_entry, updated_at = now()
   WHERE id = p_asset;
  RETURN v_entry;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_impair_asset() — PSAK 48
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- An impairment writes the carrying amount down to recoverable amount. Booked against accumulated
-- depreciation rather than against cost, so the original cost stays visible in the register and in
-- the movement schedule — which is what an auditor asks to see.
CREATE OR REPLACE FUNCTION finance_impair_asset(
  p_asset    uuid,
  p_amount   numeric,
  p_date     date DEFAULT NULL,
  p_actor    uuid DEFAULT NULL,
  p_expense_account text DEFAULT '6750'
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_a     finance_assets%ROWTYPE;
  v_c     finance_asset_classes%ROWTYPE;
  v_v     record;
  v_entry uuid;
BEGIN
  SELECT * INTO v_a FROM finance_assets WHERE id = p_asset AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_ASSET_NOT_FOUND: no asset %', p_asset;
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'FINANCE_IMPAIRMENT_NOT_POSITIVE: impairment must be > 0 (got %)', p_amount;
  END IF;
  SELECT * INTO v_v FROM finance_asset_book_values(p_asset, COALESCE(p_date, CURRENT_DATE));
  IF p_amount > v_v.book_nbv THEN
    -- Writing below zero would make the asset a liability. An impairment larger than carrying
    -- amount means the input is wrong, not that the asset is worth negative money.
    RAISE EXCEPTION 'FINANCE_IMPAIRMENT_EXCEEDS_CARRYING: % exceeds net book value %',
      p_amount, v_v.book_nbv;
  END IF;

  SELECT * INTO v_c FROM finance_asset_classes WHERE id = v_a.class_id AND tenant_id = v_a.tenant_id;

  v_entry := finance_post_journal(
    v_a.tenant_id, COALESCE(p_date, CURRENT_DATE),
    'fa-impair:' || p_asset::text || ':' || COALESCE(p_date, CURRENT_DATE)::text,
    'Impairment ' || v_a.code,
    jsonb_build_array(
      jsonb_build_object('account_code', p_expense_account, 'side', 'debit',
                         'amount', p_amount, 'memo', 'Impairment ' || v_a.code),
      jsonb_build_object('account_code', v_c.accum_account_code, 'side', 'credit',
                         'amount', p_amount, 'memo', 'Impairment ' || v_a.code)
    ),
    p_actor, 'standard', NULL, NULL, NULL, NULL, 'fixed_assets');
  RETURN v_entry;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) Deferred tax (PSAK 46)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_deferred_tax_position(
  p_company uuid,
  p_as_of   date,
  p_rate    numeric
) RETURNS TABLE (book_nbv numeric, tax_nbv numeric, temporary_difference numeric, deferred_tax numeric)
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(v.book_nbv), 0),
         COALESCE(sum(v.tax_nbv), 0),
         COALESCE(sum(v.book_nbv - v.tax_nbv), 0),
         round(COALESCE(sum(v.book_nbv - v.tax_nbv), 0) * p_rate / 100.0, 2)
    FROM finance_assets a
    CROSS JOIN LATERAL finance_asset_book_values(a.id, p_as_of) v
   WHERE a.tenant_id = p_company
     AND a.deleted_at IS NULL
     AND a.status NOT IN ('disposed','written_off')
     AND a.acquisition_journal_id IS NOT NULL;
$$;
COMMENT ON FUNCTION finance_deferred_tax_position(uuid, date, numeric) IS
  'PSAK 46 temporary difference from fixed assets. Positive deferred_tax = LIABILITY (book carries '
  'more than tax allows, so more tax is payable later); negative = ASSET. The rate is a parameter, '
  'not a constant — the Indonesian corporate rate has moved twice recently and a hardcoded value '
  'would be silently wrong the year it changes.';

CREATE OR REPLACE FUNCTION finance_post_deferred_tax(
  p_company uuid,
  p_period  uuid,
  p_rate    numeric,
  p_actor   uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_p        finance_fiscal_periods%ROWTYPE;
  v_pos      record;
  v_current  numeric;
  v_delta    numeric;
  v_entry    uuid;
BEGIN
  SELECT * INTO v_p FROM finance_fiscal_periods WHERE id = p_period AND tenant_id = p_company;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_PERIOD_NOT_FOUND: no period % for company %', p_period, p_company;
  END IF;
  IF v_p.state <> 'OPEN' THEN
    RAISE EXCEPTION 'FINANCE_PERIOD_NOT_OPEN: period % is %', v_p.name, v_p.state;
  END IF;

  SELECT * INTO v_pos FROM finance_deferred_tax_position(p_company, v_p.end_date, p_rate);

  -- What the balance sheet already carries. `2250` is credit-normal, so its movement balance is
  -- positive when a liability is recognised — the same convention as the computed figure.
  SELECT COALESCE(sum(m.balance), 0) INTO v_current
    FROM finance_account_movement(p_company, NULL, v_p.end_date) m
    JOIN finance_accounts a ON a.id = m.account_id
   WHERE a.code = '2250';

  -- ★ ADJUST TO THE TARGET, do not post the target. See the header.
  v_delta := v_pos.deferred_tax - v_current;
  IF v_delta = 0 THEN
    RETURN NULL;
  END IF;

  v_entry := finance_post_journal(
    p_company, v_p.end_date,
    'fa-deferred-tax:' || p_period::text,
    'Deferred tax adjustment ' || v_p.name,
    CASE WHEN v_delta > 0 THEN
      jsonb_build_array(
        jsonb_build_object('account_code', '8200', 'side', 'debit',  'amount', v_delta, 'memo', 'Deferred tax expense'),
        jsonb_build_object('account_code', '2250', 'side', 'credit', 'amount', v_delta, 'memo', 'Deferred tax liability'))
    ELSE
      jsonb_build_array(
        jsonb_build_object('account_code', '2250', 'side', 'debit',  'amount', abs(v_delta), 'memo', 'Deferred tax liability'),
        jsonb_build_object('account_code', '8200', 'side', 'credit', 'amount', abs(v_delta), 'memo', 'Deferred tax expense'))
    END,
    p_actor, 'standard', NULL, NULL, NULL, NULL, NULL);
  RETURN v_entry;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) The close interlock (F8-13)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Extends the existing readiness check with two fixed-asset blockers. Unrun depreciation is the
-- important one: a period closed without it overstates profit, and closing is terminal.
CREATE OR REPLACE FUNCTION finance_fa_close_blockers(p_company uuid, p_period uuid)
  RETURNS TABLE (blocker text, detail text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_p finance_fiscal_periods%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM finance_fiscal_periods WHERE id = p_period AND tenant_id = p_company;
  IF v_p.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_UNKNOWN_PERIOD: no period % for this company', p_period;
  END IF;

  -- Only a blocker if there is something to depreciate. A company with no assets is not blocked by
  -- a run that would post nothing.
  IF NOT EXISTS (SELECT 1 FROM finance_depreciation_runs r
                  WHERE r.tenant_id = p_company AND r.period_id = p_period)
     AND EXISTS (SELECT 1 FROM finance_assets a
                  WHERE a.tenant_id = p_company AND a.deleted_at IS NULL
                    AND a.status = 'active' AND a.in_service_date IS NOT NULL
                    AND a.in_service_date <= v_p.end_date)
  THEN
    RETURN QUERY SELECT 'DEPRECIATION_NOT_RUN'::text,
      'no depreciation run for ' || v_p.name || ' and the register has depreciable assets in service';
  END IF;

  RETURN QUERY
    SELECT 'FIXED_ASSET_RECONCILIATION'::text, f.problem || ': ' || f.detail
      FROM finance_fa_reconcile(p_company) f;
END $$;
COMMENT ON FUNCTION finance_fa_close_blockers(uuid, uuid) IS
  'F8-13: fixed-asset blockers for the period close. Unrun depreciation overstates profit, and a '
  'close is terminal — so it blocks rather than warns.';
