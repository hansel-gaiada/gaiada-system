"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TimeLog as TimeLogEntry } from "@/lib/pm";
import { Field } from "@/components/forms/Field";
import { HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

const hrs = (m: number) => `${(m / 60).toFixed(1)}h`;

interface Props {
  logs: TimeLogEntry[];
  loggedMinutes: number;
  estimateMinutes: number | null;
  billableMinutes: number;
  canEdit: boolean;
  log: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
}

export function TimeLog({ logs, loggedMinutes, estimateMinutes, billableMinutes, canEdit, log }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const overEstimate = estimateMinutes != null && loggedMinutes > estimateMinutes;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "baseline" }}>
        <span style={{ font: "700 18px var(--font-display)", color: overEstimate ? "#B5622F" : "var(--text-primary)" }}>
          {hrs(loggedMinutes)}{estimateMinutes != null ? ` / ${hrs(estimateMinutes)}` : ""}
        </span>
        <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
          logged{estimateMinutes != null ? " vs estimate" : ""} · {hrs(billableMinutes)} billable
        </span>
        {canEdit && !open && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>Log time</button>}
      </div>

      {open && (
        <form
          className="lux-form-grid"
          action={(fd) => startTransition(async () => { const r = await log(fd); if (r.ok) { setMsg(null); setOpen(false); router.refresh(); } else setMsg(r.error ?? "Couldn't log time."); })}
        >
          <Field name="hours" label="Hours (e.g. 1.5)" type="number" required />
          <Field name="spentOn" label="Date" type="date" />
          <Field name="billable" label="Billable" type="boolean" />
          <div style={{ gridColumn: "1 / -1" }}><Field name="note" label="Note" /></div>
          {msg && <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
          </div>
        </form>
      )}

      {logs.length === 0 ? (
        <EmptyNote>No time logged yet.</EmptyNote>
      ) : (
        <HairlineTable
          columns={[{ label: "Who" }, { label: "Date" }, { label: "Hours" }, { label: "Billable" }, { label: "Note" }]}
          rows={logs.map((l) => [l.userName, l.spentOn, hrs(l.minutes), l.billable ? "Yes" : "No", l.note || "—"])}
          tcols="1.2fr 1fr 0.6fr 0.6fr 1.6fr"
        />
      )}
    </div>
  );
}
