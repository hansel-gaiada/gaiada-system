-- Re-apply finance_eliminate_intercompany so LIVE gets the fix that only CI ever had.
--
-- ── FOUND BY COMPARING DEPLOYED FUNCTION BODIES AGAINST THE MIGRATIONS ─────────────────────────
-- After 202608261900 fixed the same class of bug in finance_treasury_reconcile, every function the
-- migrations define was fingerprinted and compared against pg_proc on the live estate. 88 of 90
-- matched. This was the second that did not.
--
-- `5c16c130 feat(finance): F9-06..F9-12 - consolidated statements, and two real defects fixed`
-- corrected this function by EDITING migration 202608251530, which had already been applied.
-- Migrations run once, so the correction reached every fresh database and never reached live.
--
-- The live version goes straight from the reciprocity check to the INSERT. The repo version filters
-- the counterparty's own detail by `dd.counterparty_company_id = r.cp` first. On a group where two
-- members each trade with more than one sibling, the unfiltered version eliminates against the
-- WRONG counterparty's balance.
--
-- ★ WHY THIS ONE MATTERS MORE THAN THE TREASURY CASE. A wrong tie-out is visibly red and gets
-- investigated. A wrong ELIMINATION is invisible: the consolidated trial balance still balances,
-- still refuses to serve without eliminations, and still looks like a finished working paper. It is
-- simply wrong by the amount of the mis-matched intercompany balance — in the one artefact that
-- goes to a bank.
--
-- Body COPIED VERBATIM from 202608251530 as it now stands. Not retyped, not improved: the point is
-- to make live match the repo, and any difference would reintroduce the divergence.

CREATE OR REPLACE FUNCTION finance_eliminate_intercompany(
  p_run uuid
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_run    finance_consolidation_runs%ROWTYPE;
  v_n      integer := 0;
  m        record;
  r        record;
  d        record;
BEGIN
  SELECT * INTO v_run FROM finance_consolidation_runs WHERE id = p_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_CONSOLIDATION_RUN_NOT_FOUND: no run %', p_run;
  END IF;

  FOR m IN
    SELECT g.company_id FROM finance_group_members(v_run.tenant_id, v_run.as_of) g
     WHERE g.consolidation IN ('full','parent')
  LOOP
    FOR r IN
      SELECT p.counterparty_company_id AS cp, p.receivable, p.payable
        FROM finance_intercompany_position(m.company_id, v_run.as_of) p
    LOOP
      -- Only eliminate against a company that is itself in the group. A related-party balance with
      -- an entity OUTSIDE the group is a real external balance and must survive consolidation.
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM finance_group_members(v_run.tenant_id, v_run.as_of) g2
         WHERE g2.company_id = r.cp AND g2.consolidation IN ('full','parent'));

      IF (SELECT count(*) FROM finance_intercompany_mismatch(m.company_id, r.cp, v_run.as_of)) > 0 THEN
        RAISE EXCEPTION
          'FINANCE_INTERCOMPANY_MISMATCH: the two sides of the balance between % and % disagree; '
          'resolve it before consolidating (netting it would hide a real reconciling item)',
          m.company_id, r.cp;
      END IF;

      -- Remove each tagged account against its own balance. THE ACCOUNT CODE MATTERS: the balance
      -- sits on '1290-XXXX', not on the parent '1290', and crediting the parent offsets nothing —
      -- the group balance sheet would still carry the intercompany receivable. Caught by the F9
      -- consolidated suite, which asserted the netted pair was zero and found -50,000,000.
      FOR d IN
        SELECT * FROM finance_intercompany_accounts_detail(m.company_id, v_run.as_of) dd
         WHERE dd.counterparty_company_id = r.cp
      LOOP
        INSERT INTO finance_consolidation_entries
          (tenant_id, run_id, subject_company_id, account_code, side, amount, kind, memo)
        VALUES (v_run.tenant_id, p_run, m.company_id, d.account_code,
                -- Reverse the account's own normal direction: a debit-normal receivable is removed
                -- by a credit, a credit-normal payable by a debit. Sign from normal_balance, never
                -- from a list of codes.
                CASE WHEN d.account_type = 'asset' THEN 'credit' ELSE 'debit' END,
                abs(d.balance), 'ic_balance',
                'Eliminate intercompany ' || d.account_type || ' ' || d.account_code);
        v_n := v_n + 1;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN v_n;
END $$;
