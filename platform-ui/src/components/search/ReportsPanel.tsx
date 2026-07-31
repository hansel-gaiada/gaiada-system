"use client";
// SM-22 — the client-facing Reports console tab (design §12 SM-22; replaces the PendingCapability
// stub that stood since SM-11/SM-18). Field names verified against `search.controller.ts`'s SM-10
// reports SELECTs and the new `search-reports.controller.ts` (SM-22) PATCH/approve/preview/deliver
// routes (§4i discipline).
//
// A report LEAVES THE BUILDING once delivered — this panel's own honesty rules mirror the backend's:
//   - the rendered preview ALWAYS shows the exact document that would be filed (same render function
//     the deliver route uses server-side), never an approximation built client-side;
//   - approve/deliver are gated on the ELEVATED `search.report.approve` capability, matching Cerbos's
//     own `approve`/`deliver` actions (module_staff can draft/submit/send-back, nothing more);
//   - a delivered report's markdown/status is never editable again from here — the buttons for a
//     delivered report simply don't render.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  draftReport, editReportNarrative, submitReportForReview, sendReportBackToDraft, approveReport, deliverReport,
} from "@/lib/searchMarketingActions";
import type { SearchReport, ReportRenderPreview } from "@/lib/searchMarketingShared";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", in_review: "In review", approved: "Approved", delivered: "Delivered",
};
const STATUS_TONE: Record<string, string> = {
  draft: "var(--erp-ink-60)", in_review: "var(--erp-warn, #b8860b)", approved: "var(--erp-ok, #3a7a54)", delivered: "var(--erp-ok, #3a7a54)",
};

