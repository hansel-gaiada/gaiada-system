-- Finance F10 + F8-11 — OPENING BALANCES, THE CUTOVER GATE, YEAR-END CLOSE, AND PLACING AN
-- ASSET IN SERVICE.
--
-- Owner: no prior books (A4), so opening balances are small — capital and whatever cash exists.
-- That does NOT make the cutover gate optional. The gate is the thing that stops a set of books
-- starting out wrong, and a wrong opening balance is the most expensive error in accounting
-- because every subsequent statement inherits it silently.
--
-- ── THE GATE, AND WHY A SUSPENSE PLUG IS FORBIDDEN ─────────────────────────────────────────────
-- ★ Every accounting system offers to balance an opening trial balance by shoving the difference
-- into a suspense account. It is the single most damaging convenience in the category: the books
-- balance, every report renders, and the difference sits there for years being quietly amortised
-- into whatever account someone eventually decides to clear it against.
--
-- `finance_commit_cutover()` REFUSES. An unbalanced opening means somebody has the wrong numbers,
-- and the only correct response is to go and get the right ones.
--
-- ── OPENING BALANCES ARE STAGED, NOT POSTED ───────────────────────────────────────────────────
-- They accumulate in `finance_opening_balances`, which is ordinary mutable data — you can correct a
-- typo before committing. The moment they are committed they become ONE journal with
-- `source='OPENING'`, and from then on the ledger's normal rules apply: immutable, reversal-only.
-- Staging is what makes the correction of a typo cheap and the correction of a posted figure
-- deliberate, which is the right way round.
--
-- ── YEAR-END: PROFIT MOVES FROM 3400 TO 3300 ───────────────────────────────────────────────────
-- `finance_balance_sheet()` already carries the year's profit into equity so A = L + E holds
-- BEFORE the close. The year-end entry is what makes that permanent: revenue and expense accounts
-- are zeroed into `3300 Saldo Laba Ditahan`, and the next year starts from zero.
--
-- Note `3300`, not `3200`. `3200 Tambahan Modal Disetor` is additional paid-in capital — closing
-- profit there would misstate share premium, and both are equity so the sheet would still balance.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) The cutover
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_cutovers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  cutover_date   date NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','committed')),
  journal_id     uuid,
  committed_by   uuid REFERENCES users(id),
  committed_at   timestamptz,
  notes          text,
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_finance_cutovers_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ck_finance_cutovers_committed CHECK (
    (status = 'committed') = (journal_id IS NOT NULL AND committed_at IS NOT NULL)
  )
);
-- One committed cutover per company, ever. A second set of opening balances would double the
-- company's history, and the books have no way to tell which one was meant.
CREATE UNIQUE INDEX ux_finance_cutovers_one_committed
  ON finance_cutovers (tenant_id) WHERE status = 'committed';

