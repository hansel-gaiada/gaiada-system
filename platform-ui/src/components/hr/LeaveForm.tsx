"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import type { HrResult } from "@/lib/hrActions";
import "@/components/forms/forms.css";

const LEAVE_TYPES = ["vacation", "sick", "unpaid", "other"];

export function LeaveForm({ file, companyId, subjectOptions }: {
  file: (formData: FormData) => Promise<HrResult>;
  companyId: string;
  // Present (non-empty) only when the viewer holds hr.manage in this company —
  // lets HR staff file leave on behalf of someone else. Absent for self-service.
  subjectOptions?: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await file(formData);
      if (res.ok) {
        setMsg(null);
        setOpen(false);
        router.refresh();
      } else {
        setMsg(res.error ?? "Couldn't file the request.");
      }
    });
  };

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>
        File leave
      </button>
    );
  }

  return (
    <Card title="File a leave request" style={{ marginBottom: 20 }}>
      <form action={onSubmit} className="lux-form-grid">
        <input type="hidden" name="companyId" value={companyId} />
        {subjectOptions && subjectOptions.length > 0 && (
          <Field name="subjectUserId" label="For" type="select" optionItems={subjectOptions} placeholder="Myself" />
        )}
        <Field name="leaveType" label="Type" type="select" options={LEAVE_TYPES} required />
        <Field name="startsOn" label="Start date" type="date" required />
        <Field name="endsOn" label="End date" type="date" />
        <Field name="days" label="Days" type="number" defaultValue={1} />
        <Field name="halfDay" label="Half-day" type="boolean" />
        <Field name="note" label="Note (optional)" type="textarea" />
        {msg && (
          <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
            {msg}
          </p>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Filing…" : "File request"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setOpen(false); setMsg(null); }} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
