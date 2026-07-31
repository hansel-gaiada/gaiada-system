import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getReportDocument, getReportOverview, isForbidden, isRangeTooLarge } from "@/lib/reports-data";
import { dayCountOf, type ReportPeriodKind } from "@/lib/reports";
import { PageHeader } from "@/components/PageHeader";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { ReportRangeError } from "@/components/reports/ReportRangeError";
import { ReportPageClient } from "@/components/reports/ReportPageClient";
import { DepartmentCharts } from "@/components/reports/GrainCharts";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function scopeHref(periodKind: string, start: string, end: string, scopeRef: string): string {
  const qs = new URLSearchParams({ periodKind, start, end, scopeRef });
  return `/reports/department?${qs.toString()}`;
}

// Mirrors `KpiTiles`' own (private) `formatValue` — see the identical helper on the project scope
// picker page for why this scope-picker card needs it too.
function formatKpiValue(unit: string, value: number): string {
  if (unit === "percent") return `${Math.round(value * 100)}%`;
  if (unit === "minutes") return `${Math.round(value).toLocaleString()}m`;
  return value.toLocaleString();
}

// Department-grain report (§8: lead of that unit, exec, or HR only — a plain member is denied, no
// self-view exists at this grain). Same overview-as-scope-picker shape as the project page.
export default async function DepartmentReportPage({
  searchParams,
}: {
  searchParams: Promise<{ periodKind?: string; start?: string; end?: string; scopeRef?: string; servedTenant?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Reports" title="Department Reports" />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const today = todayIso();
  const periodKind = (sp.periodKind as ReportPeriodKind | undefined) ?? "month";
  const start = sp.start ?? today;
  const end = sp.end ?? today;

  if (!sp.scopeRef) {
    try {
      const overview = await getReportOverview(tenant, userId, { grain: "department", periodKind, start, end });
      return (
        <>
          <PageHeader eyebrow="Reports" title="Department Reports" subtitle="Choose a department to see its report." />
          {overview.scopes.length === 0 ? (
            <EmptyNote>No departments have report data yet for this period.</EmptyNote>
          ) : (
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
              {overview.scopes.map((s) => (
                <Card key={s.scopeRef} title={s.scopeName}>
                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", marginBottom: 12 }}>
                    {s.kpis.map((k) => (
                      <KpiTile key={k.metricKey} label={k.label} value={formatKpiValue(k.unit, k.value)} />
                    ))}
                  </div>
                  <Link href={scopeHref(periodKind, start, end, s.scopeRef)} className="lux-btn lux-btn--ghost lux-btn--sm">
                    View report
                  </Link>
                </Card>
              ))}
            </div>
          )}
        </>
      );
    } catch (e) {
      if (isForbidden(e)) {
        return (
          <>
            <PageHeader eyebrow="Reports" title="Department Reports" />
            <ReportAccessDenied reason="Department reports are limited to that unit's lead, group executives, or HR (§8)." />
          </>
        );
      }
      if (isRangeTooLarge(e)) {
        return (
          <>
            <PageHeader eyebrow="Reports" title="Department Reports" />
            <ReportRangeError days={dayCountOf(start, end)} />
          </>
        );
      }
      throw e;
    }
  }

  const scopeRef = sp.scopeRef;
  try {
    const document = await getReportDocument(tenant, userId, { grain: "department", scopeRef, periodKind, start, end, servedTenant: sp.servedTenant });
    return (
      <>
        <PageHeader
          eyebrow="Reports"
          title={document.header.scopeName}
          subtitle="Department throughput, on-time delivery, and the served-companies split, over the selected period."
          actions={<Link href="/reports/department" className="lux-btn lux-btn--ghost lux-btn--sm">Change department</Link>}
        />
        <ReportPageClient document={document} todayIso={today}>
          <DepartmentCharts document={document} />
        </ReportPageClient>
      </>
    );
  } catch (e) {
    if (isForbidden(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title="Department Reports" />
          <ReportAccessDenied reason="Department reports are limited to that unit's lead, group executives, or HR (§8)." />
        </>
      );
    }
    if (isRangeTooLarge(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title="Department Reports" />
          <ReportRangeError days={dayCountOf(start, end)} />
        </>
      );
    }
    throw e;
  }
}
