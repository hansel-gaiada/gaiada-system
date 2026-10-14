"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { formatMonth, fromFraction, monthStartsFrom, explainDecisionError, type DeptKpiTargetsKpi } from "@/lib/deptKpiFormat";
import { proposeDeptKpiTarget, approveDeptKpiTarget, rejectDeptKpiTarget, type DeptKpiActionResult } from "@/lib/deptKpiActions";
import "@/components/forms/forms.css";
import "./deptKpis.css";

/**
 * "Propose a target" for one KPI (BFF §40.2). Pre-filled with the catalogue's suggested target and tolerance, which are
 * only a starting point and never in force. A percent is typed as a whole percent and sent as a fraction (the server
 * action does the conversion). The server decides who may propose; its 400/403 sentence is shown as it was said.
 */
export function ProposeTargetForm({ unitId, kpi, asOf }: { unitId: string; kpi: DeptKpiTargetsKpi; asOf: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [field, setField] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const months = monthStartsFrom(asOf);
  const unitHint = kpi.unit === "percent" ? "Whole percent, e.g. 85" : kpi.unit === "minutes" ? "In minutes" : "A number";
  const tolHint = kpi.unit === "percent" ? "Percentage points, e.g. 5" : unitHint;

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await proposeDeptKpiTarget(formData);
      if (res.ok) {
        setMsg(null);
        setField(undefined);
        setOpen(false);
        router.refresh();
      } else {
        setMsg(res.error ?? "Could not send the proposal.");
        setField(res.field);
      }
    });
  };

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}
        aria-label={`Propose a target for ${kpi.label}`}>
        Propose a target
      </button>
    );
  }

  const inline = ["target", "tolerance", "effectiveFrom"];
  const err = (f: string) => (field === f ? msg ?? undefined : undefined);
  return (
    <form action={onSubmit} className="dk-form" aria-label={`Propose a target for ${kpi.label}`}>
      <input type="hidden" name="unitNodeId" value={unitId} />
      <input type="hidden" name="kpiKey" value={kpi.key} />
      <input type="hidden" name="unit" value={kpi.unit} />
      <Field name="target" label="Target" type="text" required hint={unitHint}
        defaultValue={kpi.suggestedTarget === null ? "" : fromFraction(kpi.unit, kpi.suggestedTarget)} error={err("target")} />
      <Field name="tolerance" label="Tolerance" type="text" required hint={tolHint}
        defaultValue={kpi.suggestedTolerance === null ? "" : fromFraction(kpi.unit, kpi.suggestedTolerance)} error={err("tolerance")} />
      <Field name="effectiveFrom" label="Effective from" type="select" required
        defaultValue={months[0]} optionItems={months.map((m) => ({ value: m, label: formatMonth(m) }))} error={err("effectiveFrom")} />
      <Field name="note" label="Note (optional)" type="text" />
      <div className="dk-form__row">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Sending…" : "Send proposal"}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setOpen(false); setMsg(null); setField(undefined); }}>
          Cancel
        </button>
        {msg && !inline.includes(field ?? "") && <span role="alert" className="dk-msg dk-msg--bad">{msg}</span>}
      </div>
    </form>
  );
}

/** Approve / Reject one open proposal. Shown to the approver tier who is not the proposer; the server still decides. */
export function DecideButtons({ id, kpiLabel }: { id: string; kpiLabel: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: (id: string) => Promise<DeptKpiActionResult>, verb: string) => {
    startTransition(async () => {
      const res = await action(id);
      if (res.ok) {
        setMsg(null);
        router.refresh();
      } else {
        setMsg(explainDecisionError(res.error ?? `Could not ${verb} the proposal.`));
      }
    });
  };

  return (
    <span className="dk-target__actions">
      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
        aria-label={`Approve the proposed target for ${kpiLabel}`} onClick={() => run(approveDeptKpiTarget, "approve")}>
        Approve
      </button>
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
        aria-label={`Reject the proposed target for ${kpiLabel}`} onClick={() => run(rejectDeptKpiTarget, "reject")}>
        Reject
      </button>
      {msg && <span role="alert" className="dk-msg dk-msg--bad">{msg}</span>}
    </span>
  );
}
