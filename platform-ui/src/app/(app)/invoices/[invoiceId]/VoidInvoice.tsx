"use client";
// PV5-09 — void an ISSUED invoice, behind a confirm step.
//
// Voiding posts a full credit note in the ledger and cannot be undone, so the button does not void: it opens a panel that
// says what will happen, asks for a reason (kept on the record, at least four characters, which is also the server's
// rule) and only then offers "Confirm void". The confirm is a panel in the page rather than `window.confirm`, so the
// reason has somewhere to be typed, a screen reader reads the warning, and a refusal appears next to the button that
// produced it. Every refusal the API names (never issued, money already applied, a payment claim still pending) is shown
// in plain words (lib/billingView.ts `voidErrorText`).
//
// Only offered for an issued invoice that is still `sent`. Whether THIS person may void is Cerbos' call
// (`invoice`/`void_issued`: company administrators and owners): a 403 comes back as a sentence.
import { useActionState, useId, useState } from "react";
import { voidInvoiceAction, type InvoiceActionState } from "@/lib/invoiceActions";
import { voidReasonOk } from "@/lib/billingView";
import "@/components/billing/billing-screens.css";

export function VoidInvoice({ invoiceId, invoiceNo }: { invoiceId: string; invoiceNo: string | null }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, formAction, pending] = useActionState<InvoiceActionState | null, FormData>(
    voidInvoiceAction.bind(null, invoiceId),
    null,
  );
  const reasonId = useId();
  const warnId = useId();

  if (state?.ok) {
    return <p className="bs-ok" role="status">Voided. A credit note for the full amount was posted in the ledger.</p>;
  }

  return (
    <div className="bs-void">
      {!open ? (
        <div className="bs-actions">
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)} aria-expanded={false}>
            Void this invoice…
          </button>
          <span className="bs-note">Reverses it in the books. Use it for an invoice issued in error.</span>
        </div>
      ) : (
        <form action={formAction} className="bs-void__panel" aria-label="Confirm voiding this invoice">
          <p id={warnId}>
            Void {invoiceNo ? <strong>{invoiceNo}</strong> : "this invoice"}? A credit note for the full amount is posted in the ledger and the
            invoice reads Void. This cannot be undone. An invoice with money already applied to it cannot be voided here:
            raise a credit note in Finance instead.
          </p>
          <div className="bs-field">
            <label className="bs-field__label" htmlFor={reasonId}>Why is it being voided?</label>
            <textarea
              id={reasonId} name="reason" required minLength={4} maxLength={500} value={reason} disabled={pending}
              onChange={(e) => setReason(e.target.value)} aria-describedby={warnId}
            />
            <span className="bs-field__hint">Kept on the invoice's record. At least four characters.</span>
          </div>
          {state?.error && <p className="bs-error" role="alert">{state.error}</p>}
          <div className="bs-actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !voidReasonOk(reason)}>
              {pending ? "Voiding…" : "Confirm void"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setOpen(false); setReason(""); }} disabled={pending}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
