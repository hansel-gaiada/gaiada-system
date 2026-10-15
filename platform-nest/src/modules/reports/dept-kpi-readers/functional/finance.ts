// DW-7j f7 and f8 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2): the finance department's company readers. Company grain (§40.6.1):
// the unit in the context is ignored. Both read the finance module's tables under its wall; register each as
// `gated("finance", reader)` so a company that turned finance off reads `null` rather than its old rows.
//
//   f7 `finance.close_on_time`: fiscal periods whose `end_date` is inside the window (an inclusive date range) with a deadline of
//      `end_date` + 10 calendar days (DW-D30). A period counts when that deadline is already due (`<= asOf`) or the period is
//      already locked. On time = the lock's date in REPORTS_TZ is on or before the deadline. The lock is the soft lock; a period
//      hard-locked with no soft lock counts its hard lock. A zero denominator is `null`.
//   f8 `finance.overdue_receivables_share`: the AR aging at `asOf` (`finance_ar_aging`, a point-in-time balance: the window's
//      start plays no part). Overdue = d1_30 + d31_60 + d61_90 + d90_plus, over total_outstanding, summed across customers.
//      `null` when nothing is outstanding.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import type { ModuleKpiReader } from "../types";
import { localDateSql } from "../scope";

const FINANCE = { modules: ["finance"] };

/** The days after a period's end within which it should be soft-locked (DW-D30). */
export const CLOSE_WITHIN_DAYS = 10;

/** f7 · `finance.close_on_time` */
export const closeOnTime: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 start, $3 end, $4 zone, $5 asOf, $6 days
  const sql =
    `SELECT count(*)::int AS denominator,
            (count(*) FILTER (WHERE x.lock_day IS NOT NULL AND x.lock_day <= x.deadline))::int AS numerator
       FROM (
         SELECT (p.end_date + $6::int) AS deadline,
                CASE WHEN p.soft_locked_at IS NOT NULL OR p.hard_locked_at IS NOT NULL
                     THEN ${localDateSql("coalesce(p.soft_locked_at, p.hard_locked_at)", 4)} END AS lock_day
           FROM finance_fiscal_periods p
          WHERE p.tenant_id = $1::uuid
            AND p.end_date >= $2::date AND p.end_date <= $3::date
            AND ((p.end_date + $6::int) <= $5::date OR p.soft_locked_at IS NOT NULL OR p.hard_locked_at IS NOT NULL)
       ) x`;
  const row = await withTenants(
    [ctx.tenantId],
    async (c) => {
      const { rows } = await c.query<{ denominator: number; numerator: number }>(sql, [
        ctx.tenantId, ctx.start, ctx.end, config.reportsTz, ctx.asOf, CLOSE_WITHIN_DAYS,
      ]);
      return rows[0];
    },
    FINANCE,
  );
  const denominator = Number(row?.denominator ?? 0);
  if (denominator === 0) return null;
  const numerator = Number(row.numerator);
  return { value: numerator / denominator, numerator, denominator };
};

/** f8 · `finance.overdue_receivables_share` */
export const overdueReceivablesShare: ModuleKpiReader = async (ctx) => {
  const row = await withTenants(
    [ctx.tenantId],
    async (c) => {
      const { rows } = await c.query<{ overdue: string; outstanding: string }>(
        `SELECT coalesce(sum(d1_30 + d31_60 + d61_90 + d90_plus), 0) AS overdue,
                coalesce(sum(total_outstanding), 0) AS outstanding
           FROM finance_ar_aging($1::uuid, $2::date)`,
        [ctx.tenantId, ctx.asOf],
      );
      return rows[0];
    },
    FINANCE,
  );
  const outstanding = Number(row?.outstanding ?? 0);
  if (!(outstanding > 0)) return null;
  const overdue = Number(row.overdue);
  return { value: overdue / outstanding, numerator: overdue, denominator: outstanding };
};
