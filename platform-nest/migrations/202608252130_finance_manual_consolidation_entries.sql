-- Finance F9-07 / F9-10 / F9-11 — THE RECORDING PATH FOR WHAT CANNOT BE COMPUTED.
--
-- Three consolidation adjustments are real, required by PSAK, and NOT derivable from anything this
-- system holds:
--
--   * UNREALISED PROFIT (F9-07). When Alpha sells inventory to Beta at a margin and Beta still
--     holds it at period end, the group has not earned that margin — it sold to itself. Removing it
--     needs the COST and the MARGIN of goods still on hand. There is no inventory module, so the
--     figure exists only in the head of whoever did the stock count.
--
--   * GOODWILL (F9-10). Consideration paid, less the fair value of net assets acquired, at the
--     acquisition date. Neither the consideration nor the fair value is in this schema, and the
--     tempting shortcut — `investment - book equity` — is NOT goodwill. Book equity is historical
--     cost; goodwill is measured against FAIR VALUE. The shortcut produces a number that looks like
--     goodwill, sits in the right place on the balance sheet, and is wrong.
--
--   * FX TRANSLATION (F9-11). A subsidiary whose functional currency differs from the group's is
--     translated at closing rate for the balance sheet and average rate for the P&L, with the
--     difference going to a translation reserve. All three live entities are IDR, so there is no
--     rate pair to apply and no reserve to move.
--
-- ── SO THEY ARE RECORDED, NOT INVENTED ─────────────────────────────────────────────────────────
-- ★ The alternative to this function is a `finance_compute_goodwill()` that derives a plausible
-- figure from data that cannot support it. That is worse than an empty column: it is a wrong number
-- with a function signature, and it would be believed precisely because the system produced it.
--
-- What CAN be enforced without the source data is that the entry is well-formed and that the run
-- still balances afterwards. That is what this does.
CREATE OR REPLACE FUNCTION finance_record_consolidation_adjustment(
  p_run             uuid,
  p_kind            text,
  p_subject_company uuid,
  p_lines           jsonb,
  p_memo            text DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_run  finance_consolidation_runs%ROWTYPE;
  v_line jsonb;
  v_dr   numeric := 0;
  v_cr   numeric := 0;
  v_n    integer := 0;
BEGIN
  SELECT * INTO v_run FROM finance_consolidation_runs WHERE id = p_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_CONSOLIDATION_RUN_NOT_FOUND: no run %', p_run;
  END IF;

  -- Only the kinds that genuinely need a human. The computed ones are barred here so nobody
  -- hand-enters an intercompany elimination beside the generated one and double-removes it.
  IF p_kind NOT IN ('unrealised_profit', 'goodwill', 'nci', 'other') THEN
    RAISE EXCEPTION
      'FINANCE_ADJUSTMENT_KIND_NOT_MANUAL: % is computed by this system, not entered. Use '
      'finance_eliminate_intercompany() / finance_eliminate_intercompany_pl() instead — a '
      'hand-entered copy beside a generated one removes the same balance twice.', p_kind;
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'FINANCE_ADJUSTMENT_EMPTY: at least one line is required';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF (v_line->>'side') NOT IN ('debit','credit') THEN
      RAISE EXCEPTION 'FINANCE_BAD_SIDE: side must be debit or credit, got %', v_line->>'side';
    END IF;
    IF (v_line->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'FINANCE_BAD_AMOUNT: amounts are positive; the SIDE carries the direction';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM finance_accounts a
       WHERE a.tenant_id = p_subject_company AND a.code = v_line->>'account_code'
         AND a.deleted_at IS NULL AND a.is_postable
    ) THEN
      RAISE EXCEPTION 'FINANCE_UNKNOWN_ACCOUNT: no postable account % in that company',
        v_line->>'account_code';
    END IF;

    IF (v_line->>'side') = 'debit'
      THEN v_dr := v_dr + (v_line->>'amount')::numeric;
      ELSE v_cr := v_cr + (v_line->>'amount')::numeric;
    END IF;
  END LOOP;

  -- ★ An adjustment must balance ON ITS OWN, not merely leave the run balanced overall.
  --
  -- Checking only the run total would let two unbalanced adjustments cancel each other, and the
  -- working paper would then show two entries that are each wrong and a total that is right. An
  -- auditor reads the entries.
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION
      'FINANCE_ADJUSTMENT_UNBALANCED: debits % vs credits % — a consolidation adjustment is a '
      'journal entry in every sense except where it lives', v_dr, v_cr;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO finance_consolidation_entries
      (tenant_id, run_id, subject_company_id, account_code, side, amount, kind, memo)
    VALUES (v_run.tenant_id, p_run, p_subject_company, v_line->>'account_code',
            v_line->>'side', (v_line->>'amount')::numeric, p_kind,
            COALESCE(v_line->>'memo', p_memo));
    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END $$;
COMMENT ON FUNCTION finance_record_consolidation_adjustment(uuid,text,uuid,jsonb,text) IS
  'F9-07/10/11: records the consolidation adjustments this system cannot derive — unrealised '
  'profit, goodwill, NCI. Deliberately NOT a compute function: goodwill needs fair value at '
  'acquisition and unrealised profit needs an inventory count, and a figure derived from data that '
  'cannot support it is a wrong number with a function signature. Each adjustment must balance on '
  'its own, so two wrong entries cannot cancel into a right total.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- What the run is MISSING, said out loud
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- A consolidation with no goodwill line is not necessarily wrong — most groups have none. But
-- "considered and not applicable" and "never considered" look identical in a working paper, and
-- only one of them is a finished job. This reports the difference as a note.
CREATE OR REPLACE FUNCTION finance_consolidation_completeness(p_run uuid)
  RETURNS TABLE (note text, detail text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_run finance_consolidation_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM finance_consolidation_runs WHERE id = p_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_CONSOLIDATION_RUN_NOT_FOUND: no run %', p_run;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM finance_consolidation_entries WHERE run_id = p_run AND kind = 'nci')
     AND EXISTS (SELECT 1 FROM finance_group_members(v_run.tenant_id, v_run.as_of) g WHERE g.nci_pct > 0)
  THEN
    RETURN QUERY SELECT 'NCI_NOT_RECORDED'::text,
      'a subsidiary is less than wholly owned but no non-controlling interest has been carved out — '
      'the group is claiming to own what it only controls';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM finance_consolidation_entries WHERE run_id = p_run AND kind = 'unrealised_profit') THEN
    RETURN QUERY SELECT 'UNREALISED_PROFIT_NOT_CONSIDERED'::text,
      'no unrealised-profit adjustment. If nothing sold between group companies is still on hand, '
      'that is correct — but it cannot be derived here, so record a zero-effect note if it was checked';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM finance_consolidation_entries WHERE run_id = p_run AND kind = 'goodwill') THEN
    RETURN QUERY SELECT 'GOODWILL_NOT_CONSIDERED'::text,
      'no goodwill adjustment. Most groups have none; it needs consideration paid and fair value of '
      'net assets at acquisition, neither of which this system holds';
  END IF;
END $$;
COMMENT ON FUNCTION finance_consolidation_completeness(uuid) IS
  'Reports what a consolidation run has NOT addressed. "Considered and not applicable" and "never '
  'considered" look identical in a working paper, and only one of them is a finished job.';
