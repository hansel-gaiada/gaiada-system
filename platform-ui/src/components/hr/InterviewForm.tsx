"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { INTERVIEW_KINDS, INTERVIEW_STATUSES, INTERVIEW_OUTCOMES, isoToZonedLocal } from "@/lib/hrRecruitment";
import { ResultMessage, fullRow, dimStyle, panelStyle } from "./RecruitmentBits";
import type { PersonOption } from "./RequisitionForm";
import "@/components/forms/forms.css";

// Interviews on an application (DW-7f-2). The times are typed in the interview's time zone and converted to
// exact instants by the action, because the server only displays the zone. Panelists are picked from the
// employee list when the page could read it; each is notified by the server.

export function InterviewForm({ schedule, tenantId, applicationId, people }: {
  schedule: (tenantId: string, applicationId: string, formData: FormData) => Promise<RecruitmentResult>;
  tenantId: string;
  applicationId: string;
  people: PersonOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await schedule(tenantId, applicationId, formData);
      if (res.ok) { setMsg({ ok: true, text: res.notice ?? "Interview scheduled." }); setFormKey((k) => k + 1); setOpen(false); }
      else setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => { setOpen(true); setMsg(null); }}>
            Schedule interview
          </button>
        </div>
        {msg && <ResultMessage msg={msg} />}
      </div>
    );
  }

  return (
    <form key={formKey} action={onSubmit} className="lux-form-grid" aria-label="Schedule interview">
      <Field name="kind" label="Type" type="select" options={[...INTERVIEW_KINDS]} defaultValue="interview" placeholder="Interview (default)" />
      <Field name="timezone" label="Time zone" defaultValue="Asia/Makassar" hint="A name such as Asia/Makassar; the times below are in this zone" />
      <Field name="scheduledStart" label="Starts" type="datetime-local" required />
      <Field name="scheduledEnd" label="Ends" type="datetime-local" required />
      <Field name="location" label="Location" />
      <Field name="meetingUrl" label="Meeting link" hint="https://…" />
      {people.length > 0 && (
        <label className="lux-field" style={fullRow}>
          <span id="interview-panelists-label" className="lux-field__label">Panelists</span>
          <select name="panelists" aria-labelledby="interview-panelists-label" aria-describedby="interview-panelists-hint" multiple size={Math.min(6, people.length)} className="lux-field__control">
            {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
          </select>
          <span id="interview-panelists-hint" className="lux-field__hint">Hold Ctrl or Cmd to pick several. Each is told they are on the panel.</span>
        </label>
      )}
      {msg && <div style={fullRow}><ResultMessage msg={msg} /></div>}
      <div style={{ ...fullRow, display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Scheduling…" : "Schedule"}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
          onClick={() => { setOpen(false); setMsg(null); }}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Edit one interview: its status, outcome and times. The time zone is the interview's own and cannot be changed.
export function InterviewEditor({ update, tenantId, applicationId, interview }: {
  update: (tenantId: string, applicationId: string, interviewId: string, formData: FormData) => Promise<RecruitmentResult>;
  tenantId: string;
  applicationId: string;
  interview: { id: string; kind: string; scheduledStart: string; scheduledEnd: string; timezone: string; status: string; outcome: string | null };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await update(tenantId, applicationId, interview.id, formData);
      if (res.ok) { setMsg({ ok: true, text: res.notice ?? "Interview updated." }); setOpen(false); }
      else setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      router.refresh();
    });
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {!open && (
        <div>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Edit ${interview.kind} interview`}
            onClick={() => { setOpen(true); setMsg(null); }}>
            Edit
          </button>
        </div>
      )}
      {open && (
        <form action={onSubmit} className="lux-form-grid" aria-label={`Edit ${interview.kind} interview`} style={panelStyle}>
          <input type="hidden" name="timezone" value={interview.timezone} />
          <Field name="status" label="Status" type="select" options={[...INTERVIEW_STATUSES]} defaultValue={interview.status} />
          <Field name="outcome" label="Outcome" type="select" options={[...INTERVIEW_OUTCOMES]} defaultValue={interview.outcome ?? ""} placeholder="Not set" />
          <Field name="scheduledStart" label="Starts" type="datetime-local" defaultValue={isoToZonedLocal(interview.scheduledStart, interview.timezone)} />
          <Field name="scheduledEnd" label="Ends" type="datetime-local" defaultValue={isoToZonedLocal(interview.scheduledEnd, interview.timezone)} />
          <p style={{ margin: 0, ...fullRow, ...dimStyle }}>Times are in {interview.timezone}. Changing the times does not tell the panel.</p>
          {msg && !msg.ok && <div style={fullRow}><ResultMessage msg={msg} /></div>}
          <div style={{ ...fullRow, display: "flex", gap: 10 }}>
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
              {pending ? "Saving…" : "Save interview"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
              onClick={() => { setOpen(false); setMsg(null); }}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {msg && msg.ok && <ResultMessage msg={msg} />}
    </div>
  );
}
