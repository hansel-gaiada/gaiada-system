"use client";
import { useActionState, useState } from "react";
import { publishClientReportAction, withdrawClientReportAction, type ClientReportActionState } from "@/lib/clientReportsActions";
import { PUBLISH_CONFIRM, WITHDRAW_CONFIRM, WITHDRAW_REASON_MAX, reportActions, withdrawReasonState, type StaffClientReport } from "@/lib/clientReports";
import "./billing/billing.css";

// PV7-04b — Publish (drafts only) and Withdraw (published only) for one report on the client hub's Reports tab.
//
// Both ask first (`window.confirm`, the same idiom as Confirm payment). Withdraw also needs a reason: the button stays
// disabled, with the why beside it, until one is typed (at most WITHDRAW_REASON_MAX characters, the backend's bound). The
// reason is kept for staff and is never in a portal payload.
//
// WHICH BUTTONS: by the report's status only. `lib/rbac.ts` has no client-report capability (Cerbos owns it: publish rides
// on the client's owner, withdraw on the role bundle), so a person the API would refuse still sees the button, and the 403
// comes back in words ("You can't publish reports for this client."), never as a dead click. The server's 409s
// (`not_a_draft`, `report_has_no_file`, `not_published`) and 400s (`reason_required`, `reason_too_long`) are said in plain
// words too (`publishErrorText` / `withdrawErrorText`).
export function ClientReportActions({ report, clientId }: { report: Pick<StaffClientReport, "id" | "status" | "file" | "title"> & { source?: StaffClientReport["source"] }; clientId: string }) {
  const { canPublish, canWithdraw, publishBlockedReason } = reportActions(report);
  const [pubState, publish, publishing] = useActionState<ClientReportActionState | null, FormData>(publishClientReportAction, null);
  const [wdState, withdraw, withdrawing] = useActionState<ClientReportActionState | null, FormData>(withdrawClientReportAction, null);
  const [reason, setReason] = useState("");
  const reasonCheck = withdrawReasonState(reason);
  const reasonId = `withdraw-reason-${report.id}`;
  const hintId = `withdraw-hint-${report.id}`;

  if (!canPublish && !canWithdraw) return null;

  return (
    <div className="bl-payment__decide">
      {canPublish && (
        <form
          action={publish}
          aria-label={`Publish ${report.title}`}
          onSubmit={(e) => { if (!window.confirm(PUBLISH_CONFIRM)) e.preventDefault(); }}
        >
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="reportId" value={report.id} />
          <div className="bl-payment__buttons">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={publishing}>
              {publishing ? "Publishing…" : "Publish"}
            </button>
            {publishBlockedReason && <span className="bl-reason">{publishBlockedReason}</span>}
          </div>
          {pubState && !pubState.ok && pubState.error && <p className="bl-msg bl-msg--error" role="alert">{pubState.error}</p>}
          {pubState?.ok && pubState.notice && <p className="bl-msg bl-msg--ok" role="status">{pubState.notice}</p>}
        </form>
      )}

      {canWithdraw && (
        <form
          action={withdraw}
          aria-label={`Withdraw ${report.title}`}
          onSubmit={(e) => { if (!window.confirm(WITHDRAW_CONFIRM)) e.preventDefault(); }}
        >
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="reportId" value={report.id} />
          <label className="lux-field">
            <span className="lux-field__label">Reason for withdrawing (required)</span>
            <textarea
              id={reasonId} name="reason" className="lux-field__control lux-field__control--textarea"
              value={reason} onChange={(e) => setReason(e.target.value)} maxLength={WITHDRAW_REASON_MAX} disabled={withdrawing}
              aria-describedby={hintId}
            />
            <span id={hintId} className="lux-field__hint">Kept for staff. The client never sees it.</span>
          </label>
          <div className="bl-payment__buttons">
            <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={withdrawing || !reasonCheck.canSubmit}>
              {withdrawing ? "Withdrawing…" : "Withdraw"}
            </button>
            {!reasonCheck.canSubmit && reasonCheck.hint && <span className="bl-reason">{reasonCheck.hint}</span>}
          </div>
          {wdState && !wdState.ok && wdState.error && <p className="bl-msg bl-msg--error" role="alert">{wdState.error}</p>}
          {wdState?.ok && wdState.notice && <p className="bl-msg bl-msg--ok" role="status">{wdState.notice}</p>}
        </form>
      )}
    </div>
  );
}
