"use client";
import { useActionState, useEffect } from "react";
import { portalStartCheckout, type PortalActionResult } from "@/lib/portalActions";
import { isCheckoutUrl, money } from "@/lib/portal";

// PV5-10 — "Pay online": send the client to the payment provider's own hosted page for what is due on this invoice.
//
// Rendered ONLY when the backend says so (`onlinePayment.available` on the invoice GET): this component never decides
// whether an invoice may be paid online, and it never names an amount to charge (the backend charges what is due).
// Plain words, and no "Card": the provider's page offers the methods; we do not promise one.
//
// After the click the server action opens (or resumes) the checkout and answers its URL; the browser is then sent there.
// A refusal ("nothing is left to pay", "online payment is unavailable right now") is shown as the server wrote it, in a
// `role="alert"`, because the person has just pressed a button and is waiting for exactly that.
export function PortalPayOnline({ invoiceId, amountDue, currency }: { invoiceId: string; amountDue: number; currency: string }) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(portalStartCheckout, null);
  const leaving = state?.ok === true && isCheckoutUrl(state.url);

  useEffect(() => {
    if (state?.ok && isCheckoutUrl(state.url)) window.location.assign(state.url);
  }, [state]);

  return (
    <form action={formAction} className="cp-form">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {state && !state.ok && state.error && <div className="cp-form__error" role="alert">{state.error}</div>}
      {leaving && (
        <div className="cp-form__ok" role="status">
          Taking you to the payment page… If nothing happens, <a href={state.url}>open the payment page</a>.
        </div>
      )}
      <p className="cp-field__hint" id={`pay-online-hint-${invoiceId}`} style={{ margin: 0 }}>
        You&apos;ll pay {money(amountDue, currency)} on our payment provider&apos;s secure page, choosing from the ways it
        offers. Once the payment goes through, this invoice shows as paid, usually within a minute. You don&apos;t need to
        tell us about it.
      </p>
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || leaving}
          aria-describedby={`pay-online-hint-${invoiceId}`}
        >
          {pending ? "Opening the payment page…" : "Pay online"}
        </button>
      </div>
    </form>
  );
}
