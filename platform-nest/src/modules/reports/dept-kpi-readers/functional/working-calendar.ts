// DW-7j (docs/FRONTEND-BFF-CONTRACT.md §40.6.1): the company's working calendar for a functional KPI reader. The same rule HR's
// `loadCalendar` (hr/hr-policy.controller.ts) uses: the company's DEFAULT, not deleted, holiday calendar (HR › Settings): its
// weekend days and its holidays. A company with no default calendar works Monday to Friday with no holidays.
//
// Not imported from the HR controller on purpose: that file pulls the whole Nest controller graph into the reports module and
// into the pure registry test. The two queries are the same two statements; the DB test pins the default-calendar rule.
//
// The tables are walled to the `hr` module (`app_module_allowed('hr')`), so this declares that scope. It does NOT require the
// company to have HR: a company without it has no calendar rows and reads the Monday-to-Friday default.
import { withTenants } from "../../../../db";
import type { WorkingCalendar } from "../../../hr/working-days";

/** The calendar for holidays between `fromIso` and `toIso` (inclusive ISO dates). */
export async function loadWorkingCalendar(tenantId: string, fromIso: string, toIso: string): Promise<WorkingCalendar> {
  return withTenants(
    [tenantId],
    async (c) => {
      const cal = await c.query<{ id: string; weekend_days: number[] | null }>(
        `SELECT id, weekend_days FROM hr_holiday_calendars WHERE tenant_id = $1::uuid AND is_default AND deleted_at IS NULL LIMIT 1`,
        [tenantId],
      );
      const found = cal.rows[0];
      if (!found) return {};
      const holidays = await c.query<{ day: string; kind: "public" | "joint_leave" | "company" }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, kind
           FROM hr_holidays
          WHERE tenant_id = $1::uuid AND calendar_id = $2::uuid AND day BETWEEN $3::date AND $4::date`,
        [tenantId, found.id, fromIso, toIso],
      );
      return {
        weekendDays: found.weekend_days ?? undefined,
        holidays: holidays.rows.map((h) => ({ day: h.day, kind: h.kind })),
      };
    },
    { modules: ["hr"] },
  );
}
