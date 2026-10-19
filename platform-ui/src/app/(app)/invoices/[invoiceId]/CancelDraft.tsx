"use client";
// DW-10f-3b (BFF §61.5, §61.9) — "Cancel draft", behind a confirm step.
//
// A draft or approved invoice that was NEVER ISSUED is cancelled with `PATCH {status: 'void'}`. Nothing was posted to the books, so
// there is no credit note and no reason to type (that is `VoidInvoice`, for an issued invoice). What cancelling does is release
// the instalments the draft claimed: they go back to the payment schedule, due again and ready to invoice. The answer says how many.
//
// The confirm is a panel in the page, not `window.confirm`, so the consequence is read before the click and the answer appears next
// to the button that produced it. The component stays on the page after the invoice turns `void` (the page keeps the card for an
// unissued void invoice) so the sentence "N instalments go back to the payment schedule" is not lost when the page re-renders.
import { useActionState, useId, useState } from "react";
import { cancelDraftInvoiceAction, type InvoiceActionState } from "@/lib/invoiceActions";
import "@/components/billing/billing-screens.css";

export function CancelDraft({ invoiceId, status, instalments }: { invoiceId: string; status: string; instalments: number }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<InvoiceActionState | null, FormData>(cancelDraftInvoiceAction.bind(null, invoiceId), null);
  const warnId = useId();

  if (state?.ok) return <p className="bs-ok" role="status">{state.notice}</p>;
  if (status === "void") return <p className="bs-note">This draft was cancelled. It never reached the books.</p>;

  return (
    <div className="bs-void">
      {!open ? (
        <div className="bs-actions">
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)} aria-expanded={false}>
            Cancel draft…
          </button>
          <span className="bs-note">
            {instalments > 0 ? "The instalments go back to the payment schedule." : "Marks the draft void. Nothing is posted to the books."}
          </span>
        </div>
      ) : (
        <form action={formAction} className="bs-void__panel" aria-label="Confirm cancelling this draft">
          <p id={warnId}>
            Cancel this draft? {instalments > 0
              ? <>The {instalments === 1 ? "instalment" : `${instalments} instalments`} on it go back to the payment schedule, due again and ready to invoice. </>
              : "It is marked void. "}
            Nothing was posted to the books, because it was never issued.{instalments > 0 ? " A cancelled draft cannot be brought back: draft a new one from the schedule." : ""}
          </p>
          {state?.error && <p className="bs-error" role="alert">{state.error}</p>}
          <div className="bs-actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} aria-describedby={warnId}>
              {pending ? "Cancelling…" : "Cancel this draft"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>
              Keep the draft
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
