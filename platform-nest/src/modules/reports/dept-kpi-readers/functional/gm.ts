// DW-7j f2 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2): the General Manager's company readers. Company grain (§40.6.1): the unit in
// the context only says which workspace is asking; the figure is the whole company's, so S(u) plays no part.
//
//   f2 `gm.margin`: net profit ÷ total revenue over the window, from the ledger's own statement,
//      `finance_profit_and_loss(company, start, end)` (both dates inclusive), the `section = 'total'` rows `NET_PROFIT` and
//      `TOTAL_REVENUE`. The same rule as the UI's `marginRate` (lib/gmMoney.ts), so the Company block and the KPI agree: a
//      margin on no revenue is `null`, never 0, and a missing total row is `null`.
import { withTenants } from "../../../../db";
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
