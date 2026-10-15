-- DW-7j-5 (docs/FRONTEND-BFF-CONTRACT.md §40.6.4; PERMISSION-CONTRACT §41): THE GM'S MONTHLY REVENUE PLAN. DW-D30 (owner,
-- 2026-10-15) has the plan built now, so that the GM's "Revenue against plan" KPI (`gm.revenue_vs_plan`) has a plan to read.
--
--   finance_revenue_plans — one row per (company, month): the revenue the GM plans for that month.
--
-- ── NOTES ─────────────────────────────────────────────────────────────────────────────────────
--   * `month` is a month START (CHECK: it equals date_trunc('month', month)), so the UNIQUE (tenant_id, month) means one
--     plan per calendar month, never two rows for one month under different days.
--   * `amount_minor` is the plan in the currency's MINOR unit (finance_currencies.minor_unit: IDR 0 dp, USD 2 dp), a
--     bigint >= 0. The ledger's own amounts are `numeric` in MAJOR units; the KPI reader divides by 10^minor_unit to
--     compare like with like. A plan of 0 is allowed (a month the GM plans no revenue for); the KPI treats a plan that sums
--     to 0 as "no data", never a division by zero.
--   * `currency` is the company's base (functional) currency at the time the plan was set, written by the server from
--     finance_company_settings, never taken from the client. It is stored so a later change of base currency cannot
--     silently re-label an old figure; the reader refuses to compare a plan in another currency with the P&L.
--   * `set_by` / `set_at`: who last set the month, and when. A clear is a DELETE; the history is the activity log
--     (`revenue_plan.set` / `revenue_plan.cleared` rows, written by the controller).
--   * RLS: the `finance` third wall, exactly as the finance_* tables: tenant_id in the request's tenant set AND the
--     `finance` module scope declared, on USING and WITH CHECK, FORCE RLS. Grants come from the owner's default privileges
--     (migrations/README.md), as for every finance table.
--
-- Pure DDL, idempotent (CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY). No data is written, so there
-- is nothing for the backfill lint to flag. No Cerbos change: the routes reuse dept_kpi_target read / approve.

CREATE TABLE IF NOT EXISTS finance_revenue_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL REFERENCES finance_currencies(code),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT ux_finance_revenue_plans_month UNIQUE (tenant_id, month)
);

ALTER TABLE finance_revenue_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_revenue_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON finance_revenue_plans;
CREATE POLICY tenant_isolation ON finance_revenue_plans FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('finance'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('finance'));

COMMENT ON TABLE finance_revenue_plans IS
  'DW-7j-5 — the GM''s monthly revenue plan (FRONTEND-BFF-CONTRACT §40.6.4): one row per (company, month), amount in the '
  'currency''s minor unit, in the company''s base currency. Read by the gm.revenue_vs_plan KPI. Third wall: finance module scope required.';
