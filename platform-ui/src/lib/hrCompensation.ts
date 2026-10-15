// HR › Compensation — the value sets the DW-7f-3 write screens share. No "server-only" and no "use server": the
// client forms import these too (a "use server" file may export only async functions). Backend: platform-nest
// src/modules/hr/payroll.controller.ts and migrations 202608240142_hr_compensation_benefits.sql and
// 202608260930_hr_rate_basis_and_pay_frequency.sql.
//
// Everything here MIRRORS what the server accepts. Where the server silently swaps an unknown value for a default
// (set compensation: rate basis, pay frequency and reason all fall back), the screen offers only the known values, so
// a typo can never be saved as something nobody chose.
export { RATE_BASES } from "./hrRecruitment";

export const PAY_FREQUENCIES: readonly string[] = ["weekly", "biweekly", "semi_monthly", "monthly"];
export const CHANGE_REASONS: readonly string[] = [
  "hire", "annual_review", "promotion", "market_adjustment", "demotion", "correction", "contract_renewal", "other",
];
export const ALLOWANCE_DIRECTIONS: readonly string[] = ["allowance", "deduction"];
export const CALC_KINDS: readonly string[] = ["fixed", "percentage", "formula"];
export const BENEFIT_KINDS: readonly string[] = ["statutory", "insurance", "pension", "wellness", "allowance_in_kind", "other"];
export const STATUTORY_CODES: readonly string[] = ["bpjs_kesehatan", "bpjs_jht", "bpjs_jp", "bpjs_jkk", "bpjs_jkm", "bpjs_jkp"];
export const PTKP_STATUSES: readonly string[] = [
  "TK/0", "TK/1", "TK/2", "TK/3", "K/0", "K/1", "K/2", "K/3", "K/I/0", "K/I/1", "K/I/2", "K/I/3",
];
export const TER_CATEGORIES: readonly string[] = ["A", "B", "C"];

export const label = (v: string): string => v.replace(/_/g, " ");

/** The statuses an employee may be picked in. The server accepts any non-deleted employee; this keeps leavers out of the list. */
export const PICKABLE_EMPLOYEE_STATUSES: readonly string[] = ["active", "on_leave"];
