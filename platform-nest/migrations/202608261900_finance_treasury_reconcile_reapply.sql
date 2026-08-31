-- Re-apply finance_treasury_reconcile so the LIVE estate gets the fix that only CI ever had.
--
-- ── WHAT WENT WRONG, AND WHY IT WAS INVISIBLE ──────────────────────────────────────────────────
-- `467150f4 fix(finance): the treasury tie-out was red by construction` corrected this function by
-- EDITING migration 202608251830, which had already been applied. Migrations run once. So:
--
--   fresh databases (every test run, every CI shard)  ->  got the corrected function
--   the live estate                                   ->  kept the broken one, permanently
--
-- Nothing could catch that. The suites pass because they build from the migration file; the live
-- behaviour diverges silently and only shows up as a figure somebody has to disbelieve. This is the
-- README rule 4 trap ("an applied migration is not a file to edit") in its most expensive form,
-- because the artefact it produced was a WRONG NUMBER rather than an error.
--
-- ── WHAT THE OLD VERSION DID ───────────────────────────────────────────────────────────────────
-- It summed the GL side over accounts tagged `control_subledger = 'treasury'`. An instrument's
-- liability account is CONFIGURATION and defaults to `2210 Utang Bank Jangka Panjang`, which is
-- deliberately not a control account — an ordinary bank loan is drawn by a manual journal, and
-- barring that would leave no way to record one. So a plain bank loan contributed its full
-- principal to the schedule side and nothing at all to the GL side.
--
-- Observed on live before this migration: "schedules outstanding 185,048,037.49 vs GL 0". The
-- 240,000,000 drawdown WAS in 2210 the whole time; the function was looking somewhere else.
--
-- ★ THIS ALSO CANCELS A PLAN. The obvious fix looked like tagging 2210 as `treasury` — which the
-- schema couples to `is_control` and then to `allow_manual_posting = false`, removing the only way
-- to record a drawdown. That would have traded a visible wrong number for an invisible dead end.
-- The function was already fixed correctly; it just never reached the database.
--
-- The body below is COPIED VERBATIM from 202608251830 as it now stands. It is not retyped and not
-- improved: the point is to make live match the repo, and any difference between the two would
-- reintroduce exactly the divergence this migration exists to end.

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
