"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { requisitionMoves, type StatusMove } from "@/lib/hrRecruitment";
import { RequisitionEditForm, type PersonOption, type RequisitionInitial } from "./RequisitionForm";
import { ResultMessage, panelStyle, textStyle, type Msg } from "./RecruitmentBits";

// The controls for one requisition (DW-7f-2). Which buttons appear MIRRORS the server: submit is the manage
// tier and only for a draft; edit and the status moves are `update`, which a requisition's hiring manager and
// recruiter also hold (the page decides `canUpdate`). Nothing here decides: the server's sentence is shown
// as sent, and the page is re-read after every call.
//
// There is no approve or open button because the backend has none. A submitted requisition waits in the
// approvals queue; it becomes `open` when that approval is decided. The status moves here are the ones a
// PATCH can make (hold, close, cancel, back to draft).

export type RequisitionActionsApi = {
  submit: (tenantId: string, requisitionId: string) => Promise<RecruitmentResult>;
  setStatus: (tenantId: string, requisitionId: string, status: string) => Promise<RecruitmentResult>;
  update: (tenantId: string, requisitionId: string, formData: FormData) => Promise<RecruitmentResult>;
};

export function RequisitionActions({ tenantId, requisitionId, reference, status, canManage, canUpdate, initial, people, api, compact = false }: {
  tenantId: string;
  requisitionId: string;
  reference: string;
  status: string;
  /** hr.recruitment.manage: submitting has no attribute arm on the server. */
  canManage: boolean;
  /** Manage, or attached to the requisition: edit and status moves. */
  canUpdate: boolean;
  initial: RequisitionInitial;
  people: PersonOption[];
  api: RequisitionActionsApi;
  /** List rows: the submit button only. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<StatusMove | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);

  const canSubmit = canManage && status === "draft";
  const canEdit = !compact && canUpdate && (status === "draft" || status === "open" || status === "on_hold");
  const moves = !compact && canUpdate ? requisitionMoves(status) : [];

  function run(call: () => Promise<RecruitmentResult>, link?: (r: RecruitmentResult) => Pick<Msg, "href" | "linkLabel">) {
    startTransition(async () => {
      const res = await call();
      if (res.ok) {
        setMsg({ ok: true, text: res.notice ?? "Done.", ...(link ? link(res) : {}) });
        setConfirming(null);
      } else {
        setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      }
      router.refresh(); // either way: after a refusal the view may be stale ("requisition is 'open', not draft")
    });
  }

  const noActions = !canSubmit && !canEdit && moves.length === 0;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {status === "pending_approval" && !compact && (
        <p style={textStyle}>
          Waiting for approval. It opens when the approval is decided in the{" "}
          <Link href="/approvals" style={{ color: "var(--erp-accent)" }}>approvals queue</Link>.
        </p>
      )}
      {!noActions && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {canSubmit && (
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
              onClick={() => run(() => api.submit(tenantId, requisitionId),
                (r) => (r.approvalId ? { href: `/approvals/${r.approvalId}`, linkLabel: "Open the approval" } : {}))}>
              Submit for approval
            </button>
          )}
          {canEdit && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
              onClick={() => { setEditing(!editing); setMsg(null); }}>
              {editing ? "Close editor" : "Edit"}
            </button>
          )}
          {moves.map((m) => (
            <button key={m.to} type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
              onClick={() => {
                setMsg(null);
                if (m.confirm) setConfirming(confirming?.to === m.to ? null : m);
                else run(() => api.setStatus(tenantId, requisitionId, m.to));
              }}>
              {m.label}
            </button>
          ))}
        </div>
      )}

      {confirming && (
        <div role="group" aria-label={`${confirming.label} ${reference}`} style={panelStyle}>
          <p style={textStyle}>{confirming.confirm}</p>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
              onClick={() => run(() => api.setStatus(tenantId, requisitionId, confirming.to))}>
              {pending ? "Working…" : `Yes, ${confirming.label.toLowerCase()}`}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => setConfirming(null)}>
              Keep it as it is
            </button>
          </div>
        </div>
      )}

      {editing && canEdit && (
        <div style={panelStyle}>
          <RequisitionEditForm
            update={api.update} tenantId={tenantId} requisitionId={requisitionId} initial={initial} people={people}
            onDone={(m) => { setEditing(false); if (m.text) setMsg(m); }}
          />
        </div>
      )}

      {msg && <ResultMessage msg={msg} />}
    </div>
  );
}
