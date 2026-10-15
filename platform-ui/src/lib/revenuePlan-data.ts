import "server-only";
// DW-7j-5: the Revenue plan page's honest readers (BFF §40.6.4). Each answer is a `ReadResult`, so a refused or failed read is
// worded on the page and never reads as "no plan" or "no revenue": the plan (`GET revenue-plan`) and, per month, the P&L's
// total revenue (`GET finance/profit-and-loss`). The two are separate reads with separate authorizations, so one can be refused
// while the other is shown.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { getProfitAndLossResult } from "./finance-data";
import { summarizePnl } from "./gmMoney";
import { isFutureMonth, monthFirstDay, monthLastDay, monthsOfYear, type RevenuePlanRead } from "./revenuePlan";

/** `GET revenue-plan?from&to`. A 200 that is not the plan's shape is a broken read, never an empty plan. */
export function getRevenuePlanResult(u: string, t: string, from: string, to: string): Promise<ReadResult<RevenuePlanRead>> {
  const qs = new URLSearchParams({ from, to }).toString();
  return readResult(
    platformFetch<RevenuePlanRead>(`/api/${t}/revenue-plan?${qs}`, u).then((r) => {
      if (!r || !Array.isArray(r.months)) throw new Error("The revenue plan read returned an unexpected answer.");
      return r;
    }),
  );
}

/** One month's actual revenue in MAJOR units: `null` inside an ok read means the statement carried no revenue total (not read, never 0). */
export type MonthActual = ReadResult<number | null>;

export interface YearRead {
  plan: ReadResult<RevenuePlanRead>;
  /** By `YYYY-MM`. A month that starts after `todayIso` has no entry: there is no revenue to read yet. */
  actuals: Record<string, MonthActual>;
}

export async function readRevenuePlanYear(userId: string, tenantId: string, year: number, todayIso: string): Promise<YearRead> {
  const months = monthsOfYear(year);
  const elapsed = months.filter((m) => !isFutureMonth(m, todayIso));
  const [plan, ...pnls] = await Promise.all([
    getRevenuePlanResult(userId, tenantId, months[0], months[11]),
    ...elapsed.map((m) => getProfitAndLossResult(userId, tenantId, monthFirstDay(m), monthLastDay(m))),
  ]);
  const actuals: Record<string, MonthActual> = {};
  elapsed.forEach((m, i) => {
    const r = pnls[i];
    actuals[m] = r.kind === "ok" ? { kind: "ok", data: summarizePnl(r.data).revenue } : r;
  });
  return { plan, actuals };
}
