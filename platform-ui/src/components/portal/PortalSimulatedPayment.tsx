"use client";
import { useActionState, useEffect } from "react";
import { portalSimulatedPaymentAct, type PortalActionResult } from "@/lib/portalActions";
import { SIMULATED_ACTIONS } from "@/lib/portal";

// PV-D41 — the three choices on the SIMULATED hosted payment page (review stage). Each is a submit button of one form,
// so the chosen action travels as the button's name/value. After the BFF records it, the browser goes back to the
// invoice (`?checkout=finished`), exactly as the real provider's page would send the payer back.
export function PortalSimulatedPayment({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(portalSimulatedPaymentAct, null);
  const leaving = state?.ok === true && typeof state.url === "string";

  useEffect(() => {
    if (state?.ok && state.url) window.location.assign(state.url);
  }, [state]);

  return (
    <form action={formAction} className="cp-form">
      <input type="hidden" name="orderId" value={orderId} />
      {state && !state.ok && state.error && <div className="cp-form__error" role="alert">{state.error}</div>}
      {leaving && (
        <div className="cp-form__ok" role="status">
          Recorded. Taking you back to your invoice… If nothing happens, <a href={state.url}>open your invoice</a>.
        </div>
      )}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {SIMULATED_ACTIONS.map((a, i) => (
          <button
            key={a.action}
            type="submit"
            name="action"
            value={a.action}
            className={i === 0 ? "btn btn-primary" : "btn"}
            disabled={pending || leaving}
          >
            {a.label}
          </button>
        ))}
      </div>
    </form>
  );
}
