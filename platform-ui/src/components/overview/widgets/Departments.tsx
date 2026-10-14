import type { OverviewWidgetProps } from "./index";
import { readDeptKpiOverview } from "@/lib/overviewDepartments-data";
import { departmentsView } from "@/lib/overviewDepartments";
import { companyAccess } from "@/lib/overviewCompany";
import { reportPeriodKind, todayIso } from "@/lib/overviewNumbers";
import { DepartmentsBlock } from "./CompanyBlocks";

// DW-3i: "Departments by condition", the Department band's second block: one row per department with its condition (on track,
// at risk or off track) and the KPI driving it, worst first, then the departments with no condition yet (BFF §40, plan §5.5).
// `GET dept-kpis/overview` is the company-wide tiers' read, so the block is placed only for the cockpit's "full" access. A
// department with no approved target has no condition: it says "No target set" and goes last, never a rating the server did not give.
export async function Departments({ me, tenantId, period }: OverviewWidgetProps) {
  if (!companyAccess(me, tenantId).numbers) return null;
  const result = await readDeptKpiOverview(me.userId, tenantId, reportPeriodKind(period), todayIso());
  return <DepartmentsBlock view={departmentsView(result)} />;
}
