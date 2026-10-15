"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { ResultMessage, fullRow, dimStyle } from "./RecruitmentBits";
import "@/components/forms/forms.css";

// "Add or update a stage" on the recruitment funnel (DW-7f-2). An upsert by key: the same key updates that
// stage's label, order, terminal kind and interview flag; a new key adds one. It cannot remove or deactivate a
// stage. A terminal stage ends the application that is moved into it (hired, rejected or withdrawn).
export function PipelineStageForm({ save, companyId }: {
  save: (formData: FormData) => Promise<RecruitmentResult>;
  companyId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await save(formData);
      if (res.ok) { setMsg({ ok: true, text: res.notice ?? "Stage saved." }); setFormKey((k) => k + 1); }
      else setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setOpen(true); setMsg(null); }}>
            Add or update a stage
          </button>
        </div>
        {msg && <ResultMessage msg={msg} />}
      </div>
    );
  }

  return (
    <form key={formKey} action={onSubmit} className="lux-form-grid" aria-label="Add or update a pipeline stage">
      <input type="hidden" name="companyId" value={companyId} />
      <Field name="key" label="Key" required hint="Stable handle, e.g. tech_interview. An existing key updates that stage" />
      <Field name="label" label="Label" required />
      <Field name="sortOrder" label="Order" type="number" defaultValue={0} hint="Lower comes first" />
      <Field name="terminalKind" label="Ends the application as" type="select" options={["hired", "rejected", "withdrawn"]} placeholder="Nothing (ordinary stage)" />
      <Field name="requiresInterview" label="Needs an interview before moving on" type="boolean" />
      <p style={{ margin: 0, ...fullRow, ...dimStyle }}>A stage cannot be removed from here.</p>
      {msg && <div style={fullRow}><ResultMessage msg={msg} /></div>}
      <div style={{ ...fullRow, display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Saving…" : "Save stage"}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
          onClick={() => { setOpen(false); setMsg(null); }}>
          Close
        </button>
      </div>
    </form>
  );
}
