// HR › Reviews and Settings — the value sets the DW-7f-4 / DW-7f-5 write screens share. No "server-only" and no
// "use server": the client forms import these too (a "use server" file may export only async functions). Backend:
// platform-nest src/modules/hr/hr-policy.controller.ts (Cerbos kind `hr_policy`) and migrations
// 202608240140_hr_time_and_lifecycle.sql, 202608240142_hr_compensation_benefits.sql, 202608240143_hr_payroll.sql.
//
// Everything here MIRRORS what the server accepts. Where the server silently swaps an unknown value for a default
// (a calendar's weekend days, a holiday's kind, a policy's accrual method on create, a grade's track), or lets the
// database CHECK answer with a 500 (a participant's status), the screens offer only the known values.
export { RATE_BASES } from "./hrRecruitment";
export { label } from "./hrCompensation";

export const CYCLE_KINDS: readonly string[] = ["probation", "periodic", "project"];
export const CYCLE_STATUSES: readonly string[] = ["draft", "open", "closed", "cancelled"];
export const PARTICIPANT_STATUSES: readonly string[] = ["pending", "in_progress", "submitted", "acknowledged", "waived"];
export const PARTICIPANT_OUTCOMES: readonly string[] = ["pass", "extend", "fail"];

export const LEAVE_TYPES: readonly string[] = ["vacation", "sick", "unpaid", "other"];
export const ACCRUAL_METHODS: readonly string[] = ["upfront", "monthly", "anniversary", "none"];
export const HOLIDAY_KINDS: readonly string[] = ["public", "joint_leave", "company"];
export const GRADE_TRACKS: readonly string[] = ["individual", "management", "executive", "support"];
export const PARAMETER_UNITS: readonly string[] = ["rate", "amount", "months", "years", "count"];

/** ISO day numbers, as the server stores a calendar's weekend (1 = Monday ... 7 = Sunday). */
export const WEEKDAYS: readonly { value: number; label: string }[] = [
  { value: 1, label: "Mon" }, { value: 2, label: "Tue" }, { value: 3, label: "Wed" }, { value: 4, label: "Thu" },
  { value: 5, label: "Fri" }, { value: 6, label: "Sat" }, { value: 7, label: "Sun" },
];

/** Leave is charged in minutes; 480 minutes is one working day (the unit migration 0028 charges leave in). */
export const MINUTES_PER_DAY = 480;

/** The statuses an employee may be picked in. The server accepts any non-deleted employee; this keeps leavers out of the list. */
export const PICKABLE_EMPLOYEE_STATUSES: readonly string[] = ["active", "on_leave"];

/** How many parameter rows the "add a parameter set" form starts with (more can be added). */
export const INITIAL_PARAMETER_ROWS = 3;

/** A leave figure in working days, as the edit form shows it (the server stores minutes). */
export const minutesToDayValue = (minutes: number): string => String(Number((minutes / MINUTES_PER_DAY).toFixed(3)));
