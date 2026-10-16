"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  explainBatchDecisionError, formatKpiValue, formatMonth, formatTolerance, type DeptKpiTargetRow, type KpiUnit,
} from "@/lib/deptKpiFormat";
import { decideTargetsBatchAction } from "@/lib/deptKpiActions";
import { DecideButtons, WithdrawOwnProposal } from "./TargetControls";
import "./deptKpis.css";

// DW-10b-2 (BFF §58.3, §58.4): the approver's view of the open proposals. They are grouped by KPI, each with a checkbox, and one bar decides the ticked
// ones in ONE batch ("Approve selected" / "Reject selected"): all are decided or none. The viewer's OWN proposal has no checkbox and says "You proposed
// this" (the server refuses an approval of one's own, and the whole batch with it) and offers Withdraw (DW-10b-4: the single reject). The single Approve and Reject buttons stay on every row. When the server
// refuses the batch it names the proposal that caused it (`failedId`), and the form says which KPI and month that is. The server stays the authority.

export interface ProposalGroup {
  key: string;
  label: string;
  unit: KpiUnit;
  proposals: DeptKpiTargetRow[];
}

const rowName = (g: ProposalGroup, p: DeptKpiTargetRow) => `${g.label}, ${formatMonth(p.effectiveFrom)}`;

export function OpenProposals({ groups, meId }: { groups: ProposalGroup[]; meId: string }) {
  const router = useRouter();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const open = groups.filter((g) => g.proposals.length > 0);
  if (open.length === 0) return null;
  const everyId = open.flatMap((g) => g.proposals.map((p) => p.id));
  // A selection that outlives its proposal (decided elsewhere, refreshed away) must not be sent.
  const ids = [...picked].filter((id) => everyId.includes(id));

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const decide = (decision: "approve" | "reject") => {
    setMsg(null);
    setDone(null);
    startTransition(async () => {
      const res = await decideTargetsBatchAction({ decision, ids });
      if (res.ok) {
        setPicked(new Set());
        setDone(`${decision === "approve" ? "Approved" : "Rejected"} ${ids.length === 1 ? "1 proposal" : `${ids.length} proposals`}.`);
        router.refresh();
        return;
      }
      let name: string | null = null;
      if (res.failedId) {
        for (const g of open) {
          const p = g.proposals.find((x) => x.id === res.failedId);
          if (p) name = rowName(g, p);
        }
      }
      setMsg(explainBatchDecisionError(res.error ?? `Could not ${decision} the proposals.`, name));
    });
  };

  return (
    <div className="dk-open" role="group" aria-label="Open proposals">
      <h4 className="dk-target__name">Open proposals</h4>
      {open.map((g) => (
        <section key={g.key} className="dk-open__group" aria-label={`Open proposals: ${g.label}`}>
          <h5 className="dk-open__kpi">{g.label}</h5>
          <ul className="dk-open__list">
            {g.proposals.map((p) => {
              const own = p.proposedBy === meId;
              return (
                <li key={p.id} className="dk-open__row">
                  {own ? (
                    <span className="dk-open__box" aria-hidden="true" />
                  ) : (
                    <input
                      type="checkbox" className="dk-open__box" checked={picked.has(p.id)} onChange={() => toggle(p.id)} disabled={pending}
                      aria-label={`Select the proposal for ${rowName(g, p)}`}
                    />
                  )}
                  <div className="dk-open__text">
                    <p className="dk-target__meta" style={{ margin: 0 }}>
                      Proposed: {formatKpiValue(p.target, g.unit)}, tolerance {formatTolerance(p.tolerance, g.unit)}, from {formatMonth(p.effectiveFrom)}. By{" "}
                      {own ? "you" : p.proposedBy} on {p.proposedAt.slice(0, 10)}.{p.note ? ` Note: ${p.note}` : ""}
                    </p>
                    {own ? (
                      <>
                        <span className="dk-target__meta">You proposed this, so someone else approves it. You may withdraw it.</span>
                        <WithdrawOwnProposal id={p.id} rowName={rowName(g, p)} />
                      </>
                    ) : (
                      <DecideButtons id={p.id} kpiLabel={g.label} />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <div className="dk-open__bar">
        <span className="dk-target__meta" aria-live="polite">{ids.length === 0 ? "None selected" : `${ids.length} selected`}</span>
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || ids.length === 0} onClick={() => decide("approve")}>
          Approve selected
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending || ids.length === 0} onClick={() => decide("reject")}>
          Reject selected
        </button>
        {msg && <span role="alert" className="dk-msg dk-msg--bad">{msg}</span>}
        {done && <span role="status" className="dk-msg">{done}</span>}
      </div>
    </div>
  );
}
