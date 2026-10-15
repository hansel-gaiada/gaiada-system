// DW-7j (docs/FRONTEND-BFF-CONTRACT.md §40.6.1, DW-D30): "within N working days of X". PURE: no database, no clock, no zone.
//
// The deadline of a request created on the calendar day D is the END of the Nth working day after D. This returns that day as an
// ISO date; a timestamp is on time when its date in REPORTS_TZ is on or before it, and the deadline is "already due" when it is on
// or before `asOf` (§40.5.1). Working days are decided by hr/working-days.ts (`countWorkingDays`), so a weekend or a holiday is the
// same thing here as in leave and payroll: weekends first, then any holiday, whatever its kind. HR's f3 reuses this.
import { addDays, countWorkingDays, type WorkingCalendar } from "../../../hr/working-days";

/** A calendar with no working day would never end the search; this many days past `from` is the most it looks. */
const SEARCH_LIMIT_DAYS = 800;

/**
 * The date of the `n`th working day strictly AFTER `fromIso` (a day the calendar counts as neither weekend nor holiday).
 * `fromIso` itself never counts, even when it is a working day. `n <= 0` returns `fromIso`. A calendar that never works
 * (every weekday listed as a weekend) returns the last day searched rather than looping.
 */
export function nthWorkingDayAfter(fromIso: string, n: number, calendar: WorkingCalendar = {}): string {
  let cursor = fromIso;
  let found = 0;
  for (let i = 0; i < SEARCH_LIMIT_DAYS && found < n; i++) {
    cursor = addDays(cursor, 1);
    if (countWorkingDays(cursor, cursor, calendar).workingDays === 1) found += 1;
  }
  return cursor;
}

/** `nthWorkingDayAfter`, memoised per created day: a window's rows share a handful of days. */
export function deadlineResolver(n: number, calendar: WorkingCalendar): (createdDay: string) => string {
  const memo = new Map<string, string>();
  return (createdDay) => {
    let d = memo.get(createdDay);
    if (d === undefined) {
      d = nthWorkingDayAfter(createdDay, n, calendar);
      memo.set(createdDay, d);
    }
    return d;
  };
}
