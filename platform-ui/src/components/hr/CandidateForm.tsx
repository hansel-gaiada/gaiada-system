"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { CANDIDATE_SOURCES } from "@/lib/hrRecruitment";
import { ResultMessage, fullRow, dimStyle } from "./RecruitmentBits";
import "@/components/forms/forms.css";

// "Add candidate" (DW-7f-2): a person into the talent pool. The pool holds an outsider's personal data under
// consent, so the consent date and a retention date are asked for here. The server refuses a second candidate
// with the same email (409) and says so; its words are shown as sent. Putting the candidate on a requisition
// is a separate step, on the requisition's page.
export function CandidateForm({ create, companyId }: {
  create: (formData: FormData) => Promise<RecruitmentResult>;
  companyId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await create(formData);
      if (res.ok) { setMsg({ ok: true, text: res.notice ?? "Candidate added." }); setOpen(false); setFormKey((k) => k + 1); }
      else setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => { setOpen(true); setMsg(null); }}>
            Add candidate
          </button>
        </div>
        {msg && <ResultMessage msg={msg} />}
      </div>
    );
  }

  return (
    <Card title="Add candidate" style={{ marginBottom: 12 }}>
      <form key={formKey} action={onSubmit} className="lux-form-grid" aria-label="Add candidate">
        <input type="hidden" name="companyId" value={companyId} />
        <Field name="fullName" label="Full name" required />
        <Field name="email" label="Email" hint="One candidate per email address" />
        <Field name="phone" label="Phone" />
        <Field name="headline" label="Headline" hint="Current role or one line about them" />
        <Field name="location" label="Location" />
        <Field name="source" label="Source" type="select" options={[...CANDIDATE_SOURCES]} defaultValue="direct" placeholder="Direct (default)" />
        <Field name="sourceDetail" label="Source detail" hint="Who referred them, which agency or board" />
        <Field name="consentGivenAt" label="Consent given on" type="date" hint="The day they agreed to us holding their data" />
        <Field name="retentionUntil" label="Keep data until" type="date" />
        <div style={fullRow}><Field name="notes" label="Notes" type="textarea" /></div>
        <p style={{ margin: 0, ...fullRow, ...dimStyle }}>This is personal data about someone outside the company. Record consent where you have it.</p>
        {msg && !msg.ok && <div style={fullRow}><ResultMessage msg={msg} /></div>}
        <div style={{ ...fullRow, display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Adding…" : "Add to talent pool"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
            onClick={() => { setOpen(false); setMsg(null); }}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
