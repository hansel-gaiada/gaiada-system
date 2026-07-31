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
import { ProjectCharts } from "@/components/reports/GrainCharts";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function scopeHref(periodKind: string, start: string, end: string, scopeRef: string): string {
  const qs = new URLSearchParams({ periodKind, start, end, scopeRef });
  return `/reports/project?${qs.toString()}`;
}

// Mirrors `KpiTiles`' own (private) `formatValue` — this scope-picker card uses the plain `KpiTile`
// primitive instead of the full chart kit, so it needs the same percent/minutes formatting rather
// than a raw fraction or an unlabelled minute count.
function formatKpiValue(unit: string, value: number): string {
  if (unit === "percent") return `${Math.round(value * 100)}%`;
  if (unit === "minutes") return `${Math.round(value).toLocaleString()}m`;
  return value.toLocaleString();
}

// Project-grain report. No single scopeRef is implied by "which project" the way person defaults
// to self — so with none in the URL this renders the §6.2 `overview` listing (console landing,
// "list of scopes + headline KPIs for the grain") as a scope picker; picking one re-navigates with
// `?scopeRef=` set, same URL-is-the-state-machine convention the period range already uses.
export default async function ProjectReportPage({
  searchParams,
}: {
  searchParams: Promise<{ periodKind?: string; start?: string; end?: string; scopeRef?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Reports" title="Project Reports" />
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
      const overview = await getReportOverview(tenant, userId, { grain: "project", periodKind, start, end });
      return (
        <>
          <PageHeader eyebrow="Reports" title="Project Reports" subtitle="Choose a project to see its report." />
          {overview.scopes.length === 0 ? (
            <EmptyNote>No projects have report data yet for this period.</EmptyNote>
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
            <PageHeader eyebrow="Reports" title="Project Reports" />
            <ReportAccessDenied reason="You can only view reports for projects you're a member of, or your own unit's projects (§8)." />
          </>
        );
      }
      if (isRangeTooLarge(e)) {
        return (
          <>
            <PageHeader eyebrow="Reports" title="Project Reports" />
            <ReportRangeError days={dayCountOf(start, end)} />
          </>
        );
      }
      throw e;
    }
  }

  const scopeRef = sp.scopeRef;
  try {
    const document = await getReportDocument(tenant, userId, { grain: "project", scopeRef, periodKind, start, end });
    return (
      <>
        <PageHeader
          eyebrow="Reports"
          title={document.header.scopeName}
          subtitle="Project delivery, throughput, and overdue work over the selected period."
          actions={<Link href="/reports/project" className="lux-btn lux-btn--ghost lux-btn--sm">Change project</Link>}
        />
        <ReportPageClient document={document} todayIso={today}>
          <ProjectCharts document={document} />
        </ReportPageClient>
      </>
    );
  } catch (e) {
    if (isForbidden(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title="Project Reports" />
          <ReportAccessDenied reason="You can only view reports for projects you're a member of, or your own unit's projects (§8)." />
        </>
      );
    }
    if (isRangeTooLarge(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title="Project Reports" />
          <ReportRangeError days={dayCountOf(start, end)} />
        </>
      );
    }
    throw e;
  }
}
