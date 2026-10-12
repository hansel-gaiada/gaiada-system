"use client";
import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import { decidePaymentAction, type BillingActionState } from "@/lib/contractsActions";
import { paymentDecisionState, type InvoicePayment } from "@/lib/contracts";
import { formatDate, money } from "@/lib/format";
import { ClientVisibilityMarker } from "../ClientVisibilityMarker";
import "./billing.css";

// PV3-08 — one payment the client says they made, with Confirm and Reject.
//
// A payment here is a CLAIM. Confirming is what makes the money real: only confirmed rows count toward a
// balance, and it can move the invoice to paid. Rejecting needs a reason, which the client reads in their
// portal (it is the only way they learn whether to re-send the transfer or query the reference), so the
// Reject button stays disabled, with its reason beside it, until one is typed.
//
// The person who recorded a payment cannot confirm it. The server refuses with a 403 and a message; the
// row shows that message in full ("you recorded this payment"), because a bare "forbidden" would read as a
// bug. The browser does not pre-empt it: it does not know who recorded the row relative to the viewer, and
// guessing from an id here would be a second copy of a rule the server owns.
const METHOD_LABEL: Record<string, string> = { bank_transfer: "Bank transfer", card: "Card", cash: "Cash", other: "Other" };

export function PaymentRow({ payment, clientId }: { payment: InvoicePayment; clientId: string }) {
  const [state, action, pending] = useActionState<BillingActionState | null, FormData>(decidePaymentAction, null);
  const [reason, setReason] = useState("");
  // Which button submitted. Set imperatively on click, before the browser's own submit follows it, rather than
  // read from the submitter (`name`/`value` on the button): FormData's submitter argument is not available in
  // every environment this runs in, and a hidden input is the same on all of them.
  const decision = useRef<HTMLInputElement>(null);
  const reject = paymentDecisionState("reject", reason);
  const reasonId = `reject-reason-${payment.id}`;
  const hintId = `reject-hint-${payment.id}`;

  return (
    <li className="bl-payment" style={{ listStyle: "none" }}>
      <div className="bl-payment__head">
        <p className="bl-payment__amount">{money(payment.amount, payment.currency)}</p>
        <span className="bl-payment__meta">
          Paid {formatDate(payment.paidOn)}
          {/* PV3-09: through the payment's invoice (BFF §22d), from the backend's `clientVisible`. */}
          <ClientVisibilityMarker clientVisible={payment.clientVisible} />
        </span>
      </div>
      <p className="bl-payment__meta">
        {[
          METHOD_LABEL[payment.method ?? ""] ?? payment.method,
          payment.reference ? `Ref ${payment.reference}` : "No reference given",
          payment.proofFileId ? "Proof of payment attached" : "No proof attached",
        ].filter(Boolean).join(" · ")}
        {" · "}
        <Link href={`/invoices/${payment.invoiceId}`}>Invoice ({money(payment.invoiceTotal, payment.currency)}, {payment.invoiceStatus})</Link>
      </p>
      {payment.note && <p className="bl-payment__meta">Client&apos;s note: {payment.note}</p>}

      <form action={action} className="bl-payment__decide" aria-label="Decide this payment">
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="paymentId" value={payment.id} />
        <input type="hidden" name="decision" defaultValue="" ref={decision} />
        <label className="lux-field">
          <span className="lux-field__label">Reason (required to reject)</span>
          <textarea
            id={reasonId} name="reason" className="lux-field__control lux-field__control--textarea"
            value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} disabled={pending}
            aria-describedby={hintId}
          />
          <span id={hintId} className="lux-field__hint">The client sees this in their portal.</span>
        </label>
        <div className="bl-payment__buttons">
          <button
            type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
            onClick={(e) => {
              if (!window.confirm("Confirm this payment? It counts toward the invoice balance and can mark the invoice paid.")) { e.preventDefault(); return; }
              if (decision.current) decision.current.value = "confirm";
            }}
          >
            {pending ? "Working…" : "Confirm payment"}
          </button>
          <button
            type="submit" className="lux-btn lux-btn--ghost lux-btn--sm"
            disabled={pending || !reject.canSubmit}
            onClick={() => { if (decision.current) decision.current.value = "reject"; }}
          >
            Reject
          </button>
          {!reject.canSubmit && <span className="bl-reason">{reject.reason}</span>}
        </div>
      </form>
      {state && !state.ok && state.error && <p className="bl-msg bl-msg--error" role="alert">{state.error}</p>}
      {state?.ok && state.notice && <p className="bl-msg bl-msg--ok" role="status">{state.notice}</p>}
    </li>
  );
}
