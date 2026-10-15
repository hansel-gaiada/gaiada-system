"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { EMPLOYMENT_TYPES, RATE_BASES } from "@/lib/hrRecruitment";
import { ResultMessage, fullRow, dimStyle } from "./RecruitmentBits";
import "@/components/forms/forms.css";

// "Make offer" (DW-7f-2). Drafts an offer; marking it sent, accepted or declined, and converting it, are separate
// steps on the offer. The server refuses an amount above the requisition's approved maximum and says what the
// maximum is; its words are shown as sent. Only one live offer can exist per application (the page offers this
// form only when there is none).
export function OfferForm({ create, tenantId, applicationId, defaultCurrency, defaultEmploymentType, ceiling }: {
  create: (tenantId: string, applicationId: string, formData: FormData) => Promise<RecruitmentResult>;
  tenantId: string;
  applicationId: string;
  defaultCurrency: string;
  defaultEmploymentType?: string;
  /** The requisition's approved maximum, when the page knows it, as a sentence ("up to Rp 12.000.000"). */
  ceiling?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await create(tenantId, applicationId, formData);
      if (res.ok) { setMsg({ ok: true, text: res.notice ?? "Offer drafted." }); setFormKey((k) => k + 1); setOpen(false); }
      else setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => { setOpen(true); setMsg(null); }}>
            Make offer
          </button>
        </div>
        {msg && <ResultMessage msg={msg} />}
      </div>
    );
  }

  return (
    <form key={formKey} action={onSubmit} className="lux-form-grid" aria-label="Make offer">
      <Field name="baseAmount" label="Base amount" type="number" step="any" required hint={ceiling ? `The requisition's approved band: ${ceiling}` : "Per the rate basis below"} />
      <Field name="currency" label="Currency" defaultValue={defaultCurrency} hint="3-letter code" />
      <Field name="rateBasis" label="Rate basis" type="select" options={[...RATE_BASES]} defaultValue="monthly" />
      <Field name="employmentType" label="Employment type" type="select" options={[...EMPLOYMENT_TYPES]} defaultValue={defaultEmploymentType ?? "permanent"} placeholder="Permanent (default)" />
      <Field name="probationMonths" label="Probation (months)" type="number" hint="0 to 12" />
      <Field name="contractMonths" label="Contract (months)" type="number" hint="1 to 60, for a contract" />
      <Field name="startOn" label="Start date" type="date" />
      <Field name="expiresOn" label="Offer expires" type="date" hint="On or before the start date" />
      <p style={{ margin: 0, ...fullRow, ...dimStyle }}>Drafted first. It is not with the candidate until you mark it as sent.</p>
      {msg && <div style={fullRow}><ResultMessage msg={msg} /></div>}
      <div style={{ ...fullRow, display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Drafting…" : "Draft offer"}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
          onClick={() => { setOpen(false); setMsg(null); }}>
          Cancel
        </button>
      </div>
    </form>
  );
}
