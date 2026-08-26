import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { getReportDocument, isForbidden, isRangeTooLarge } from "@/lib/reports-data";
import { dayCountOf, type ReportPeriodKind } from "@/lib/reports";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { ReportRangeError } from "@/components/reports/ReportRangeError";
import { ReportPageClient } from "@/components/reports/ReportPageClient";
import { CompanyCharts } from "@/components/reports/GrainCharts";
import { GM_DEFAULT_PERIOD, parseGmPeriodKind } from "@/lib/gm";
import { resolveGmTab, GmTabRefusal } from "@/components/departments/gm/gmTab";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ periodKind?: string; start?: string; end?: string; period?: string }>;

const TITLE = "Business Review";

// GM console → Command → Business Review (GM-05).
//
// ── THE SAME DOCUMENT AS /reports/company, NOT A SECOND OPINION ───────────────────────────────────
// This tab renders the company-grain `ReportDocument` through the EXACT component stack
// `/reports/company` uses — `ReportPageClient` wrapping `CompanyCharts`, which is `RevisionNote` +
// `ReportViewer` + the chart kit. No adapter, no local layout, no re-derived figures.
//
// That is the whole point. A GM who reads a number here and then opens the company report must see
// the same number, with the same seal state, the same `AD HOC · UNSEALED` marking, and the same
// appraisal-safety marks on the same KPIs. Composing the shared components guarantees that by
// construction; a bespoke "executive layout" over the same endpoint would only guarantee it until the
// first divergent change.
//
// ── WHAT THIS TAB ADDS OVER /reports/company ──────────────────────────────────────────────────────
// Two things, and both are context rather than data:
//   1. **Cadence.** The default period is the WEEK (OQ-2 — the operating-cadence literature this
//      console is modelled on treats the weekly review as the primary rhythm), where
//      `/reports/company` defaults to the month. Same document, different default question.
//   2. **Place.** It sits inside the GM console next to the department strip and the decision queue,
//      so the review is one click from the things it raises questions about.
//
// ── PERIOD PARAMS: TWO CALLERS, ONE URL ───────────────────────────────────────────────────────────
// `ReportPageClient` owns the period control and writes `periodKind` + `start` + `end` into the URL
// itself (see its `onChange`). The GM cockpit, meanwhile, links here with the console's own
// `?period=week|month` shorthand. Both must work, so `periodKind` — the selector's key, and the more
// specific claim — WINS, and `period` is only the fallback for an arriving cockpit link. Getting this
// backwards would make the selector appear broken: every change would be overwritten by the
// shorthand still sitting in the query string.
export default async function GmBusinessReviewPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { deptId } = await params;
  // `companyGrainOnly` (GM-02b): this tab's entire subject is the company as a whole. A narrowed
  // department lead is refused with the "company-only" wording — NOT the console-wide "limited to
  // group executives", which would imply they should not be in the console at all, and NOT a
  // department-scoped stand-in rendered under a company-titled heading.
  const ctx = await resolveGmTab(deptId, { companyGrainOnly: true });
  if (!ctx.ok) return <GmTabRefusal reason={ctx.reason} title={TITLE} />;

  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  // `periodKind` first (the selector), then `period` (a cockpit link), then the console default.
  // Only `periodKind` may carry `day`/`custom` — those are real ReportPeriodKinds the viewer's own
  // selector can legitimately produce, whereas `parseGmPeriodKind` deliberately narrows the
  // console's shorthand to week|month.
  const periodKind: ReportPeriodKind = sp.periodKind
    ? (sp.periodKind as ReportPeriodKind)
    : sp.period
      ? parseGmPeriodKind(sp.period)
      : GM_DEFAULT_PERIOD;
  const start = sp.start ?? today;
  const end = sp.end ?? today;

  try {
    const document = await getReportDocument(ctx.tenantId, ctx.userId, {
      grain: "company",
      // The controller requires `scopeRef === tenantId` at this grain — there is no scope to pick.
      scopeRef: ctx.tenantId,
      periodKind,
      start,
      end,
    });
    return (
      <ReportPageClient document={document} todayIso={today}>
        <CompanyCharts document={document} />
      </ReportPageClient>
    );
  } catch (e) {
    if (isForbidden(e)) {
      // Reached only if the console gate and the report matrix ever disagree — the gate is
      // `reports.company.view`, which is this exact boundary. Rendered rather than swallowed
      // precisely so that a future divergence surfaces as a message instead of a blank tab.
      return <ReportAccessDenied reason="Company-grain reports are limited to group executives (§8)." />;
    }
    if (isRangeTooLarge(e)) return <ReportRangeError days={dayCountOf(start, end)} />;
    // Every other failure: a note plus the door to the surface that owns this document, rather than
    // an error page inside a console tab.
    return (
      <Card title={TITLE} headerRight={
        <Link href="/reports/company" className="lux-btn lux-btn--ghost lux-btn--sm">Company report</Link>
      }>
        <EmptyNote>
          The company report could not be read for this period — a failed read, not an empty period.
        </EmptyNote>
      </Card>
    );
  }
}
