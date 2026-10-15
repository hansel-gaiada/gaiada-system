"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { RECOMMENDATIONS } from "@/lib/hrRecruitment";
import { ResultMessage, fullRow, dimStyle } from "./RecruitmentBits";
import "@/components/forms/forms.css";

// "Add scorecard" (DW-7f-2). The reviewer is you: the server fills it in and ignores any other name. Pick the
// interview the scorecard is for. Filing again for the same interview replaces your earlier scorecard; one filed
// with no interview is a new row each time, because the database does not treat two "no interview" rows as the same.
export function ScorecardForm({ file, tenantId, applicationId, interviews }: {
  file: (tenantId: string, applicationId: string, formData: FormData) => Promise<RecruitmentResult>;
  tenantId: string;
  applicationId: string;
  interviews: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await file(tenantId, applicationId, formData);
      if (res.ok) { setMsg({ ok: true, text: res.notice ?? "Scorecard filed." }); setFormKey((k) => k + 1); setOpen(false); }
      else setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => { setOpen(true); setMsg(null); }}>
            Add scorecard
          </button>
        </div>
        {msg && <ResultMessage msg={msg} />}
      </div>
    );
  }

  return (
    <form key={formKey} action={onSubmit} className="lux-form-grid" aria-label="Add scorecard">
      <Field name="interviewId" label="Interview" type="select" optionItems={interviews.map((i) => ({ value: i.id, label: i.label }))}
        placeholder="Not tied to an interview" hint="Filing again for the same interview replaces your earlier scorecard" />
      <Field name="overall" label="Overall (0 to 5)" type="number" step="any" hint="Decimals allowed, e.g. 3.5" />
      <Field name="recommendation" label="Recommendation" type="select" options={[...RECOMMENDATIONS]} placeholder="None" />
      <div style={fullRow}><Field name="notes" label="Notes" type="textarea" /></div>
      <p style={{ margin: 0, ...fullRow, ...dimStyle }}>Give a score, a recommendation or notes. It is filed in your name.</p>
      {msg && <div style={fullRow}><ResultMessage msg={msg} /></div>}
      <div style={{ ...fullRow, display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Filing…" : "File scorecard"}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
          onClick={() => { setOpen(false); setMsg(null); }}>
          Cancel
        </button>
      </div>
    </form>
  );
}
