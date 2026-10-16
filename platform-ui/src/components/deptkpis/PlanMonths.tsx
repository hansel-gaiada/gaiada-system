"use client";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  formatMonth, fromFraction, monthStartsFrom, targetInForceFor, type DeptKpiTargetsKpi, type KpiUnit,
} from "@/lib/deptKpiFormat";
import { proposeTargetsBatchAction } from "@/lib/deptKpiActions";
import "@/components/forms/forms.css";
import "./deptKpis.css";

// DW-10b-2 (BFF §58.2, §58.4): "Plan the coming months". A head chooses a KPI and how many of the next months (1 to 12); each month gets a target and a
// tolerance, pre-filled with the target in force for THAT month (an approved target from that month or earlier; else the catalogue's suggestion, which is
// only a starting point and never in force). A percent is typed as a whole percent and sent as a fraction (the same convention as `ProposeTargetForm`).
// Submitting sends ONE batch: all months are proposed or none. The server's refusal is shown where it belongs: a problem with one month under that
// month's row, anything else (403, 404, 409) as a message under the form. The server stays the authority; the page only offers this to a proposer.

const MAX_MONTHS = 12;
const DEFAULT_MONTHS = 3;

interface RowState { month: string; target: string; tolerance: string }

function prefill(kpi: DeptKpiTargetsKpi, asOf: string, count: number): RowState[] {
  return monthStartsFrom(asOf, count).map((month) => {
    const inForce = targetInForceFor(kpi, month);
    const target = inForce ? inForce.target : kpi.suggestedTarget;
    const tolerance = inForce ? inForce.tolerance : kpi.suggestedTolerance;
    return {
      month,
      target: target === null ? "" : String(fromFraction(kpi.unit, target)),
      tolerance: tolerance === null ? "" : String(fromFraction(kpi.unit, tolerance)),
    };
  });
}

const unitHint = (unit: KpiUnit) => (unit === "percent" ? "Whole percent, e.g. 85" : unit === "minutes" ? "In minutes" : "A number");

/** The month rows for one KPI and one month count. Keyed by both in the parent, so changing either starts from a fresh pre-fill. */
function PlanRows({ unitId, kpi, asOf, count }: { unitId: string; kpi: DeptKpiTargetsKpi; asOf: string; count: number }) {
  const router = useRouter();
  const [rows, setRows] = useState<RowState[]>(() => prefill(kpi, asOf, count));
  const [note, setNote] = useState("");
  const [rowError, setRowError] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const noteId = useId();

  const edit = (i: number, patch: Partial<RowState>) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setSent(null);
  };

  const submit = () => {
    setFormError(null);
    setRowError({});
    setSent(null);
    startTransition(async () => {
      const res = await proposeTargetsBatchAction({
        unitNodeId: unitId,
        items: rows.map((r) => ({ kpiKey: kpi.key, unit: kpi.unit, effectiveFrom: r.month, target: r.target, tolerance: r.tolerance, ...(note.trim() ? { note } : {}) })),
      });
      if (res.ok) {
        setSent(rows.length);
        router.refresh();
        return;
      }
      const msg = res.error ?? "Could not send the proposals.";
      if (res.index !== undefined && res.index >= 0 && res.index < rows.length) setRowError({ [res.index]: msg });
      else setFormError(msg);
    });
  };

  return (
    <form
      className="dk-plan__form" aria-label={`Plan targets for ${kpi.label}`}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <table className="dk-plan__table">
        <caption className="dk-plan__caption">
          One target and tolerance per month. {kpi.unit === "percent" ? "Percent targets are typed as whole percents (85 means 85%). " : ""}
          They start as the target in force that month.
        </caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Target <span className="dk-plan__hint">{unitHint(kpi.unit)}</span></th>
            <th scope="col">Tolerance <span className="dk-plan__hint">{kpi.unit === "percent" ? "Points, e.g. 5" : unitHint(kpi.unit)}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const label = formatMonth(r.month);
            const err = rowError[i];
            return (
              <tr key={r.month}>
                <th scope="row">{label}</th>
                <td>
                  <input
                    className={`lux-field__control${err ? " lux-field__control--error" : ""}`} type="text" inputMode="decimal" value={r.target}
                    aria-label={`Target for ${kpi.label}, ${label}`} aria-invalid={err ? true : undefined}
                    onChange={(e) => edit(i, { target: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className={`lux-field__control${err ? " lux-field__control--error" : ""}`} type="text" inputMode="decimal" value={r.tolerance}
                    aria-label={`Tolerance for ${kpi.label}, ${label}`} aria-invalid={err ? true : undefined}
                    onChange={(e) => edit(i, { tolerance: e.target.value })}
                  />
                  {err && <span role="alert" className="dk-msg dk-msg--bad">{label}: {err}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="dk-plan__note">
        <label htmlFor={noteId} className="lux-field__label">Note for every month (optional)</label>
        <input id={noteId} className="lux-field__control" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="dk-form__row">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Sending…" : `Send ${rows.length === 1 ? "1 proposal" : `${rows.length} proposals`}`}
        </button>
        {formError && <span role="alert" className="dk-msg dk-msg--bad">{formError}</span>}
        {sent !== null && (
          <span role="status" className="dk-msg">
            Sent {sent === 1 ? "1 proposal" : `${sent} proposals`}. They are listed under Targets until the approver decides them.
          </span>
        )}
      </div>
    </form>
  );
}

export function PlanMonths({ unitId, kpis, asOf }: { unitId: string; kpis: DeptKpiTargetsKpi[]; asOf: string }) {
  const [kpiKey, setKpiKey] = useState(kpis[0]?.key ?? "");
  const [count, setCount] = useState(DEFAULT_MONTHS);
  const kpiId = useId();
  const countId = useId();
  const kpi = kpis.find((k) => k.key === kpiKey) ?? kpis[0];
  if (!kpi) return <p className="dk-target__meta">This department has no KPIs to plan targets for.</p>;

  return (
    <div className="dk-plan">
      <div className="dk-plan__pick">
        <div className="lux-field">
          <label htmlFor={kpiId} className="lux-field__label">KPI</label>
          <select id={kpiId} className="lux-field__control" value={kpi.key} onChange={(e) => setKpiKey(e.target.value)}>
            {kpis.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </div>
        <div className="lux-field">
          <label htmlFor={countId} className="lux-field__label">How many coming months</label>
          <select id={countId} className="lux-field__control" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {Array.from({ length: MAX_MONTHS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n === 1 ? "1 month" : `${n} months`}</option>
            ))}
          </select>
        </div>
      </div>
      <PlanRows key={`${kpi.key}|${count}`} unitId={unitId} kpi={kpi} asOf={asOf} count={count} />
    </div>
  );
}
