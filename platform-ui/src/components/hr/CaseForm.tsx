"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import type { HrResult } from "@/lib/hrActions";
import "@/components/forms/forms.css";

const KINDS = ["onboarding", "offboarding", "review", "grievance", "other"];

export function CaseForm({ create, companyId, subjectOptions, defaultKind }: {
  create: (formData: FormData) => Promise<HrResult>;
  companyId: string;
  subjectOptions?: { value: string; label: string }[];
  defaultKind?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await create(formData);
      if (res.ok) { setMsg(null); setOpen(false); router.refresh(); }
      else setMsg(res.error ?? "Couldn't open the case.");
    });
  };

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>
        New case
      </button>
    );
  }

  return (
    <Card title="Open a case" style={{ marginBottom: 20 }}>
      <form action={onSubmit} className="lux-form-grid">
        <input type="hidden" name="companyId" value={companyId} />
        <Field name="kind" label="Kind" type="select" options={KINDS} defaultValue={defaultKind} required />
        <Field name="title" label="Title" required />
        {subjectOptions && subjectOptions.length > 0 && (
          <Field name="subjectUserId" label="About" type="select" optionItems={subjectOptions} placeholder="Myself" />
        )}
        {msg && (
          <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
            {msg}
          </p>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Opening…" : "Open case"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setOpen(false); setMsg(null); }} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
