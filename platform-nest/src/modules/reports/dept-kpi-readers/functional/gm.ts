// DW-7j f2 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2): the General Manager's company readers. Company grain (§40.6.1): the unit in
// the context only says which workspace is asking; the figure is the whole company's, so S(u) plays no part.
//
//   f2 `gm.margin`: net profit ÷ total revenue over the window, from the ledger's own statement,
//      `finance_profit_and_loss(company, start, end)` (both dates inclusive), the `section = 'total'` rows `NET_PROFIT` and
//      `TOTAL_REVENUE`. The same rule as the UI's `marginRate` (lib/gmMoney.ts), so the Company block and the KPI agree: a
//      margin on no revenue is `null`, never 0, and a missing total row is `null`.
//   f1 `gm.revenue_vs_plan` (DW-7j-5): actual revenue ÷ the GM's revenue plan over the window. Actual is the same P&L's
//      `TOTAL_REVENUE` row (MAJOR units, `numeric`). The plan (`finance_revenue_plans`, minor units, the company's base
//      currency) is converted to major units by the currency's `minor_unit` and summed over the months the window overlaps, a
//      partial month counting its plan x (days inside the window ÷ days in the month) (finance/revenue-plan.ts). `null` when any
//      overlapping month has no plan (or a plan in another currency than the base), when the plan sums to 0, or when the
//      company has no base currency or no revenue row; a month with a plan and no revenue is a real 0.
import { withTenants } from "../../../../db";
import { planOverWindow } from "../../../finance/revenue-plan";
import type { KpiValue } from "../../dept-kpis";
import type { ModuleKpiReader } from "../types";

export interface PnlTotalRow {
  code: string;
  amount: string | number | null;
}

/** PURE. net ÷ revenue from the P&L's total rows, or `null` when a total row is missing, not a number, or revenue is 0. */
export function marginFromPnlTotals(rows: readonly PnlTotalRow[]): KpiValue | null {
  const amount = (code: string): number | null => {
    const r = rows.find((x) => x.code === code);
    if (!r || r.amount === null) return null;
    const n = Number(r.amount);
    return Number.isFinite(n) ? n : null;
  };
  const revenue = amount("TOTAL_REVENUE");
  const net = amount("NET_PROFIT");
  if (revenue === null || net === null || revenue === 0) return null;
  return { value: net / revenue, numerator: net, denominator: revenue };
}

/** f2 · `gm.margin`. Register as `gated("finance", gmMargin)`. */
export const gmMargin: ModuleKpiReader = async (ctx) => {
  const rows = await withTenants(
    [ctx.tenantId],
    async (c) => {
      const res = await c.query<PnlTotalRow>(
        `SELECT code, amount FROM finance_profit_and_loss($1::uuid, $2::date, $3::date)
          WHERE section = 'total' AND code IN ('TOTAL_REVENUE', 'NET_PROFIT')`,
        [ctx.tenantId, ctx.start, ctx.end],
      );
      return res.rows;
    },
    { modules: ["finance"] },
  );
  return marginFromPnlTotals(rows);
};

/** PURE. actual ÷ plan (both in major units) with the actual as numerator and the plan as denominator, or `null` when either is
 *  missing or the plan is not above 0. The actual comes from the P&L's `TOTAL_REVENUE` row. */
export function revenueVsPlanFrom(rows: readonly PnlTotalRow[], plan: number | null): KpiValue | null {
  const row = rows.find((x) => x.code === "TOTAL_REVENUE");
  if (!row || row.amount === null || plan === null || !(plan > 0)) return null;
  const actual = Number(row.amount);
  if (!Number.isFinite(actual)) return null;
  return { value: actual / plan, numerator: actual, denominator: plan };
}

/** f1 · `gm.revenue_vs_plan`. Register as `gated("finance", gmRevenueVsPlan)`. */
export const gmRevenueVsPlan: ModuleKpiReader = async (ctx) => {
  const { revenue, base, plans } = await withTenants(
    [ctx.tenantId],
    async (c) => {
      const base = (
        await c.query<{ functional_currency: string; minor_unit: number }>(
          `SELECT s.functional_currency, fc.minor_unit
             FROM finance_company_settings s JOIN finance_currencies fc ON fc.code = s.functional_currency
            WHERE s.tenant_id = $1`,
          [ctx.tenantId],
        )
      ).rows[0];
      if (!base) return { revenue: [] as PnlTotalRow[], base: null, plans: [] as Array<{ month: string; amount_minor: string }> };
      const revenue = (
        await c.query<PnlTotalRow>(
          `SELECT code, amount FROM finance_profit_and_loss($1::uuid, $2::date, $3::date) WHERE section = 'total' AND code = 'TOTAL_REVENUE'`,
          [ctx.tenantId, ctx.start, ctx.end],
        )
      ).rows;
      const plans = (
        await c.query<{ month: string; amount_minor: string }>(
          `SELECT to_char(month, 'YYYY-MM') AS month, amount_minor::text AS amount_minor
             FROM finance_revenue_plans
            WHERE tenant_id = $1 AND currency = $4
              AND month >= date_trunc('month', $2::date)::date AND month <= date_trunc('month', $3::date)::date`,
          [ctx.tenantId, ctx.start, ctx.end, base.functional_currency],
        )
      ).rows;
      return { revenue, base, plans };
    },
    { modules: ["finance"] },
  );
  if (!base) return null;
  const byMonth = new Map(plans.map((p) => [p.month, Number(p.amount_minor)]));
  return revenueVsPlanFrom(revenue, planOverWindow(byMonth, ctx.start, ctx.end, base.minor_unit));
};
