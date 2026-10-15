"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { ResultMessage, panelStyle, textStyle, type Msg } from "./RecruitmentBits";

export type StageOption = { key: string; label: string; isTerminal: boolean; terminalKind: string | null };

// "Move stage" for one application (DW-7f-2). One control for advance, reject and withdraw, as on the server:
// the destination stage decides. The stage list is the company's own (data, not a constant). A stage that ends
// the application asks for confirmation naming what it does, and a rejection asks for a reason. The server
// refuses a move on an application that is already closed; its sentence is shown as sent. Moving to a "hired"
// stage does not create an employee: that is the offer's convert step.
const ENDS: Record<string, string> = {
  hired: "marks the application as hired (it does not create the employee: convert an accepted offer for that)",
  rejected: "rejects the application",
  withdrawn: "records the application as withdrawn",
};

export function ApplicationStageMove({ tenantId, applicationId, candidateName, currentStageKey, stages, move }: {
  tenantId: string;
  applicationId: string;
  candidateName: string;
  currentStageKey: string;
  stages: StageOption[];
  move: (tenantId: string, applicationId: string, formData: FormData) => Promise<RecruitmentResult>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<Msg | null>(null);
  const [pending, startTransition] = useTransition();

  const choices = stages.filter((s) => s.key !== currentStageKey);
  const chosen = choices.find((s) => s.key === target);
  const ends = chosen?.isTerminal ? chosen.terminalKind ?? "withdrawn" : null;

  function submit() {
    const fd = new FormData();
    fd.set("stageKey", target);
    if (note.trim()) fd.set("note", note.trim());
    if (ends === "rejected" && reason.trim()) fd.set("rejectionReason", reason.trim());
    startTransition(async () => {
      const res = await move(tenantId, applicationId, fd);
      if (res.ok) {
        setMsg({ ok: true, text: res.notice ?? "Moved." });
        setOpen(false); setTarget(""); setNote(""); setReason("");
      } else {
        setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      }
      router.refresh(); // after a refusal the application may already have moved ("application is 'hired' and cannot be moved")
    });
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {!open && (
        <div>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
            aria-label={`Move ${candidateName} to another stage`} onClick={() => { setOpen(true); setMsg(null); }}>
            Move stage
          </button>
        </div>
      )}
      {open && (
        <div role="group" aria-label={`Move ${candidateName}`} style={panelStyle}>
          <label style={{ display: "grid", gap: 4, font: "400 12px var(--font-body)" }}>
            <span>Move to</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={pending}
              style={{ font: "400 13px var(--font-body)", padding: 6, border: "1px solid var(--erp-line)", background: "transparent", color: "inherit" }}>
              <option value="">Select a stage…</option>
              {choices.map((s) => <option key={s.key} value={s.key}>{s.label}{s.isTerminal ? ` (${s.terminalKind ?? "ends"})` : ""}</option>)}
            </select>
          </label>
          {ends && <p style={textStyle}>This {ENDS[ends] ?? "ends the application"}.</p>}
          {ends === "rejected" && (
            <label style={{ display: "grid", gap: 4, font: "400 12px var(--font-body)" }}>
              <span>Reason for rejection</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending}
                style={{ font: "400 13px var(--font-body)", padding: 6, border: "1px solid var(--erp-line)", background: "transparent", color: "inherit" }} />
            </label>
          )}
          <label style={{ display: "grid", gap: 4, font: "400 12px var(--font-body)" }}>
            <span>Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} disabled={pending}
              style={{ font: "400 13px var(--font-body)", padding: 6, border: "1px solid var(--erp-line)", background: "transparent", color: "inherit" }} />
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !target} onClick={submit}>
              {pending ? "Moving…" : ends ? `Confirm: ${ends === "rejected" ? "reject" : ends === "hired" ? "mark hired" : "withdraw"}` : "Move"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
              onClick={() => { setOpen(false); setTarget(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <ResultMessage msg={msg} />}
    </div>
  );
}
