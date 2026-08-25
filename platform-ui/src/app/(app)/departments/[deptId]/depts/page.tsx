import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { getReportOverview, isForbidden, isRangeTooLarge } from "@/lib/reports-data";
import { parseGmPeriodKind } from "@/lib/gm";
import { resolveGmTab, GmTabRefusal } from "@/components/departments/gm/gmTab";
import { GmDeptStrip } from "@/components/departments/gm/GmDeptStrip";
import { GmProvenance } from "@/components/departments/gm/GmProvenance";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ period?: string }>;

const TITLE = "Departments";

// GM console → Oversight → Departments (GM-04).
//
// The cockpit's Tier-2 strip capped at four metric columns because it is a scan. This tab is the
// same read with the cap lifted: every metric the registry reports for the department grain, one row
// per department, drilling into each department's own report.
//
// No new endpoint and no new math — deliberately. The department-grain `reports/overview` already
// answers "how is each department doing" in a single call, and computing a second, parallel answer
// here from PM tasks would produce two numbers for one question that disagree at the margins.
export default async function GmDepartmentsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { deptId } = await params;
  const ctx = await resolveGmTab(deptId);
  if (!ctx.ok) return <GmTabRefusal reason={ctx.reason} title={TITLE} />;

  const { period } = await searchParams;
  const periodKind = parseGmPeriodKind(period);
  const anchor = new Date().toISOString().slice(0, 10);

  try {
    const overview = await getReportOverview(ctx.tenantId, ctx.userId, {
      grain: "department",
      periodKind,
      start: anchor,
      end: anchor,
    });
    return (
      <>
        <GmProvenance
          periodKind={periodKind}
          start={overview.start}
          end={overview.end}
          documentHref="/reports/department"
        />
        <Card
          title={TITLE}
          headerRight={
            <Link href={`/departments/${deptId}?period=${periodKind}`} className="lux-btn lux-btn--ghost lux-btn--sm">
              Back to cockpit
            </Link>
          }
        >
          {/* Every column the registry reports. `Number.MAX_SAFE_INTEGER` rather than a large
              literal: the point is "no cap", and a literal invites someone to tune it. */}
          <GmDeptStrip
            scopes={overview.scopes}
            limit={Number.MAX_SAFE_INTEGER}
            hrefFor={(scopeRef) =>
              `/reports/department?${new URLSearchParams({
                periodKind,
                start: overview.start,
                end: overview.end,
                scopeRef,
              }).toString()}`
            }
          />
        </Card>
      </>
    );
  } catch (e) {
    // Same three-outcome discipline as the cockpit: a refused read and an empty one are different
    // facts, and neither is "[]".
    if (isForbidden(e)) return <GmTabRefusal reason="denied" title={TITLE} />;
    if (isRangeTooLarge(e)) {
      return (
        <Card title={TITLE}>
          <EmptyNote>The selected period is too long for department figures to be computed.</EmptyNote>
        </Card>
      );
    }
    return (
      <Card title={TITLE}>
        <EmptyNote>Department figures could not be read just now. This is a failed read, not an empty business.</EmptyNote>
      </Card>
    );
  }
}
