// DW-7j f9 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2): client payments confirmed within 1 working day. Company grain (§40.6.1).
//
//   `finance.payments_confirmed_1d`: `invoice_payments` not deleted, `created_at` inside the window (the half-open interval
//   [start 00:00, end + 1 day 00:00) in REPORTS_TZ). The deadline is the end of the 1st WORKING day after the creation day in
//   REPORTS_TZ (DW-D30), by the company's HR calendar (working-calendar.ts; no calendar means Monday to Friday, no holidays).
//   Denominator: decided (`confirmed`/`rejected`) plus `pending` whose deadline is already due (`<= asOf`). A pending payment
//   whose deadline has not come yet is left out. Numerator: decided with its decision's date in REPORTS_TZ on or before the
//   deadline. The decision time is `confirmed_at` (`updated_at` if a confirmed row carries none) and, for a rejection,
//   `updated_at`: there is no `rejected_at` (§40.6.3). `null` when the denominator is 0.
//
// `invoice_payments` is a core table (no module wall, 0075), so this reader is NOT gated; only the HR calendar read declares the
// `hr` scope. The reader groups in SQL by day and status, so it reads a few rows, not every payment.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import { addDays } from "../../../hr/working-days";
import type { ModuleKpiReader } from "../types";
import { localDateSql, windowEndSql, windowStartSql } from "../scope";
import { loadWorkingCalendar } from "./working-calendar";
import { deadlineResolver } from "./working-deadline";

/** Working days allowed for a decision (DW-D30: "1 day"). */
export const PAYMENT_DECISION_WORKING_DAYS = 1;
/** Holidays are read this far past the window's end, enough for any deadline a payment created in the window can have. */
const HOLIDAY_LOOKAHEAD_DAYS = 60;

interface Group {
  created_day: string;
  status: "pending" | "confirmed" | "rejected";
  decided_day: string | null;
  n: number;
}

export const paymentsConfirmed1d: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 start, $3 end, $4 zone
  const decidedAt = `(CASE p.status WHEN 'confirmed' THEN coalesce(p.confirmed_at, p.updated_at)
                                    WHEN 'rejected' THEN p.updated_at END)`;
  const sql =
    `SELECT to_char(${localDateSql("p.created_at", 4)}, 'YYYY-MM-DD') AS created_day,
            p.status,
            to_char(${localDateSql(decidedAt, 4)}, 'YYYY-MM-DD') AS decided_day,
            count(*)::int AS n
       FROM invoice_payments p
      WHERE p.tenant_id = $1::uuid
        AND p.deleted_at IS NULL
        AND p.created_at >= ${windowStartSql(2, 4)} AND p.created_at < ${windowEndSql(3, 4)}
      GROUP BY 1, 2, 3`;
  const groups = await withTenants([ctx.tenantId], async (c) => {
    const { rows } = await c.query<Group>(sql, [ctx.tenantId, ctx.start, ctx.end, config.reportsTz]);
    return rows;
  });
  if (groups.length === 0) return null;

  const calendar = await loadWorkingCalendar(ctx.tenantId, ctx.start, addDays(ctx.end, HOLIDAY_LOOKAHEAD_DAYS));
  const deadlineOf = deadlineResolver(PAYMENT_DECISION_WORKING_DAYS, calendar);

  let denominator = 0;
  let numerator = 0;
  for (const g of groups) {
    const deadline = deadlineOf(g.created_day);
    if (g.status === "pending") {
      if (deadline <= ctx.asOf) denominator += g.n;
      continue;
    }
    denominator += g.n;
    if (g.decided_day !== null && g.decided_day <= deadline) numerator += g.n;
  }
  if (denominator === 0) return null;
  return { value: numerator / denominator, numerator, denominator };
};
