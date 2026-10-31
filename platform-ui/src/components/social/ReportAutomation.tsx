// SCP-5 W5-A6 (BFF §63.24.9) — the "Report automation" section of {D}/settings, in its own file so the company-rules sections (W5-C5) can sit beside it without touching it.
//
// Shown to the people the server lets read schedules (the four: `social_engagement` · `plan`), and hidden otherwise: the page reads only for a person who `canPlan` (the server's own answer)
// and passes the read here, and a refused read draws nothing, because a section that said "no schedules" to someone who may not look would imply there is nothing. A failed read says it cannot
// tell, never an empty list. The component is not async: the page's tests render it in a browser DOM, which cannot render an async component.
import type { ReadResult } from "@/lib/readResult";
import type { ReportSchedule } from "@/lib/socialReportSchedules";
import { ReportAutomationBoard } from "@/components/social/ReportAutomationBoard";
import type { ClientOption } from "@/components/social/ReportScheduleDialog";
import "@/components/social/cycles.css";
import "@/components/social/reportAutomation.css";

export function ReportAutomation({ deptId, schedules, clients }: {
  deptId: string;
  /** `GET report-schedules` as the page read it, or null when the person may not plan (nothing was read). */
  schedules: ReadResult<ReportSchedule[]> | null;
  /** The open clients of the company, for the picker; null when they could not be read. */
  clients: ClientOption[] | null;
}) {
  if (schedules === null || schedules.kind === "forbidden") return null;
  return (
    <section aria-labelledby="scp-auto-title" className="scp-slot" data-slot="report-automation">
      <h3 className="scp-slot__title" id="scp-auto-title">Report automation</h3>
      <p className="scp-note" style={{ marginTop: 0, marginBottom: 12 }}>
        Have the ERP draft a kind of report by itself, every period, for the period that has just ended. It only drafts: approving, sending back and sending stay with the four. Each schedule has an
        owner, and its runs act as them. AI spend is tracked for every run and is never capped.
      </p>
      {schedules.kind === "unavailable"
        ? <p className="scp-note" role="status">The report schedules cannot be shown right now ({schedules.reason}). They are not gone; try again in a moment.</p>
        : <ReportAutomationBoard deptId={deptId} schedules={schedules.data} clients={clients} />}
    </section>
  );
}
