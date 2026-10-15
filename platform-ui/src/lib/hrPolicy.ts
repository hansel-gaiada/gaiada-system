// HR › Reviews and Settings — the value sets the DW-7f-4 / DW-7f-5 write screens share. No "server-only" and no
// "use server": the client forms import these too (a "use server" file may export only async functions). Backend:
// platform-nest src/modules/hr/hr-policy.controller.ts (Cerbos kind `hr_policy`) and migrations
// 202608240140_hr_time_and_lifecycle.sql, 202608240142_hr_compensation_benefits.sql, 202608240143_hr_payroll.sql.
//
// Everything here MIRRORS what the server accepts. Where the server silently swaps an unknown value for a default
// (a calendar's weekend days, a holiday's kind, a policy's accrual method on create, a grade's track), or lets the
// database CHECK answer with a 500 (a participant's status), the screens offer only the known values.
export { label } from "./hrCompensation";

export const CYCLE_KINDS: readonly string[] = ["probation", "periodic", "project"];
export const CYCLE_STATUSES: readonly string[] = ["draft", "open", "closed", "cancelled"];
export const PARTICIPANT_STATUSES: readonly string[] = ["pending", "in_progress", "submitted", "acknowledged", "waived"];
export const PARTICIPANT_OUTCOMES: readonly string[] = ["pass", "extend", "fail"];

/** The statuses an employee may be picked in. The server accepts any non-deleted employee; this keeps leavers out of the list. */
export const PICKABLE_EMPLOYEE_STATUSES: readonly string[] = ["active", "on_leave"];
