// DW-7j f4 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2, DW-D30): payroll paid by its pay date. Company grain (§40.6.1). Register as
// `gated("hr", payrollOnTime)`.
//
//   `hr.payroll_on_time`: `hr_payroll_runs` of kind `regular`, not deleted, not `cancelled`, with a `pay_date` inside the window
//   (an inclusive date range). A run counts when its `pay_date` is already due (`<= asOf`) or it is already `paid`. On time =
//   `status = 'paid'` and `paid_at`'s date in REPORTS_TZ is on or before `pay_date` (DW-D30: "published" means "paid"). A paid
//   run with no `paid_at` counts but is not on time: there is no stamp to say it was paid by the day. A run with no `pay_date`
//   is never counted (it has no deadline). Thr, bonus, final and correction runs are never counted. `null` when nothing counts.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import type { ModuleKpiReader } from "../types";
import { localDateSql } from "../scope";
import { HR_WALLS } from "./hr-leave";

/** f4 · `hr.payroll_on_time` */
export const payrollOnTime: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 start, $3 end, $4 zone, $5 asOf
  const sql =
    `SELECT count(*)::int AS denominator,
            (count(*) FILTER (WHERE r.status = 'paid' AND r.paid_at IS NOT NULL
                                AND ${localDateSql("r.paid_at", 4)} <= r.pay_date))::int AS numerator
       FROM hr_payroll_runs r
      WHERE r.tenant_id = $1::uuid
        AND r.deleted_at IS NULL
        AND r.kind = 'regular'
        AND r.status <> 'cancelled'
        AND r.pay_date IS NOT NULL
        AND r.pay_date >= $2::date AND r.pay_date <= $3::date
        AND (r.pay_date <= $5::date OR r.status = 'paid')`;
  const row = await withTenants(
    [ctx.tenantId],
    async (c) => {
      const { rows } = await c.query<{ denominator: number; numerator: number }>(sql, [
        ctx.tenantId, ctx.start, ctx.end, config.reportsTz, ctx.asOf,
      ]);
      return rows[0];
    },
    HR_WALLS,
  );
  const denominator = Number(row?.denominator ?? 0);
  if (denominator === 0) return null;
  const numerator = Number(row.numerator);
  return { value: numerator / denominator, numerator, denominator };
};
