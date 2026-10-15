import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getReportOverview, isForbidden, isNotFound, isRangeTooLarge } from "@/lib/reports-data";
import { dayCountOf, formatDateRange, type ReportPeriodKind } from "@/lib/reports";
import { formatPeriodLabel } from "@/lib/reportCalendar";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { ReportRangeError } from "@/components/reports/ReportRangeError";
import { ReportPeriodBar } from "@/components/reports/ReportPeriodBar";
import { PrintButton } from "@/components/reports/PrintButton";
import { formatTeamKpi, NO_DATA } from "@/lib/teamReport";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function teamHref(periodKind: string, start: string, end: string, unit: string): string {
  const qs = new URLSearchParams({ unit, periodKind, start, end });
  return `/reports/team?${qs.toString()}`;
}

function departmentReportHref(periodKind: string, start: string, end: string, scopeRef: string): string {
  const qs = new URLSearchParams({ periodKind, start, end, scopeRef });
  return `/reports/department?${qs.toString()}`;
}

// The period as the page's text, for the printed copy (the period bar does not print).
function periodText(periodKind: ReportPeriodKind, start: string, end: string): string {
  return periodKind === "custom" ? formatDateRange(start, end) : formatPeriodLabel(periodKind, start, end);
}

function personHref(periodKind: string, start: string, end: string, scopeRef: string): string {
  const qs = new URLSearchParams({ periodKind, start, end, scopeRef });
  return `/reports/person?${qs.toString()}`;
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
          <PageHeader eyebrow="Reports" title={TITLE} subtitle="Choose a department to see its people's reports." actions={<PrintButton />} />
          <p className="rp-printonly">{periodText(overview.periodKind, overview.start, overview.end)}</p>
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
              if (idle) return i === 0 ? NO_ACTIVITY : NO_DATA;
              // A ratio with nothing to measure (denominator 0) reads "—", never "0%" (DW-4l).
              return formatTeamKpi(s.kpis.find((x) => x.metricKey === col.metricKey));
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
          actions={
            <>
              {/* DW-4k: a roster is not one document, so there is no team export (the server builds none). The
                  department's own report is the document that exports, for the same unit and period. */}
              <Link href={departmentReportHref(overview.periodKind, overview.start, overview.end, sp.unit)} className="lux-btn lux-btn--ghost lux-btn--sm">
                Export the department report
              </Link>
              <PrintButton />
              <Link href={`/reports/team?${changeQs.toString()}`} className="lux-btn lux-btn--ghost lux-btn--sm">Change department</Link>
            </>
          }
        />
        <p className="rp-printonly">{periodText(overview.periodKind, overview.start, overview.end)}</p>
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
