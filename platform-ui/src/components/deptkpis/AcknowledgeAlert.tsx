"use client";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acknowledgeKpiAlert } from "@/lib/deptKpiAlertActions";
import { ALERT_NOTE_MAX } from "@/lib/deptKpiAlertFormat";
import "./deptKpis.css";

/**
 * "Acknowledge" for one open alert (BFF §43.5): a head records that they have seen it. An optional note stays collapsed until asked
 * for. Shown to the head of the unit and the company-wide tiers; the server decides again and its sentence (403, 404, or the two 409
 * codes, worded by the action) is shown as it was said. The alert stays open until the daily run resolves it: acknowledging changes who
 * has seen it, not the KPI.
 */
export function AcknowledgeAlert({ tenantId, alertId, kpiLabel }: { tenantId: string; alertId: string; kpiLabel: string }) {
  const router = useRouter();
  const noteId = useId();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      const res = await acknowledgeKpiAlert(tenantId, alertId, note);
      if (res.ok) {
        setMsg(null);
        router.refresh();
      } else {
        setMsg(res.error ?? "Could not acknowledge the alert.");
      }
    });
  };

  return (
    <span className="dk-ack">
      <span className="dk-target__actions">
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
          aria-label={`Acknowledge the alert for ${kpiLabel}`} onClick={run}>
          {pending ? "Acknowledging…" : "Acknowledge"}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-expanded={noting} aria-controls={noteId}
          onClick={() => setNoting((n) => !n)}>
          {noting ? "Hide note" : "Add a note"}
        </button>
      </span>
      {noting && (
        <textarea id={noteId} className="dk-ack__note" rows={2} maxLength={ALERT_NOTE_MAX} value={note} placeholder="Note (optional)"
          aria-label={`Note for the alert on ${kpiLabel} (optional)`} onChange={(e) => setNote(e.target.value)} />
      )}
      {msg && <span role="alert" className="dk-msg dk-msg--bad">{msg}</span>}
    </span>
  );
}
