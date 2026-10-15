// DW-7j f11 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2, DW-D30): how fast a leaver's login is closed. A PROXY for "requests resolved
// within the SLA": it measures one IT task, closing a leaver's access, not every IT request (§40.6.3). Company grain (§40.6.1).
// Register as `gated("hr", itLeaverAccessClosed)`: a company that turned HR off reads `null`.
//
//   `it.leaver_access_closed`: the leavers are `hr_separations` that took effect: `status` is `approved` (set when the approval
//   runs, which also terminates the employee) or `completed` (the vocabulary's closing state; nothing sets it yet), not deleted, with
//   `effective_on` (a date) inside the window and already due (`<= asOf`). `draft`, `pending_approval` and `cancelled` never count.
//   The leaver's login is `subject_user_id`, else the employee's `user_id` (a separation drafted before the person was linked). A
//   leaver with no user has no login to close and is NOT counted, in neither numerator nor denominator.
//   Numerator: an `activities` row `it.account.disable` on `it_account` for that user (written by it-accounts.controller.ts) whose
//   date in REPORTS_TZ is on or before the 1st working day after `effective_on` (`nthWorkingDayAfter`, the company's HR calendar:
//   working-calendar.ts); a login disabled before the effective date counts too. A leaver whose account was never provisioned has
//   no such row and reads as not closed. A leaver counts only when the deadline (that 1st working day) is already due (`<= asOf`,
//   §40.5.1, as f3 and f9) OR the login is already disabled (its date `<= asOf`): a leaver whose deadline is still ahead and whose
//   login is still open is not counted at all, in neither numerator nor denominator. `null` when the denominator is 0.
//   Walls: `hr` (separations, employees) plus the core `activities` table, in one statement.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import { addDays } from "../../../hr/working-days";
import type { ModuleKpiReader } from "../types";
import { localDateSql } from "../scope";
import { HR_WALLS } from "./hr-leave";
import { HOLIDAY_LOOKAHEAD_DAYS, loadWorkingCalendar } from "./working-calendar";
import { deadlineResolver } from "./working-deadline";

/** Working days allowed to close a leaver's login (DW-D30: "1st working day after"). */
export const LEAVER_ACCESS_WORKING_DAYS = 1;

interface Leaver {
  effective_day: string;
  /** The date (REPORTS_TZ) of the leaver's earliest `it.account.disable`, or null when never disabled. */
  disabled_day: string | null;
  n: number;
}

/** f11 · `it.leaver_access_closed` */
export const itLeaverAccessClosed: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 start, $3 end, $4 zone, $5 asOf
  const sql =
    `SELECT effective_day, disabled_day, count(*)::int AS n
       FROM (
         SELECT to_char(s.effective_on, 'YYYY-MM-DD') AS effective_day,
                to_char((SELECT min(${localDateSql("a.occurred_at", 4)}) FROM activities a
                          WHERE a.tenant_id = $1::uuid AND a.verb = 'it.account.disable' AND a.target_entity_type = 'it_account'
                            AND a.target_entity_id = coalesce(s.subject_user_id, e.user_id)), 'YYYY-MM-DD') AS disabled_day
           FROM hr_separations s
           JOIN employees e ON e.id = s.employee_id AND e.tenant_id = s.tenant_id
          WHERE s.tenant_id = $1::uuid
            AND s.deleted_at IS NULL
            AND s.status IN ('approved','completed')
            AND s.effective_on >= $2::date AND s.effective_on <= $3::date AND s.effective_on <= $5::date
            AND coalesce(s.subject_user_id, e.user_id) IS NOT NULL
       ) leavers
      GROUP BY 1, 2`;
  const groups = await withTenants(
    [ctx.tenantId],
    async (c) => {
      const { rows } = await c.query<Leaver>(sql, [ctx.tenantId, ctx.start, ctx.end, config.reportsTz, ctx.asOf]);
      return rows;
    },
    HR_WALLS,
  );
  if (groups.length === 0) return null;

  const calendar = await loadWorkingCalendar(ctx.tenantId, ctx.start, addDays(ctx.end, HOLIDAY_LOOKAHEAD_DAYS));
  const deadlineOf = deadlineResolver(LEAVER_ACCESS_WORKING_DAYS, calendar);

  let denominator = 0;
  let numerator = 0;
  for (const g of groups) {
    const deadline = deadlineOf(g.effective_day);
    const disabled = g.disabled_day !== null && g.disabled_day <= ctx.asOf;
    if (deadline > ctx.asOf && !disabled) continue; // not due yet and still open: nothing to judge
    denominator += g.n;
    if (g.disabled_day !== null && g.disabled_day <= deadline) numerator += g.n;
  }
  if (denominator === 0) return null;
  return { value: numerator / denominator, numerator, denominator };
};
