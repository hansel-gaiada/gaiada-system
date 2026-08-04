"use client";
import { useActionState } from "react";
import { portalRecordPayment, type PortalActionResult } from "@/lib/portalActions";
import { money } from "@/lib/portal";

// CP-13 — "I've paid this" for the client.
//
// ── WHY THIS IS A CLIENT COMPONENT WITH `useActionState` AND NOT A PLAIN FORM ACTION ──────────────
// The server refuses this write for several reasons a client can act on: the amount exceeds the
// outstanding balance, the date is in the future, the receipt is too large, the invoice is cancelled. A
// plain `<form action={...}>` with a void action would swallow every one of those and re-render the page
// unchanged, which reads as "the button is broken" on the single most consequential thing a client does
// here. `useActionState` carries the server's own message back and puts it above the form.
//
// ── WHAT THIS FORM DOES NOT CLAIM ────────────────────────────────────────────────────────────────
// It never says "paid". It records a CLAIM that finance verifies — the row lands `status='pending'`, the
// balance does not move, and the invoice's status is untouched (rules 2-3 in the BFF's header). The copy
// says so plainly, because a client who believes the portal has settled their invoice will not answer the
// reminder that follows.
export function PortalPaymentForm({ invoiceId, balance, currency }: {
  invoiceId: string;
  balance: number;
  currency: string;
}) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(
    portalRecordPayment,
    null,
  );

  if (state?.ok) {
    return (
      <div className="cp-form__ok" role="status">
        Thank you — we&apos;ve recorded your payment and our finance team will confirm it against our bank
        statement. Your balance updates once that&apos;s done.
      </div>
    );
  }

  return (
    <form action={formAction} className="cp-form">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {state?.error && (
        // `role="alert"` so the refusal is announced immediately — the person has just pressed a button
        // and is waiting for exactly this.
        <div className="cp-form__error" role="alert">{state.error}</div>
      )}

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="pay-amount">Amount you paid</label>
        <input
          id="pay-amount"
          className="cp-input"
          name="amount"
          type="number"
          // `step="any"` rather than "0.01": IDR has no sub-units and a 0.01 step turns every whole-rupiah
          // amount into a browser validation warning.
          step="any"
          min="0"
          required
          // Pre-filled with the full balance, which is what a client pays in the overwhelming majority of
          // cases. `defaultValue`, not `value` — this is an uncontrolled input and they must be able to
          // change it for a partial payment.
          defaultValue={balance > 0 ? balance : undefined}
          disabled={pending}
          aria-describedby="pay-amount-hint"
        />
        <span className="cp-field__hint" id="pay-amount-hint">
          Outstanding: {money(balance, currency)}. Enter less if this was a partial payment.
        </span>
      </div>

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="pay-date">Date of transfer</label>
        <input id="pay-date" className="cp-input" name="paidOn" type="date" required disabled={pending} />
      </div>

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="pay-method">How you paid</label>
        <select id="pay-method" className="cp-select" name="method" defaultValue="bank_transfer" disabled={pending}>
          <option value="bank_transfer">Bank transfer</option>
          <option value="card">Card</option>
          <option value="cash">Cash</option>
          <option value="other">Other</option>
        </select>
      </div>

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="pay-ref">Reference number</label>
        <input id="pay-ref" className="cp-input" name="reference" type="text" maxLength={200} disabled={pending}
               aria-describedby="pay-ref-hint" />
        <span className="cp-field__hint" id="pay-ref-hint">
          The transaction reference from your bank, if you have it — it&apos;s what lets us match the
          payment quickly.
        </span>
      </div>

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="pay-proof">Receipt (optional)</label>
        <input
          id="pay-proof"
          className="cp-input"
          name="proof"
          type="file"
          // Advisory only — the server enforces the real limit and the content type. `accept` narrows the
          // OS picker; it is not a validation.
          accept="image/*,application/pdf"
          disabled={pending}
          aria-describedby="pay-proof-hint"
        />
        <span className="cp-field__hint" id="pay-proof-hint">A photo or PDF of the transfer slip. Up to 10 MB.</span>
      </div>

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="pay-note">Anything we should know?</label>
        <textarea id="pay-note" className="cp-textarea" name="note" maxLength={1000} disabled={pending} />
      </div>

      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Recording…" : "Record this payment"}
        </button>
        <p style={{ margin: "10px 0 0", font: "400 12px/1.55 var(--font-body)", color: "var(--ink-subtle)" }}>
          This tells our finance team you&apos;ve paid. It doesn&apos;t mark the invoice as settled — we
          confirm it against our bank statement first, and you&apos;ll see the balance change then.
        </p>
      </div>
    </form>
  );
}