function StatusChip({ status }: { status: string }) {
  return (
    <span style={{ font: "600 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: STATUS_TONE[status] ?? "var(--erp-ink-60)" }}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function ReportsPanel({
  tenantId, engagementId, reports, selectedReportId, selectedPreview, canManage, canApprove,
}: {
  tenantId: string;
  engagementId: string;
  reports: SearchReport[];
  selectedReportId?: string;
  /** Server-fetched preview for the selected report (null if none selected, or preview unavailable). */
  selectedPreview: ReportRenderPreview | null;
  canManage: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [period, setPeriod] = useState("");
  const [narrativeDraft, setNarrativeDraft] = useState<string | null>(null);

  const selected = reports.find((r) => r.id === selectedReportId) ?? null;
  const editableStatus = selected && (selected.status === "draft" || selected.status === "in_review");
  const narrativeValue = narrativeDraft ?? selected?.narrativeMd ?? "";

  function goTo(reportId: string) {
    router.push(`?reportId=${reportId}`);
  }

  function run(action: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error ?? "Action failed.");
        return;
      }
      onOk?.();
      router.refresh();
    });
  }

  return (
    <div>
      {canManage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!period.trim()) return;
            run(() => draftReport(tenantId, engagementId, { period: period.trim(), kind: "monthly" }), () => setPeriod(""));
          }}
          className="lux-filters"
          style={{ marginBottom: 20, paddingBottom: 16, borderBottom: "0.5px solid var(--erp-hairline)" }}
          aria-label="Draft a new report"
        >
          <label className="lux-filters__field">
            <span>Period (YYYY-MM)</span>
            <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-07" />
          </label>
          <div className="lux-filters__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !period.trim()}>
              {pending ? "Drafting…" : "Draft report"}
            </button>
          </div>
        </form>
      )}

      {error && <p role="alert" style={{ font: "400 13px var(--font-body)", color: "var(--erp-danger, #B5622F)", margin: "0 0 12px" }}>{error}</p>}
      {!error && message && <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ok, #3a7a54)", margin: "0 0 12px" }}>{message}</p>}

      {reports.length === 0 ? (
        <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          No reports drafted yet for this engagement. {canManage ? "Draft one above once the period has data to summarize." : "Ask someone with search.manage to draft one."}
        </p>
      ) : (
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ minWidth: 220, display: "flex", flexDirection: "column", gap: 6 }}>
            {reports.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => goTo(r.id)}
                className="lux-btn lux-btn--sm"
                style={{
                  textAlign: "left", display: "flex", justifyContent: "space-between", gap: 8,
                  background: r.id === selectedReportId ? "var(--erp-surface-raised, rgba(0,0,0,0.04))" : "transparent",
                }}
              >
                <span>{r.period ?? "—"} · {r.kind}</span>
                <StatusChip status={r.status} />
              </button>
            ))}
          </div>

          <div style={{ flex: "1 1 480px", minWidth: 320 }}>
            {!selected ? (
              <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>Select a report on the left.</p>
            ) : (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <strong style={{ font: "600 14px var(--font-body)" }}>{selected.period ?? "—"} · {selected.kind}</strong>
                  <StatusChip status={selected.status} />
                </div>

                {selectedPreview && (selectedPreview.allSimulated || selectedPreview.anySimulated) && (
                  <p
                    role="alert"
                    style={{
                      font: "600 12px var(--font-body)", padding: "8px 10px", marginBottom: 12, borderRadius: 6,
                      color: "var(--erp-danger, #B5622F)", background: "rgba(181,98,47,0.08)",
                    }}
                  >
                    {selectedPreview.allSimulated
                      ? "⚠ Every figure in this report is SIMULATED demo data — do not deliver this as though it were real."
                      : "⚠ This report mixes real and SIMULATED figures — check the preview below before delivering."}
                  </p>
                )}

                <label style={{ display: "block", marginBottom: 12 }}>
                  <span style={{ display: "block", font: "600 11px var(--font-body)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--erp-ink-60)", marginBottom: 6 }}>
                    Narrative
                  </span>
                  <textarea
                    value={narrativeValue}
                    onChange={(e) => setNarrativeDraft(e.target.value)}
                    readOnly={!editableStatus || !canManage}
                    rows={10}
                    style={{ width: "100%", font: "400 13px/1.6 var(--font-body)", padding: 10 }}
                  />
                </label>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
                  {editableStatus && canManage && narrativeDraft !== null && narrativeDraft !== (selected.narrativeMd ?? "") && (
                    <button
                      type="button" className="lux-btn lux-btn--sm" disabled={pending}
                      onClick={() => run(() => editReportNarrative(tenantId, selected.id, narrativeDraft), () => setNarrativeDraft(null))}
                    >
                      Save narrative
                    </button>
                  )}
                  {selected.status === "draft" && canManage && (
                    <button
                      type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
                      onClick={() => run(() => submitReportForReview(tenantId, selected.id))}
                    >
                      Submit for review
                    </button>
                  )}
                  {selected.status === "in_review" && canManage && (
                    <button
                      type="button" className="lux-btn lux-btn--sm" disabled={pending}
                      onClick={() => run(() => sendReportBackToDraft(tenantId, selected.id))}
                    >
                      Send back to draft
                    </button>
                  )}
                  {selected.status === "in_review" && canApprove && (
                    <button
                      type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
                      onClick={() => run(() => approveReport(tenantId, selected.id))}
                    >
                      Approve
                    </button>
                  )}
                  {selected.status === "approved" && canApprove && (
                    <button
                      type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
                      onClick={() =>
                        run(
                          () => deliverReport(tenantId, selected.id),
                          () => setMessage("Delivered — the client-facing report is now filed and (when the engagement has a project) linked as a deliverable."),
                        )
                      }
                    >
                      Deliver
                    </button>
                  )}
                  {!canApprove && (selected.status === "in_review" || selected.status === "approved") && (
                    <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)", alignSelf: "center" }}>
                      Ask someone with search.report.approve to {selected.status === "in_review" ? "approve" : "deliver"} this report.
                    </span>
                  )}
                </div>

                {selected.status === "delivered" && (
                  <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
                    Delivered {selected.deliveredAt ? new Date(selected.deliveredAt).toLocaleString() : ""}. This document is final — it is no longer editable from this console.
                  </p>
                )}

                <div>
                  <span style={{ display: "block", font: "600 11px var(--font-body)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--erp-ink-60)", margin: "16px 0 6px" }}>
                    Client-facing preview{selectedPreview ? ` — ${selectedPreview.filename}` : ""}
                  </span>
                  {!selectedPreview ? (
                    <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>Preview unavailable.</p>
                  ) : (
                    <pre
                      style={{
                        font: "400 12px/1.6 var(--font-mono, monospace)", whiteSpace: "pre-wrap", wordBreak: "break-word",
                        padding: 12, border: "0.5px solid var(--erp-hairline)", borderRadius: 6, maxHeight: 480, overflowY: "auto",
                      }}
                    >
                      {selectedPreview.markdown}
                    </pre>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
