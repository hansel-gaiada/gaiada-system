-- Finance F8d — THE FIXED-ASSET MOVEMENT SCHEDULE (F8-14).
--
-- The note that appears in every audited financial statement, per asset class:
--
--     opening cost + additions - disposals = closing cost
--     opening accumulated + charge - disposals = closing accumulated
--     closing net book value = closing cost - closing accumulated
--
-- ── WHY THIS IS DERIVED FROM THE REGISTER, NOT FROM THE GL ─────────────────────────────────────
-- Both would give the same totals if everything is correct, and that is exactly the reason to take
-- it from the register: the movement schedule then has an INDEPENDENT basis from the balance sheet
-- it sits beside, so `finance_fa_reconcile()` comparing them is a real check rather than a
-- comparison of a number against itself.
--
-- A schedule read out of the GL would agree with the balance sheet by construction and could never
-- reveal a register that had drifted — which is the failure it is printed to rule out.
--
-- ── "OPENING" IS AS AT THE START OF THE WINDOW, AND THAT IS NOT THE SAME AS "FIRST PERIOD" ──────
-- Opening cost is the cost of assets acquired BEFORE p_from and not yet disposed AT p_from. An
-- asset bought and sold inside the window appears in additions and disposals and contributes
-- nothing to either opening or closing — which is correct, and is the case a naive
-- "closing minus charge" implementation gets wrong.
CREATE OR REPLACE FUNCTION finance_fa_movement(
  p_company uuid,
  p_from    date,
  p_to      date
) RETURNS TABLE (
  class_code        text,
  class_name        text,
  opening_cost      numeric,
  additions         numeric,
  disposals_cost    numeric,
  closing_cost      numeric,
  opening_accum     numeric,
  charge            numeric,
  disposals_accum   numeric,
  closing_accum     numeric,
  closing_nbv       numeric
) LANGUAGE sql STABLE AS $$
  WITH asset_charge AS (
    -- Depreciation POSTED per asset, split into "before the window" and "inside the window".
    -- Posted, not scheduled: the schedule is what should happen, this note reports what did.
    SELECT dl.asset_id,
           sum(dl.book_charge) FILTER (WHERE p.end_date <  p_from) AS accum_before,
           sum(dl.book_charge) FILTER (WHERE p.end_date >= p_from AND p.end_date <= p_to) AS charge_in
      FROM finance_depreciation_lines dl
      JOIN finance_depreciation_runs r ON r.id = dl.run_id AND r.tenant_id = dl.tenant_id
      JOIN finance_fiscal_periods p ON p.id = r.period_id AND p.tenant_id = r.tenant_id
     WHERE dl.tenant_id = p_company
     GROUP BY dl.asset_id
  )
  SELECT c.code,
         c.name,
         -- Opening: acquired before the window, and NOT already disposed at the window start.
         COALESCE(sum(a.cost) FILTER (
           WHERE a.acquisition_date < p_from
             AND (a.disposed_date IS NULL OR a.disposed_date >= p_from)), 0),
         COALESCE(sum(a.cost) FILTER (
           WHERE a.acquisition_date >= p_from AND a.acquisition_date <= p_to), 0),
         COALESCE(sum(a.cost) FILTER (
           WHERE a.disposed_date IS NOT NULL
             AND a.disposed_date >= p_from AND a.disposed_date <= p_to), 0),
         COALESCE(sum(a.cost) FILTER (
           WHERE a.acquisition_date <= p_to
             AND (a.disposed_date IS NULL OR a.disposed_date > p_to)), 0),

         COALESCE(sum(ac.accum_before) FILTER (
           WHERE a.acquisition_date < p_from
             AND (a.disposed_date IS NULL OR a.disposed_date >= p_from)), 0),
         COALESCE(sum(ac.charge_in), 0),
         -- Accumulated depreciation leaving with a disposed asset: everything charged to it.
         COALESCE(sum(COALESCE(ac.accum_before, 0) + COALESCE(ac.charge_in, 0)) FILTER (
           WHERE a.disposed_date IS NOT NULL
             AND a.disposed_date >= p_from AND a.disposed_date <= p_to), 0),
         COALESCE(sum(COALESCE(ac.accum_before, 0) + COALESCE(ac.charge_in, 0)) FILTER (
           WHERE a.acquisition_date <= p_to
             AND (a.disposed_date IS NULL OR a.disposed_date > p_to)), 0),

         COALESCE(sum(a.cost - COALESCE(ac.accum_before, 0) - COALESCE(ac.charge_in, 0)) FILTER (
           WHERE a.acquisition_date <= p_to
             AND (a.disposed_date IS NULL OR a.disposed_date > p_to)), 0)
    FROM finance_asset_classes c
    LEFT JOIN finance_assets a
      ON a.class_id = c.id AND a.tenant_id = c.tenant_id AND a.deleted_at IS NULL
     AND a.acquisition_journal_id IS NOT NULL   -- only what actually reached the ledger
    LEFT JOIN asset_charge ac ON ac.asset_id = a.id
   WHERE c.tenant_id = p_company AND c.deleted_at IS NULL
   GROUP BY c.code, c.name
   ORDER BY c.code;
$$;
COMMENT ON FUNCTION finance_fa_movement(uuid, date, date) IS
  'F8-14: the fixed-asset note. Derived from the REGISTER, deliberately — a schedule read out of '
  'the GL would agree with the balance sheet by construction and could never reveal a register '
  'that had drifted, which is the failure it is printed to rule out.';
