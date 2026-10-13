// One KPI cell of the Team report (`app/(app)/reports/team`, DW-4b). Pure, so the page's honesty rules are
// testable without rendering a server component.
//
// A ratio carries its parts (§5.2 of the reporting blueprint). When the denominator is 0 there was nothing to
// measure (an active person who completed no task with a due date has no on-time rate), and the server's
// `value` is then 0. Printing it would read as "0% on time", so the cell says "—" instead (DW-4l). The KPI
// tiles avoid the same trap by printing `n/d` beside the value; a one-line table cell has no room for that.
import type { ReportKpi } from "./reports";

export const NO_DATA = "—";

export function formatTeamKpi(kpi: ReportKpi | undefined): string {
  if (!kpi) return NO_DATA;
  if (kpi.denominator === 0) return NO_DATA;
  if (kpi.unit === "percent") return `${Math.round(kpi.value * 100)}%`;
  if (kpi.unit === "minutes") return `${Math.round(kpi.value).toLocaleString()}m`;
  return kpi.value.toLocaleString();
}
