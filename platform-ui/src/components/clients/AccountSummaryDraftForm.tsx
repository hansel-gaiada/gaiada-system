"use client";
import { useActionState } from "react";
import { draftAccountSummaryAction, type ClientReportActionState } from "@/lib/clientReportsActions";
import "./billing/billing.css";
import "./accountSummary.css";

// PV7-07 — "Draft account summary" on the client hub's Reports tab (BFF §56.3).
//
// A month picker (the default is last month, passed in by the page so server and browser agree) and one button. The backend
// freezes the client's figures for that month and writes a first narrative; the draft then shows below for staff to read, edit
// and publish. Asking again for a month that already has a draft opens that draft rather than making a second one, and the
// notice says so. Nothing reaches the client until a person publishes.
//
// Refusals come back in words (`draftSummaryErrorText`): a month that has not started, a month already published (withdraw it
// first), a 403 for a person who may not draft for this client. No capability is mirrored here (Cerbos owns `draft`, which rides
// on the client's owner), the same call as Publish and Withdraw.
export function AccountSummaryDraftForm({ clientId, defaultMonth, maxMonth }: { clientId: string; defaultMonth: string; maxMonth: string }) {
  const [state, draft, pending] = useActionState<ClientReportActionState | null, FormData>(draftAccountSummaryAction, null);
  return (
    <form action={draft} className="as-draft" aria-label="Draft account summary">
      <p className="as-draft__title">Monthly account summary</p>
      <p className="as-note">
        One month of this client&apos;s progress, as their main contacts see it: projects, what was completed, how quickly each side
        answered, and the services results. No money, tasks, time or people. You read and edit it before anything is published.
      </p>
      <input type="hidden" name="clientId" value={clientId} />
      <div className="as-draft__row">
        <label className="lux-field">
          <span className="lux-field__label">Month</span>
          <input
            type="month" name="period" className="lux-field__control" defaultValue={defaultMonth} max={maxMonth} min="2000-01"
            required disabled={pending} aria-invalid={state && !state.ok && state.field === "period" ? true : undefined}
          />
        </label>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Drafting…" : "Draft account summary"}
        </button>
      </div>
      {state && !state.ok && state.error && <p className="bl-msg bl-msg--error" role="alert">{state.error}</p>}
      {state?.ok && state.notice && <p className="bl-msg bl-msg--ok" role="status">{state.notice}</p>}
    </form>
  );
}
