"use client";
// SCP-1a — the per-client step estimates on the Settings page (BFF §63.1 `step_estimates`, §63.4): the working days each step takes for each client,
// proofread · HoD approval · design · final check · client approval · scheduling. With them a post shows the latest safe day to hand it on; without
// them, only the ready-by date (plan §4.4).
//
// They are part of the client's allocation and are saved through `PATCH engagements/:engagementId/allocation` (`stepEstimates`), `social_engagement` ·
// `plan`: the four Social approvers' alone. Everyone else sees the numbers and the boxes are DISABLED WITH THE REASON (words under the table,
// `aria-describedby`, and the button's `title`). The server's 403 `not_a_social_approver` is the boundary.
//
// An empty box means "no estimate for this step" (a missing estimate counts as 0 days in the schedule maths). The whole set is sent on save: a box
// left empty is cleared. Each box is a whole number of working days from 0 to 30.
import { useId, useState, useTransition } from "react";
import { saveAllocation } from "@/lib/socialAllocationActions";
import { STEP_KEYS, STEP_LABEL, estimateProblem, type AllocationRow, type StepEstimates } from "@/lib/socialAllocation";
import { PLAN_REFUSAL_REASON } from "@/lib/socialCycles";
import "./cycles.css";
import "./allocation.css";

type Texts = Record<(typeof STEP_KEYS)[number], string>;
const textsOf = (e: StepEstimates): Texts =>
  Object.fromEntries(STEP_KEYS.map((k) => [k, e[k] === undefined ? "" : String(e[k])])) as Texts;
const estimatesOf = (t: Texts): StepEstimates => {
  const out: StepEstimates = {};
  for (const k of STEP_KEYS) if (t[k].trim() !== "") out[k] = Number(t[k]);
  return out;
};
const sameEstimates = (a: StepEstimates, b: StepEstimates): boolean => STEP_KEYS.every((k) => a[k] === b[k]);

function EstimatesRow({ row, reasonId, onSaved }: { row: AllocationRow; reasonId: string; onSaved: (r: AllocationRow) => void }) {
  const [texts, setTexts] = useState<Texts>(() => textsOf(row.stepEstimates));
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const locked = !row.canPlan;
  const bad = STEP_KEYS.some((k) => estimateProblem(texts[k]) !== null);
  const dirty = !sameEstimates(estimatesOf(texts), row.stepEstimates);

  function save() {
    setMsg(null);
    startTransition(async () => {
      const res = await saveAllocation(row.engagementId, { stepEstimates: estimatesOf(texts) });
      if (!res.ok) { setMsg({ kind: "error", text: res.message }); return; }
      setTexts(textsOf(res.row.stepEstimates));
      setMsg({ kind: "ok", text: "Saved." });
      onSaved(res.row);
    });
  }

  return (
    <tr>
      <td><span className="scp-table__client">{row.clientName}</span></td>
      {STEP_KEYS.map((k) => (
        <td key={k}>
          <input
            className="scp-input scp-input--narrow" type="number" inputMode="numeric" min={0} max={30} step={1}
            aria-label={`${STEP_LABEL[k]} for ${row.clientName} (working days)`} aria-invalid={estimateProblem(texts[k]) !== null}
            value={texts[k]} onChange={(e) => { setTexts((t) => ({ ...t, [k]: e.target.value })); setMsg(null); }}
            disabled={locked || pending} aria-describedby={locked ? reasonId : undefined}
          />
        </td>
      ))}
      <td>
        <span className="scp-alloc__rowactions">
          <button
            type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={save} disabled={locked || pending || bad || !dirty}
            title={locked ? PLAN_REFUSAL_REASON : undefined} aria-describedby={locked ? reasonId : undefined} aria-label={`Save step estimates for ${row.clientName}`}
          >
            {pending ? "Saving…" : "Save"}
          </button>
          {bad && <span className="scp-alloc__rowmsg scp-msg--error">Whole days, 0 to 30.</span>}
          {msg && <span className={`scp-alloc__rowmsg scp-msg--${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</span>}
        </span>
      </td>
    </tr>
  );
}

export function StepEstimatesEditor({ rows }: { rows: AllocationRow[] }) {
  const reasonId = useId();
  const [current, setCurrent] = useState<AllocationRow[]>(rows);
  if (current.length === 0) return <p className="scp-note">No client has an open engagement yet, so there are no estimates to set.</p>;
  const anyLocked = current.some((r) => !r.canPlan);
  return (
    <div className="scp-estimates">
      <div className="scp-tablewrap">
        <table className="scp-table">
          <caption>Working days each step takes, per client. Leave a box empty for no estimate.</caption>
          <thead>
            <tr>
              <th scope="col">Client</th>
              {STEP_KEYS.map((k) => <th key={k} scope="col">{STEP_LABEL[k]}</th>)}
              <th scope="col"><span className="scp-sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {current.map((r) => (
              <EstimatesRow key={r.engagementId} row={r} reasonId={reasonId} onSaved={(next) => setCurrent((all) => all.map((x) => (x.engagementId === next.engagementId ? next : x)))} />
            ))}
          </tbody>
        </table>
      </div>
      {anyLocked && <p className="scp-note scp-note--reason" id={reasonId}>{PLAN_REFUSAL_REASON}</p>}
    </div>
  );
}