CREATE TABLE finance_opening_balances (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  cutover_id     uuid NOT NULL,
  account_code   text NOT NULL,
  debit          numeric(20,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         numeric(20,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_finance_opening_cutover
    FOREIGN KEY (cutover_id, tenant_id) REFERENCES finance_cutovers (id, tenant_id) ON DELETE CASCADE,
  -- A line is a debit OR a credit. Both, or neither, is a data-entry error that would survive into
  -- the opening journal looking deliberate.
  CONSTRAINT ck_finance_opening_one_side CHECK ((debit > 0) <> (credit > 0))
);
CREATE UNIQUE INDEX ux_finance_opening_account ON finance_opening_balances (cutover_id, account_code);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_cutovers','finance_opening_balances'] LOOP
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
-- (2) finance_cutover_readiness() — the gate (F10-02, F10-07)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_cutover_readiness(p_cutover uuid)
  RETURNS TABLE (blocker text, detail text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_c   finance_cutovers%ROWTYPE;
  v_dr  numeric;
  v_cr  numeric;
BEGIN
  SELECT * INTO v_c FROM finance_cutovers WHERE id = p_cutover;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_CUTOVER_NOT_FOUND: no cutover %', p_cutover;
  END IF;

  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0) INTO v_dr, v_cr
    FROM finance_opening_balances WHERE cutover_id = p_cutover;

  IF v_dr = 0 AND v_cr = 0 THEN
    RETURN QUERY SELECT 'NO_OPENING_BALANCES'::text, 'this cutover has no lines';
    RETURN;
  END IF;

  -- ★ The plug refusal. Reported as a blocker AND raised on commit — a UI must be able to SHOW the
  -- difference before anyone tries.
  IF v_dr <> v_cr THEN
    RETURN QUERY SELECT 'OPENING_UNBALANCED'::text,
      'debits ' || v_dr::text || ' vs credits ' || v_cr::text ||
      ' (difference ' || (v_dr - v_cr)::text || ') — find the missing figure; this will NOT be plugged';
  END IF;

  -- An account that does not exist cannot receive an opening balance, and finding out at commit
  -- time is worse than finding out here.
  RETURN QUERY
    SELECT 'UNKNOWN_ACCOUNT'::text, 'no account ' || ob.account_code || ' in this company''s chart'
      FROM finance_opening_balances ob
     WHERE ob.cutover_id = p_cutover
       AND NOT EXISTS (SELECT 1 FROM finance_accounts a
                        WHERE a.tenant_id = v_c.tenant_id AND a.code = ob.account_code
                          AND a.deleted_at IS NULL AND a.is_postable);

  -- The cutover date must fall in a real period, or the opening journal has nowhere to land.
  IF NOT EXISTS (SELECT 1 FROM finance_fiscal_periods p
                  WHERE p.tenant_id = v_c.tenant_id
                    AND v_c.cutover_date BETWEEN p.start_date AND p.end_date) THEN
    RETURN QUERY SELECT 'NO_PERIOD_FOR_CUTOVER_DATE'::text,
      v_c.cutover_date::text || ' falls in no fiscal period — cut the calendar first';
  END IF;
END $$;
COMMENT ON FUNCTION finance_cutover_readiness(uuid) IS
  'F10-07: the cutover gate. An unbalanced opening is reported, never plugged — a suspense plug '
  'makes the books balance while leaving a wrong figure to be amortised into something years later.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_commit_cutover() — F10-01, F10-08
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_commit_cutover(p_cutover uuid, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_c      finance_cutovers%ROWTYPE;
  v_block  text;
  v_lines  jsonb;
  v_entry  uuid;
BEGIN
  SELECT * INTO v_c FROM finance_cutovers WHERE id = p_cutover;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_CUTOVER_NOT_FOUND: no cutover %', p_cutover;
  END IF;
  IF v_c.status = 'committed' THEN
    RAISE EXCEPTION 'FINANCE_CUTOVER_ALREADY_COMMITTED: committed on %', v_c.committed_at;
  END IF;

  SELECT string_agg(r.blocker || ': ' || r.detail, '; ') INTO v_block
    FROM finance_cutover_readiness(p_cutover) r;
  IF v_block IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCE_CUTOVER_NOT_READY: %', v_block;
  END IF;

  SELECT jsonb_agg(
           jsonb_build_object(
             'account_code', ob.account_code,
             'side', CASE WHEN ob.debit > 0 THEN 'debit' ELSE 'credit' END,
             'amount', CASE WHEN ob.debit > 0 THEN ob.debit ELSE ob.credit END,
             'memo', COALESCE(ob.memo, 'Opening balance')))
    INTO v_lines
    FROM finance_opening_balances ob WHERE ob.cutover_id = p_cutover;

  -- source='OPENING' so this entry is findable forever. An auditor's first question about a set of
  -- books is "what did you start from", and it must be answerable with one query.
  v_entry := finance_post_journal(
    v_c.tenant_id, v_c.cutover_date,
    'OPENING:' || p_cutover::text,
    'Opening balances as at ' || v_c.cutover_date::text,
    v_lines, p_actor, 'standard', NULL, NULL, NULL, NULL, NULL);

  UPDATE finance_cutovers
     SET status = 'committed', journal_id = v_entry, committed_by = p_actor, committed_at = now()
   WHERE id = p_cutover;

  -- F10-08: everything before the cutover is history and is not editable.
  --
  -- Two things the first draft got wrong, both caught by the suite:
  --
  --  1. TWO STEPS, NOT ONE. `finance_period_state_guard()` requires OPEN -> SOFT_LOCK -> HARD_LOCK
  --     and refuses the jump. Setting HARD_LOCK directly works only when NO period precedes the
  --     cutover date — so a 1-January cutover passed and a mid-year one would have failed. The kind
  --     of bug that ships because the common case is the one you test.
  --
  --  2. HARD_LOCK REQUIRES A SIGN-OFF (D-F5: `FINANCE_PERIOD_UNSIGNED`). That control exists so
  --     "these figures are final" cannot be asserted anonymously, and it applies here too.
  --
  --     Committing a cutover IS that assertion — it is a named person declaring that everything
  --     before this date is not this system's books — so stamping `signed_off_by` with the actor is
  --     the control being satisfied, not bypassed. What it must NOT do is stamp anonymously, so an
  --     actorless commit is refused outright rather than quietly signing as nobody.
  IF EXISTS (SELECT 1 FROM finance_fiscal_periods p
              WHERE p.tenant_id = v_c.tenant_id AND p.end_date < v_c.cutover_date
                AND p.state <> 'HARD_LOCK')
     AND p_actor IS NULL THEN
    RAISE EXCEPTION
      'FINANCE_CUTOVER_ACTOR_REQUIRED: periods before % must be closed, and closing them names the '
      'person who did it. Commit the cutover as a named user.', v_c.cutover_date;
  END IF;

  UPDATE finance_fiscal_periods
     SET state = 'SOFT_LOCK',
         signed_off_by = COALESCE(signed_off_by, p_actor),
         signed_off_at = COALESCE(signed_off_at, now())
   WHERE tenant_id = v_c.tenant_id AND end_date < v_c.cutover_date AND state = 'OPEN';
  UPDATE finance_fiscal_periods
     SET state = 'HARD_LOCK'
   WHERE tenant_id = v_c.tenant_id AND end_date < v_c.cutover_date AND state = 'SOFT_LOCK';

  RETURN v_entry;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) F10-10 — a closed period is terminal: ALREADY ENFORCED, deliberately not re-implemented
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- `finance_period_state_guard()` in 202608241012 already raises FINANCE_PERIOD_HARD_LOCKED on any
-- state change out of HARD_LOCK, and requires OPEN -> SOFT_LOCK -> HARD_LOCK on the way in.
--
-- A second trigger here enforcing the same rule with its own error code is exactly the failure this
-- estate keeps recording: two hand-written copies of one rule, which drift, and then a caller
-- handles one code and not the other. F10-10 is CLOSED by the existing guard; nothing to add.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) finance_close_year() — F10-09
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_close_year(
  p_company uuid,
  p_fiscal_year uuid,
  p_actor uuid DEFAULT NULL,
  p_retained_account text DEFAULT '3300'
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_fy     finance_fiscal_years%ROWTYPE;
  v_lines  jsonb := '[]'::jsonb;
  v_net    numeric := 0;
  v_entry  uuid;
  r        record;
BEGIN
  SELECT * INTO v_fy FROM finance_fiscal_years WHERE id = p_fiscal_year AND tenant_id = p_company;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_FY_UNKNOWN: no fiscal year % for company %', p_fiscal_year, p_company;
  END IF;
  IF EXISTS (SELECT 1 FROM finance_journal_entries e
              WHERE e.tenant_id = p_company AND e.source_event_id = 'YEAR-END:' || p_fiscal_year::text) THEN
    RAISE EXCEPTION 'FINANCE_YEAR_ALREADY_CLOSED: % has already been closed', v_fy.code;
  END IF;

  -- Zero every P&L account into retained earnings. The SIDE comes from the account's own balance,
  -- not from its type: a revenue account with a debit balance (net of refunds) must be debited to
  -- clear, and assuming "revenue is always credited" would post the wrong way round.
  FOR r IN
    SELECT a.code, m.balance, a.normal_balance
      FROM finance_accounts a
      JOIN finance_account_movement(p_company, v_fy.start_date, v_fy.end_date - 1) m ON m.account_id = a.id
     WHERE a.tenant_id = p_company AND a.deleted_at IS NULL
       AND a.account_type IN ('revenue','expense') AND m.balance <> 0
  LOOP
    -- `balance` is in the account's OWN normal direction, so clearing it is always the opposite
    -- side of that direction.
    v_lines := v_lines || jsonb_build_object(
      'account_code', r.code,
      'side', CASE WHEN r.normal_balance = 'credit' THEN 'debit' ELSE 'credit' END,
      'amount', abs(r.balance),
      'memo', 'Year-end close ' || v_fy.code);
    v_net := v_net + CASE WHEN r.normal_balance = 'credit' THEN r.balance ELSE -r.balance END;
  END LOOP;

  IF jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'FINANCE_YEAR_NOTHING_TO_CLOSE: % has no revenue or expense activity', v_fy.code;
  END IF;

  -- v_net > 0 is a PROFIT, which increases retained earnings (a credit).
  v_lines := v_lines || jsonb_build_object(
    'account_code', p_retained_account,
    'side', CASE WHEN v_net > 0 THEN 'credit' ELSE 'debit' END,
    'amount', abs(v_net),
    'memo', CASE WHEN v_net > 0 THEN 'Profit for ' ELSE 'Loss for ' END || v_fy.code);

  v_entry := finance_post_journal(
    p_company, v_fy.end_date - 1,
    'YEAR-END:' || p_fiscal_year::text,
    'Year-end close ' || v_fy.code,
    v_lines, p_actor, 'standard', NULL, NULL, NULL, NULL, NULL);
  RETURN v_entry;
END $$;
COMMENT ON FUNCTION finance_close_year(uuid,uuid,uuid,text) IS
  'F10-09: zeroes revenue and expense into 3300 Saldo Laba Ditahan. NOT 3200 — that is additional '
  'paid-in capital, and closing profit there would misstate share premium while still balancing.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) F8-11 — place an asset in service
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Construction in progress becomes a depreciating asset on the day it is commissioned, not the day
-- it was bought. Until then it sits in the register at cost and is never depreciated.
CREATE OR REPLACE FUNCTION finance_place_asset_in_service(
  p_asset uuid,
  p_date  date,
  p_actor uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_a finance_assets%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM finance_assets WHERE id = p_asset AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_ASSET_NOT_FOUND: no asset %', p_asset;
  END IF;
  IF v_a.status <> 'cip' THEN
    RAISE EXCEPTION 'FINANCE_ASSET_NOT_CIP: asset % is already %', v_a.code, v_a.status;
  END IF;
  IF p_date < v_a.acquisition_date THEN
    RAISE EXCEPTION 'FINANCE_IN_SERVICE_BEFORE_ACQUISITION: % is before acquisition %',
      p_date, v_a.acquisition_date;
  END IF;
  -- Depreciation begins from this date, so a period already CLOSED cannot be the start: the first
  -- charge would have nowhere to post.
  IF EXISTS (SELECT 1 FROM finance_fiscal_periods p
              WHERE p.tenant_id = v_a.tenant_id AND p_date BETWEEN p.start_date AND p.end_date
                AND p.state = 'HARD_LOCK') THEN
    RAISE EXCEPTION 'FINANCE_IN_SERVICE_IN_CLOSED_PERIOD: % falls in a closed period', p_date;
  END IF;

  UPDATE finance_assets
     SET status = 'active', in_service_date = p_date, updated_at = now()
   WHERE id = p_asset;
END $$;
COMMENT ON FUNCTION finance_place_asset_in_service(uuid,date,uuid) IS
  'F8-11: CIP -> active. Depreciation starts at commissioning, not acquisition — capitalising the '
  'wait would overstate expense in the periods before the asset was earning anything.';
