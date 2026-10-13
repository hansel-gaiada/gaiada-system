import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getReportOverview, isForbidden, isNotFound, isRangeTooLarge } from "@/lib/reports-data";
import { dayCountOf, type ReportPeriodKind } from "@/lib/reports";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { ReportRangeError } from "@/components/reports/ReportRangeError";
import { ReportPeriodBar } from "@/components/reports/ReportPeriodBar";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function teamHref(periodKind: string, start: string, end: string, unit: string): string {
  const qs = new URLSearchParams({ unit, periodKind, start, end });
  return `/reports/team?${qs.toString()}`;
}

function personHref(periodKind: string, start: string, end: string, scopeRef: string): string {
  const qs = new URLSearchParams({ periodKind, start, end, scopeRef });
  return `/reports/person?${qs.toString()}`;
}

// Mirrors `KpiTiles`' own (private) `formatValue` and the department page's copy of it.
function formatKpiValue(unit: string, value: number): string {
  if (unit === "percent") return `${Math.round(value * 100)}%`;
  if (unit === "minutes") return `${Math.round(value).toLocaleString()}m`;
  return value.toLocaleString();
}

const TITLE = "Team Reports";
const DENIED = "Team reports are limited to the head of that department, group executives, or HR (§8).";
const NO_ACTIVITY = "No activity in this period";

// Team reports (DW-4b, BFF §37): everyone in one department, for the period. With `?unit=` it lists the
// unit's WHOLE roster from `overview?grain=person&unit=` (a person with no activity is listed, as "No
// activity in this period", never as zeros). Without `unit` it is the department picker, which lists
// only departments that have activity in the period, so its empty state must not claim "no team".
export default async function TeamReportPage({
  searchParams,
}: {
  searchParams: Promise<{ unit?: string; periodKind?: string; start?: string; end?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Reports" title={TITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const today = todayIso();
  const periodKind = (sp.periodKind as ReportPeriodKind | undefined) ?? "month";
  const start = sp.start ?? today;
  const end = sp.end ?? today;

  if (!sp.unit) {
    try {
      const overview = await getReportOverview(tenant, userId, { grain: "department", periodKind, start, end });
      return (
        <>
          <PageHeader eyebrow="Reports" title={TITLE} subtitle="Choose a department to see its people's reports." />
          <ReportPeriodBar value={{ kind: overview.periodKind, start: overview.start, end: overview.end }} todayIso={today} />
          {overview.scopes.length === 0 ? (
            <EmptyNote>No department you may read has activity in this period.</EmptyNote>
          ) : (
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
              {overview.scopes.map((s) => (
                <Card key={s.scopeRef} title={s.scopeName}>
                  <Link href={teamHref(periodKind, start, end, s.scopeRef)} className="lux-btn lux-btn--ghost lux-btn--sm">
                    View team
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
            <PageHeader eyebrow="Reports" title={TITLE} />
            <ReportAccessDenied reason={DENIED} />
          </>
        );
      }
      if (isRangeTooLarge(e)) {
        return (
          <>
            <PageHeader eyebrow="Reports" title={TITLE} />
            <ReportRangeError days={dayCountOf(start, end)} />
          </>
        );
      }
      throw e;
    }
  }

  try {
    const overview = await getReportOverview(tenant, userId, { grain: "person", unit: sp.unit, periodKind, start, end });
    const scopes = overview.scopes;
    // The headline KPIs are the same three for everyone, so the columns come from the first person who
    // has any; a person without activity carries none and shows the no-activity text instead.
    const kpiColumns = (scopes.find((s) => s.kpis.length > 0)?.kpis ?? []).map((k) => ({ metricKey: k.metricKey, label: k.label }));
    const columns = [
      { label: "Person" },
      ...(kpiColumns.length > 0 ? kpiColumns.map((k) => ({ label: k.label, align: "right" as const })) : [{ label: "Activity" }]),
      { label: "Report" },
    ];
    const rows = scopes.map((s) => {
      const idle = s.activity === false || s.kpis.length === 0;
      const cells =
        kpiColumns.length === 0
          ? [NO_ACTIVITY]
          : kpiColumns.map((col, i) => {
              if (idle) return i === 0 ? NO_ACTIVITY : "—";
              const k = s.kpis.find((x) => x.metricKey === col.metricKey);
              return k ? formatKpiValue(k.unit, k.value) : "—";
            });
      return [
        s.scopeName,
        ...cells,
        <Link key="open" href={personHref(overview.periodKind, overview.start, overview.end, s.scopeRef)} className="lux-btn lux-btn--ghost lux-btn--sm">
          Open report
        </Link>,
      ];
    });
    const changeQs = new URLSearchParams({ periodKind: overview.periodKind, start: overview.start, end: overview.end });
    return (
      <>
        <PageHeader
          eyebrow="Reports"
          title={TITLE}
          subtitle="Everyone in the department, with their headline numbers for the selected period."
          actions={<Link href={`/reports/team?${changeQs.toString()}`} className="lux-btn lux-btn--ghost lux-btn--sm">Change department</Link>}
        />
        <ReportPeriodBar value={{ kind: overview.periodKind, start: overview.start, end: overview.end }} todayIso={today} />
        {scopes.length === 0 ? (
          <EmptyNote>Nobody is placed in this department.</EmptyNote>
        ) : (
          <HairlineTable columns={columns} rows={rows} tcols={`2fr repeat(${columns.length - 2}, 1fr) auto`} />
        )}
      </>
    );
  } catch (e) {
    if (isForbidden(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title={TITLE} />
          <ReportAccessDenied reason={DENIED} />
        </>
      );
    }
    if (isNotFound(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title={TITLE} />
          <EmptyNote>This department does not exist.</EmptyNote>
        </>
      );
    }
    if (isRangeTooLarge(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title={TITLE} />
          <ReportRangeError days={dayCountOf(start, end)} />
        </>
      );
    }
    throw e;
  }
}
