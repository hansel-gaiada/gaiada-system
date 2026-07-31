import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { ReportDocument } from "@/lib/reports";
import { getPrintPayload, PrintTokenError } from "@/lib/reports-print-data";
import { ReportViewer } from "@/components/reports/ReportViewer";
import { PersonCharts, ProjectCharts, DepartmentCharts, CompanyCharts } from "@/components/reports/GrainCharts";
import { PrintMark } from "@/components/reports/print/PrintMark";
import { PrintRefusal } from "@/components/reports/print/PrintRefusal";
import "../../print.css";

// TR-20 — the print route (§6.3's flow, last hop): platform-nest mints a one-shot, 5-min-TTL,
// single-document `jobToken` and hands the `report-renderer` sidecar
// `PLATFORM_UI_INTERNAL_URL + /print/reports/{jobToken}`. The sidecar's Chromium (`report-renderer/
// src/server.ts`, TR-19, already shipped) `page.goto()`s straight here with NO cookies at all — this
// route's only credential is the token in its own URL.
//
// Deliberately lives OUTSIDE the `(app)` route group: `(app)/layout.tsx` renders the full ERP shell
// (nav, top bar, the `main.erp-main` scroll container the TR-17 landing note flags as a Playwright
// screenshot trap) — none of that belongs in a document a sidecar screenshots into a PDF, and
// skipping the group entirely means this page gets ONLY the root layout's bare `<html><body>`, never
// the app chrome, with no extra work. It also means no RBAC/company-context providers run here,
// which is correct: this route's only authorization boundary is the jobToken itself (checked below),
// not a signed-in principal's grants.
//
// Renders the SAME `ReportViewer` + per-grain `GrainCharts` composition (TR-16/TR-17) a browser user
// sees on `/reports/{person,project,department,company}` — never a forked/simplified print
// rendering, per §6.3's whole point ("renders the SAME viewer components"). Two deliberate omissions
// from what a live grain page additionally renders, both because they're navigation/interaction
// affordances that make no sense on a fixed, one-shot snapshot:
//   - `ReportPageClient`'s period-switcher wiring (`useRouter`/`useSearchParams`) — this document's
//     period is fixed by the export job, not user-adjustable, so `ReportViewer` is called directly
//     with no `periodControl` prop (it already renders nothing extra when that prop is omitted).
//   - `RevisionNote` — a revision-switching affordance for a document that, in print, only ever
//     shows the ONE revision it was exported at; it would also render a "Backend pending" note
//     (§6.2's period-history endpoints aren't live) that has no business appearing in a document
//     handed to management.
//   - Person grain's check-in `CalendarHeatmap` (fed by a SEPARATE endpoint outside `ReportDocument`,
//     per `GrainCharts.tsx`'s own comment) is omitted rather than fetched again here — TR-21's
//     print-payload contract carries one `ReportDocument`, and `PersonCharts` already degrades
//     correctly (renders nothing extra) when `checkinDays` isn't supplied.
export const metadata: Metadata = {
  title: "Report",
  robots: { index: false, follow: false },
};

function chartsFor(document: ReportDocument): ReactNode {
  switch (document.header.grain) {
    case "person": return <PersonCharts document={document} />;
    case "project": return <ProjectCharts document={document} />;
    case "department": return <DepartmentCharts document={document} />;
    case "company": return <CompanyCharts document={document} />;
    default: {
      const _exhaustive: never = document.header.grain;
      return _exhaustive;
    }
  }
}

export default async function PrintReportPage({
  params,
}: {
  params: Promise<{ jobToken: string }>;
}) {
  const { jobToken } = await params;

  let document: ReportDocument;
  let sealHash: string | undefined;
  try {
    const payload = await getPrintPayload(jobToken);
    document = payload.document;
    sealHash = payload.sealHash;
  } catch (e) {
    if (e instanceof PrintTokenError) {
      // Server-side only — never surfaced to whatever is looking at the render (see
      // PrintRefusal's own comment on why the on-page message stays generic).
      console.error(`[print/reports/${jobToken}] refusing to render (${e.reason}): ${e.message}`);
      return (
        <div className="tr20-print">
          <PrintRefusal />
        </div>
      );
    }
    throw e;
  }

  return (
    <div className="tr20-print">
      <PrintMark header={document.header} sealHash={sealHash} position="top" />
      <div className="tr20-print__body">
        <div className="tr20-print__scope">
          <ReportViewer document={document}>{chartsFor(document)}</ReportViewer>
        </div>
      </div>
      <PrintMark header={document.header} sealHash={sealHash} position="bottom" />
    </div>
  );
}
