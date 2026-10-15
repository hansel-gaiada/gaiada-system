// DW-7j f3 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2): HR decides leave within 2 working days. Company grain (§40.6.1): the unit in
// the context is ignored. Register as `gated("hr", leaveDecided2d)`: a company that turned HR off reads `null`, not its old rows.
//
//   `hr.leave_decided_2d`: `hr_leave_requests` not deleted and not `cancelled`, `created_at` inside the window (the half-open
//   interval [start 00:00, end + 1 day 00:00) in REPORTS_TZ). The deadline is the end of the 2nd WORKING day after the creation
//   day in REPORTS_TZ (DW-D30), by the company's HR calendar (working-calendar.ts; none means Monday to Friday, no holidays).
//   Denominator: decided (`approved`/`denied`) plus `pending` whose deadline is already due (`<= asOf`); a pending request
//   whose deadline has not come is left out. Numerator: decided with its decision's date in REPORTS_TZ on or before the deadline.
//   The decision time is `decided_at`; a decided row with no `decided_at` falls back to `updated_at`, the last time the row
//   changed (it is the best a row without the stamp can say, and a later edit would read as a later decision). `null` when the
//   denominator is 0. The reader groups in SQL by day and status, so it reads a few rows, not every request.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import { addDays } from "../../../hr/working-days";
import type { ModuleKpiReader } from "../types";
import { localDateSql, windowEndSql, windowStartSql } from "../scope";
import { HOLIDAY_LOOKAHEAD_DAYS, loadWorkingCalendar } from "./working-calendar";
import { deadlineResolver } from "./working-deadline";

/** The wall the HR readers declare (`app_module_allowed('hr')`). */
export const HR_WALLS = { modules: ["hr"] };

/** Working days allowed for a leave decision (DW-D30: "2 days"). */
export const LEAVE_DECISION_WORKING_DAYS = 2;

interface Group {
  created_day: string;
  status: "pending" | "approved" | "denied";
  decided_day: string | null;
  n: number;
}

/** f3 · `hr.leave_decided_2d` */
export const leaveDecided2d: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 start, $3 end, $4 zone
  const decidedAt = `(CASE WHEN r.status IN ('approved','denied') THEN coalesce(r.decided_at, r.updated_at) END)`;
  const sql =
    `SELECT to_char(${localDateSql("r.created_at", 4)}, 'YYYY-MM-DD') AS created_day,
            r.status,
            to_char(${localDateSql(decidedAt, 4)}, 'YYYY-MM-DD') AS decided_day,
            count(*)::int AS n
       FROM hr_leave_requests r
      WHERE r.tenant_id = $1::uuid
        AND r.deleted_at IS NULL
        AND r.status <> 'cancelled'
        AND r.created_at >= ${windowStartSql(2, 4)} AND r.created_at < ${windowEndSql(3, 4)}
      GROUP BY 1, 2, 3`;
  const groups = await withTenants(
    [ctx.tenantId],
    async (c) => {
      const { rows } = await c.query<Group>(sql, [ctx.tenantId, ctx.start, ctx.end, config.reportsTz]);
      return rows;
    },
    HR_WALLS,
  );
  if (groups.length === 0) return null;

  const calendar = await loadWorkingCalendar(ctx.tenantId, ctx.start, addDays(ctx.end, HOLIDAY_LOOKAHEAD_DAYS));
  const deadlineOf = deadlineResolver(LEAVE_DECISION_WORKING_DAYS, calendar);

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
