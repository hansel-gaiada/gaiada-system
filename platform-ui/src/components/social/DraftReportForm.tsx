"use client";
// SCP-5a (BFF §63.18): "Draft this month's report", for an officer: pick one of your clients and the month, and the report is drafted (the numbers frozen, the narrative, the three notes and the
// action plan, by the model or by the plain template) and opened. Idempotent: a client's report for a month that already exists is opened as it is. The last month is the default because a
// monthly report is due in the month after its period.
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefusalNote } from "@/components/social/PostRefusal";
import { draftReport } from "@/lib/socialReportsActions";
import { newUuid, shiftMonth } from "@/lib/socialClient";
import { periodWords, reportHref } from "@/lib/socialReports";
import type { Refusal } from "@/lib/socialPipeline";
import "./cycles.css";
import "./reports.css";

export interface DraftableClient { engagementId: string; clientName: string }

export function DraftReportForm({ deptId, clients, thisMonth }: { deptId: string; clients: readonly DraftableClient[]; thisMonth: string }) {
  const uid = useId();
  const router = useRouter();
  const [engagementId, setEngagementId] = useState(clients[0]?.engagementId ?? "");
  const [period, setPeriod] = useState(shiftMonth(thisMonth, -1));
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [pending, start] = useTransition();
  if (clients.length === 0) return null;

  function draft() {
    setRefusal(null);
    start(async () => {
      const r = await draftReport(engagementId, "monthly", period, newUuid());
      if (!r.ok) { setRefusal({ refusal: r.refusal, message: r.message }); return; }
      router.push(reportHref(deptId, r.report.id));
    });
  }

  return (
    <form className="scp-reports__draft" aria-label="Draft a monthly report" onSubmit={(e) => { e.preventDefault(); draft(); }}>
      <div className="scp-field">
        <label htmlFor={`${uid}-client`}>Client</label>
        <select id={`${uid}-client`} className="scp-input" value={engagementId} onChange={(e) => setEngagementId(e.target.value)}>
          {clients.map((c) => <option key={c.engagementId} value={c.engagementId}>{c.clientName}</option>)}
        </select>
      </div>
      <div className="scp-field">
        <label htmlFor={`${uid}-period`}>Month</label>
        <select id={`${uid}-period`} className="scp-input" value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value={shiftMonth(thisMonth, -1)}>{periodWords(shiftMonth(thisMonth, -1))} (due now)</option>
          <option value={thisMonth}>{periodWords(thisMonth)} (so far)</option>
        </select>
      </div>
      <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !engagementId}>{pending ? "Drafting…" : "Draft this month's report"}</button>
      <span className="scp-field__hint">A client with a report for that month gets that report opened, not a second one.</span>
      {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
    </form>
  );
}
