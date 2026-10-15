"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PayrollResult } from "@/lib/hrPayrollActions";

// The controls for one payroll run (DW-7f-1). Which buttons appear is a MIRROR of the server's rules
// (status machine + hr.payroll.manage / hr.payroll.approve) — it only hides what the server would
// refuse. It never decides: maker-checker, the high-assurance sign-in and every wrong-status case are
// the server's, and its sentence is shown as given.
//
// Money rule: this component never shows a run as having moved. After any call the page is re-read
// (router.refresh) and the Status column shows what the server holds. The sentence under the buttons
// reports what the server said it did, nothing the client inferred.

export type PayrollRunActionsApi = {
  calculate: (tenantId: string, runId: string) => Promise<PayrollResult>;
  approve: (tenantId: string, runId: string, opts: { overrideUnratified?: boolean; overrideReason?: string }) => Promise<PayrollResult>;
  publish: (tenantId: string, runId: string) => Promise<PayrollResult>;
  markPaid: (tenantId: string, runId: string) => Promise<PayrollResult>;
};

type Panel = null | "approve" | "paid";

export function PayrollRunActions({ tenantId, runId, reference, status, canManage, canApprove, needsOverride, api }: {
  tenantId: string;
  runId: string;
  reference: string;
  status: string;
  canManage: boolean;
  canApprove: boolean;
  /** True when the page cannot confirm the run's statutory parameter set is ratified. Shows the override. */
  needsOverride: boolean;
  api: PayrollRunActionsApi;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const canCalculate = canManage && (status === "draft" || status === "calculated");
  const canApproveNow = canApprove && (status === "calculated" || status === "pending_approval");
  const canPublish = canApprove && (status === "approved" || status === "paid");
  const canMarkPaid = canApprove && status === "approved";

  function run(call: () => Promise<PayrollResult>, onOk?: () => void) {
    startTransition(async () => {
      const res = await call();
      if (res.ok) {
        setMsg({ ok: true, text: res.notice ?? "Done." });
        setPanel(null); setOverride(false); setReason("");
        onOk?.();
      } else {
        setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      }
      // Re-read either way: after a refusal the view may be stale ("run is 'approved'…").
      router.refresh();
    });
  }

  const noActions = !canCalculate && !canApproveNow && !canPublish && !canMarkPaid;
  const overrideMissingReason = panel === "approve" && override && !reason.trim();

  return (
    <div style={{ display: "grid", gap: 8, minWidth: 190 }}>
      {!noActions && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {canCalculate && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
              onClick={() => run(() => api.calculate(tenantId, runId))}>
              {status === "calculated" ? "Recalculate" : "Calculate"}
            </button>
          )}
          {canApproveNow && (
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
              onClick={() => { setPanel(panel === "approve" ? null : "approve"); setMsg(null); }}>
              Approve
            </button>
          )}
          {canPublish && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
              onClick={() => run(() => api.publish(tenantId, runId))}>
              Publish payslips
            </button>
          )}
          {canMarkPaid && (
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
              onClick={() => { setPanel(panel === "paid" ? null : "paid"); setMsg(null); }}>
              Mark paid
            </button>
          )}
        </div>
      )}

      {panel === "approve" && canApproveNow && (
        <div role="group" aria-label={`Approve ${reference}`} style={panelStyle}>
          <p style={textStyle}>
            Approving commits the run: its payslips become final and the run can no longer be recalculated.
          </p>
          {needsOverride && (
            <>
              <p style={{ ...textStyle, color: "var(--erp-warn, #b8860b)" }}>
                This run&apos;s statutory parameter set is not confirmed as ratified. Approving needs an explicit
                override with a reason, recorded permanently on the run.
              </p>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", font: "400 13px var(--font-body)" }}>
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} disabled={pending} />
                <span>Approve against unratified statutory parameters</span>
              </label>
              {override && (
                <label style={{ display: "grid", gap: 4, font: "400 12px var(--font-body)" }}>
                  <span>Reason for the override (required)</span>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} disabled={pending}
                    style={{ font: "400 13px var(--font-body)", padding: 6, border: "1px solid var(--erp-line)", background: "transparent", color: "inherit" }} />
                </label>
              )}
            </>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm"
              disabled={pending || overrideMissingReason}
              onClick={() => run(() => api.approve(tenantId, runId, override ? { overrideUnratified: true, overrideReason: reason.trim() } : {}))}>
              {pending ? "Approving…" : "Confirm approval"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
              onClick={() => { setPanel(null); setOverride(false); setReason(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {panel === "paid" && canMarkPaid && (
        <div role="group" aria-label={`Mark ${reference} paid`} style={panelStyle}>
          <p style={textStyle}>This records that the money left the bank. It cannot be undone from here.</p>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
              onClick={() => run(() => api.markPaid(tenantId, runId))}>
              {pending ? "Recording…" : "Yes, record as paid"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
              onClick={() => setPanel(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p role={msg.ok ? "status" : "alert"}
          style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: msg.ok ? "var(--erp-ink-80, inherit)" : "var(--erp-accent)" }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

const panelStyle = { display: "grid", gap: 8, padding: 10, border: "1px solid var(--erp-line)", borderRadius: 8 } as const;
const textStyle = { margin: 0, font: "400 12px/1.5 var(--font-body)" } as const;
