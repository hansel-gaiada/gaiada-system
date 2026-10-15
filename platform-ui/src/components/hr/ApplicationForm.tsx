"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { ResultMessage, fullRow } from "./RecruitmentBits";
import "@/components/forms/forms.css";

// "Add a candidate to this requisition" (DW-7f-2): creates the application. The candidate list is the talent
// pool as the server returned it; a person who is not in it is added there first (on the console). The server
// refuses a second live application for the same candidate and requisition (409), in its own words.
export function ApplicationForm({ create, companyId, requisitionId, candidates, stages }: {
  create: (formData: FormData) => Promise<RecruitmentResult>;
  companyId: string;
  requisitionId: string;
  candidates: { id: string; name: string; email: string | null }[];
  /** The ordinary (non-terminal) stages. Left blank, the server starts the application at "applied". */
  stages: { key: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await create(formData);
      if (res.ok) { setMsg({ ok: true, text: res.notice ?? "Added." }); setFormKey((k) => k + 1); }
      else setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => { setOpen(true); setMsg(null); }}>
            Add candidate to this requisition
          </button>
        </div>
        {msg && <ResultMessage msg={msg} />}
      </div>
    );
  }

  return (
    <form key={formKey} action={onSubmit} className="lux-form-grid" aria-label="Add candidate to requisition">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="requisitionId" value={requisitionId} />
      <Field name="candidateId" label="Candidate" type="select" required placeholder="Select a candidate…"
        optionItems={candidates.map((c) => ({ value: c.id, label: c.email ? `${c.name} (${c.email})` : c.name }))}
        hint={candidates.length === 0 ? "The talent pool is empty: add the person on the recruitment console first" : undefined} />
      <Field name="stageKey" label="Starting stage" type="select" optionItems={stages.map((s) => ({ value: s.key, label: s.label }))}
        placeholder="First stage (default)" />
      <Field name="appliedOn" label="Applied on" type="date" hint="Today, if left blank" />
      {msg && <div style={fullRow}><ResultMessage msg={msg} /></div>}
      <div style={{ ...fullRow, display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Adding…" : "Add to pipeline"}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
          onClick={() => { setOpen(false); setMsg(null); }}>
          Close
        </button>
      </div>
    </form>
  );
}
