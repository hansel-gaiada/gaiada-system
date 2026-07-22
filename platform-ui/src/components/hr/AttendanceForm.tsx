"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import type { HrResult } from "@/lib/hrActions";
import "@/components/forms/forms.css";

const STATUSES = ["present", "remote", "absent", "leave"];

export function AttendanceForm({ upsert, companyId, subjectOptions }: {
  upsert: (formData: FormData) => Promise<HrResult>;
  companyId: string;
  subjectOptions?: { value: string; label: string }[]; // present only when hr.view/manage (log for someone else)
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const today = new Date().toISOString().slice(0, 10);

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await upsert(formData);
      if (res.ok) { setMsg(null); router.refresh(); }
      else setMsg(res.error ?? "Couldn't log attendance.");
    });
  };

  return (
    <Card title="Log a day" style={{ marginBottom: 20 }}>
      <form action={onSubmit} className="lux-form-grid">
        <input type="hidden" name="companyId" value={companyId} />
        {subjectOptions && subjectOptions.length > 0 && (
          <Field name="subjectUserId" label="For" type="select" optionItems={subjectOptions} placeholder="Myself" />
        )}
        <Field name="day" label="Day" type="date" defaultValue={today} required />
        <Field name="status" label="Status" type="select" options={STATUSES} required />
        <Field name="note" label="Note (optional)" />
        {msg && (
          <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
            {msg}
          </p>
        )}
        <div style={{ gridColumn: "1 / -1" }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Card>
  );
}
