"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import {
  GM_CONDITION_OPTIONS, MAX_APPRAISAL_TEXT, type DeptAppraisalGm, type DeptAppraisalHod,
} from "@/lib/deptAppraisalFormat";
import { saveDeptAppraisalAssessment, saveDeptAppraisalCommentary } from "@/lib/deptAppraisalActions";
import "@/components/forms/forms.css";
import "./deptAppraisal.css";

/**
 * The head's commentary on the department's appraisal for a cycle (BFF §41.4). Offered by the page only while the cycle is
 * open and only to someone the `reports.dept_kpi_target.appraisal_comment` capability reaches (company_admin, or the head over
 * this unit); the server decides again and its 400/403/409 sentence is shown as it was said. Saving replaces the previous text.
 */
export function CommentaryForm({ cycleId, unitId, current }: { cycleId: string; unitId: string; current: DeptAppraisalHod | null }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await saveDeptAppraisalCommentary(formData);
      if (res.ok) {
        setMsg(null);
        setSaved(true);
        router.refresh();
      } else {
        setSaved(false);
        setMsg(res.error ?? "Could not save the commentary.");
      }
    });
  };

  return (
    <form action={onSubmit} className="da-form" aria-label="Head's commentary">
      <input type="hidden" name="cycleId" value={cycleId} />
      <input type="hidden" name="unitNodeId" value={unitId} />
      <Field name="text" label="Commentary" type="textarea" required defaultValue={current?.text ?? ""}
        hint={`Up to ${MAX_APPRAISAL_TEXT.toLocaleString("en-US")} characters. Saving replaces the previous commentary.`}
        error={msg ?? undefined} />
      <div className="da-form__row">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Saving…" : current ? "Replace commentary" : "Save commentary"}
        </button>
        {saved && !msg && <span role="status" className="da-msg">Saved.</span>}
      </div>
    </form>
  );
}

/**
 * The GM's assessment: text and the GM's own judgement of the condition, which the page shows beside the computed condition and
 * never in place of it (BFF §41.4). Offered while the cycle is open to the approver tier (`reports.dept_kpi_target.appraisal_assess`).
 */
export function AssessmentForm({ cycleId, unitId, current }: { cycleId: string; unitId: string; current: DeptAppraisalGm | null }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [field, setField] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await saveDeptAppraisalAssessment(formData);
      if (res.ok) {
        setMsg(null);
        setField(undefined);
        setSaved(true);
        router.refresh();
      } else {
        setSaved(false);
        setMsg(res.error ?? "Could not save the assessment.");
        setField(res.field);
      }
    });
  };

  const inline = ["text", "condition"];
  const err = (f: string) => (field === f ? msg ?? undefined : undefined);
  return (
    <form action={onSubmit} className="da-form" aria-label="GM's assessment">
      <input type="hidden" name="cycleId" value={cycleId} />
      <input type="hidden" name="unitNodeId" value={unitId} />
      <Field name="condition" label="Your judgement of the department's condition" type="select" required
        defaultValue={current?.condition ?? ""} optionItems={GM_CONDITION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        error={err("condition")} />
      <Field name="text" label="Assessment" type="textarea" required defaultValue={current?.text ?? ""}
        hint={`Up to ${MAX_APPRAISAL_TEXT.toLocaleString("en-US")} characters. Saving replaces the previous assessment.`}
        error={err("text")} />
      <div className="da-form__row">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Saving…" : current ? "Replace assessment" : "Save assessment"}
        </button>
        {saved && !msg && <span role="status" className="da-msg">Saved.</span>}
        {msg && !inline.includes(field ?? "") && <span role="alert" className="da-msg da-msg--bad">{msg}</span>}
      </div>
    </form>
  );
}
