import type { OverviewWidgetProps } from "./index";
import { getReportDocument } from "@/lib/reports-data";
import { readResult } from "@/lib/readResult";
import { readCompanyMoney } from "@/lib/overviewCompany-data";
import { reportPeriodKind, todayIso } from "@/lib/overviewNumbers";
import { resolveCalendarRange, type CalendarKind } from "@/lib/reportCalendar";
import { buildCompany, companyAccess } from "@/lib/overviewCompany";
import { CompanyBlock } from "./CompanyBlocks";

// DW-3i: "Company", the Department band's first block on the company Overview: revenue, overdue receivables, milestones hit and
// utilization for the selected period. Two parts, each behind the cockpit's own gate (`companyAccess`, lib/gm.ts):
//   - money (revenue, overdue receivables): console access AND the finance read capability, the cockpit's `GmMoneyCard` reads;
//   - company figures (milestones hit, utilization): the cockpit's "full" access, `GET reports/document?grain=company`.
// A part the person may not see is NOT READ and not drawn (never "No access"); with neither part, no block. Each part that is read
// is honest: a refusal or a failure says so in its tile, never 0.
export async function Company({ me, tenantId, period }: OverviewWidgetProps) {
  const access = companyAccess(me, tenantId);
  if (!access.numbers && !access.money) return null;
  const today = todayIso();
  const periodKind = reportPeriodKind(period);
  // The money window is the calendar period, resolved by the same pure rule the reports backend uses.
  const range = resolveCalendarRange(periodKind as CalendarKind, today);
  const [document, money] = await Promise.all([
    access.numbers
      ? readResult(getReportDocument(tenantId, me.userId, { grain: "company", scopeRef: tenantId, periodKind, start: today, end: today }))
      : null,
    access.money ? readCompanyMoney(me.userId, tenantId, range.start, range.end) : null,
  ]);
  const model = buildCompany({ access, document, money, from: range.start, to: range.end });
  if (!model) return null;
  return (
    <CompanyBlock
      model={model}
      reportHref={`/reports/company?periodKind=${periodKind}&start=${today}`}
      financeHref="/finance/reports"
    />
  );
}
