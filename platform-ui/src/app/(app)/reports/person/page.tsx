import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getReportDocument, isForbidden, isRangeTooLarge } from "@/lib/reports-data";
import { dayCountOf, type ReportPeriodKind } from "@/lib/reports";
import { getCheckinHistory } from "@/lib/checkins-data";
import { buildCalendarDays, type CheckinDay } from "@/lib/checkins";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { ReportRangeError } from "@/components/reports/ReportRangeError";
import { ReportPageClient } from "@/components/reports/ReportPageClient";
import { PersonCharts } from "@/components/reports/GrainCharts";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Person-grain report (§7/§8). Defaults to the caller's OWN report — the one document every
// principal can always read (§8: "Self (member) ✅ own only") — and accepts `?scopeRef=<userId>`
// so a lead/exec/HR reader can view someone else's (server-enforced by Cerbos; this page never
// second-guesses that, it just renders whatever the BFF answers or denies).
export default async function PersonReportPage({
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
        <PageHeader eyebrow="Reports" title="My Report" />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const today = todayIso();
  const periodKind = (sp.periodKind as ReportPeriodKind | undefined) ?? "month";
  const start = sp.start ?? today;
  const end = sp.end ?? today;
  const scopeRef = sp.scopeRef ?? userId;
  const viewingSelf = scopeRef === userId;

  try {
    const document = await getReportDocument(tenant, userId, { grain: "person", scopeRef, periodKind, start, end });

    // TR-38 — the check-in `CalendarHeatmap`, sourced from a SEPARATE endpoint outside
    // `ReportDocument` (§6.2's `GET /checkins`, self-permitted history — NOT the lead/exec/HR-only
    // `/checkins/compliance` grid; see lib/checkins.ts's header comment on why). Its own try/catch,
    // deliberately separate from the document fetch above: an authz/availability wrinkle here
    // (e.g. this reader's grant covers the report but not this narrower `checkin` resource kind)
    // degrades by simply omitting the section, never by failing the whole report page.
    let checkinDays: CheckinDay[] | undefined;
    try {
      const history = await getCheckinHistory(tenant, userId, {
        subjectUserId: scopeRef, from: document.header.periodStart, to: document.header.periodEnd,
      });
      checkinDays = buildCalendarDays(history.checkins, document.header.periodStart, document.header.periodEnd);
    } catch {
      checkinDays = undefined;
    }

    return (
      <>
        <PageHeader
          eyebrow="Reports"
          title={viewingSelf ? "My Report" : `${document.header.scopeName}'s Report`}
          subtitle="Individual activity, throughput, and on-time delivery over the selected period."
        />
        <ReportPageClient document={document} todayIso={today}>
          <PersonCharts document={document} checkinDays={checkinDays} />
        </ReportPageClient>
      </>
    );
  } catch (e) {
    if (isForbidden(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title="My Report" />
          <ReportAccessDenied reason="You can only view your own person-grain report unless you're that person's department lead, a group executive, or in HR (§8)." />
        </>
      );
    }
    if (isRangeTooLarge(e)) {
      return (
        <>
          <PageHeader eyebrow="Reports" title="My Report" />
          <ReportRangeError days={dayCountOf(start, end)} />
        </>
      );
    }
    throw e;
  }
}
