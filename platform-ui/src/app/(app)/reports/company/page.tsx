import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getReportDocument, isForbidden, isRangeTooLarge } from "@/lib/reports-data";
import { dayCountOf, type ReportPeriodKind } from "@/lib/reports";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { ReportRangeError } from "@/components/reports/ReportRangeError";
import { ReportPageClient } from "@/components/reports/ReportPageClient";
import { CompanyCharts } from "@/components/reports/GrainCharts";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Company-grain report (§8: exec-only — the tightest tier in the matrix, no lead/HR carve-out).
// `scopeRef` is always the active tenant itself (the controller requires `scopeRef === tenantId`
// for this grain, §6.2's `getDocument` validation) — there is no scope to pick.
export default async function CompanyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ periodKind?: string; start?: string; end?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Reports" title="Company Report" />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const today = todayIso();
  const periodKind = (sp.periodKind as ReportPeriodKind | undefined) ?? "month";
  const start = sp.start ?? today;
  const end = sp.end ?? today;

  try {
    const document = await getReportDocument(tenant, userId, { grain: "company", scopeRef: tenant, periodKind, start, end });
    return (
      <>
        <PageHeader eyebrow="Reports" title={document.header.scopeName} subtitle="Company-wide delivery and department portfolio over the selected period." />
        <ReportPageClient document={document} todayIso={today}>
          <CompanyCharts document={document} />
        </ReportPageClient>
      </>
    );
  } catch (e) {
    if (isForbidden(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title="Company Report" />
          <ReportAccessDenied reason="Company-grain reports are limited to group executives (§8)." />
        </>
      );
    }
    if (isRangeTooLarge(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title="Company Report" />
          <ReportRangeError days={dayCountOf(start, end)} />
        </>
      );
    }
    throw e;
  }
}
