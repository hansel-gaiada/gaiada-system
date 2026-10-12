"use client";
// IAM-GAP-01/02 — the invoice status-transition controls, client-side so a refusal (self-approval,
// a stale precondition) renders as a real message next to the button that produced it. Every
// server action here returns `InvoiceActionState` via `useActionState` rather than the old
// fire-and-forget `<form action={fn}>` pattern, which swallowed every error silently.
//
// PV5-04 (PV-D7): "Mark sent" became ISSUE (numbered, posted to the ledger, frozen in one step on the server), and
// "Mark paid" is gone: paid follows from confirmed payments. When issuing is refused, the server's whole blocker list
// is shown, so staff see everything that is missing at once. The full issued view is PV5-09.
import { useActionState } from "react";
import {
  approveInvoiceAction,
  issueInvoiceAction,
  type InvoiceActionState,
} from "@/lib/invoiceActions";
import type { InvoiceStatus } from "@/lib/invoice";
import { Button, Toast } from "@/components/ui";

type BoundAction = (invoiceId: string, prev: InvoiceActionState | null, formData?: FormData) => Promise<InvoiceActionState>;

function StatusButton({
  invoiceId, action, label, pendingLabel,
}: { invoiceId: string; action: BoundAction; label: string; pendingLabel: string }) {
  const bound = action.bind(null, invoiceId);
  const [state, formAction, pending] = useActionState<InvoiceActionState | null, FormData>(bound, null);
  return (
    <form action={formAction}>
      <Button type="submit" size="sm" disabled={pending}>{pending ? pendingLabel : label}</Button>
      {state?.error && !state.blockers && <Toast message={state.error} />}
      {state?.blockers && state.blockers.length > 0 && (
        <div role="alert" className="sys-empty-note" style={{ margin: "6px 0 0", maxWidth: 360, textAlign: "left" }}>
          <p style={{ margin: "0 0 4px" }}>{state.error}</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {state.blockers.map((b) => <li key={b.code + b.message}>{b.message}</li>)}
          </ul>
        </div>
      )}
    </form>
  );
}

export function InvoiceActions({
  invoiceId,
  status,
  canApprove,
  canBill,
  isCreator,
  legacyUnknownCreator,
  invoiceNo,
}: {
  invoiceId: string;
  status: InvoiceStatus;
  /** Holds `invoice.approve` (or is elevated) AND is not the invoice's own creator AND the
   *  creator is known (or the viewer is elevated, who alone can still reach a legacy row). */
  canApprove: boolean;
  /** Holds `company.manage` or `invoice.approve` (or is elevated): who is offered Issue. Cerbos `invoice`/`issue`
   *  decides; a refusal renders as a message. */
  canBill: boolean;
  isCreator: boolean;
  legacyUnknownCreator: boolean;
  /** PV5-04: set once issued. */
  invoiceNo?: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 8 }}>
        {status === "draft" && canApprove && (
          <StatusButton invoiceId={invoiceId} action={approveInvoiceAction} label="Approve" pendingLabel="Approving…" />
        )}
        {status === "approved" && canBill && (
          <StatusButton invoiceId={invoiceId} action={issueInvoiceAction} label="Issue" pendingLabel="Issuing…" />
        )}
      </div>
      {/* State-machine legibility (IAM-GAP-01): explain why draft has no send/pay control, and — the
          honest, specific case the ticket calls out — why an invoice's own creator sees no Approve
          button at all rather than a 403 after the fact. */}
      {status === "draft" && isCreator && (
        <p className="sys-empty-note" style={{ margin: 0, maxWidth: 320, textAlign: "right" }}>
          You raised this invoice — a different approver must sign off before it can move forward.
        </p>
      )}
      {status === "draft" && !isCreator && legacyUnknownCreator && (
        <p className="sys-empty-note" style={{ margin: 0, maxWidth: 320, textAlign: "right" }}>
          This invoice predates creator tracking, so only a platform administrator can approve it.
        </p>
      )}
      {status === "draft" && !isCreator && !legacyUnknownCreator && !canApprove && (
        <p className="sys-empty-note" style={{ margin: 0, maxWidth: 320, textAlign: "right" }}>
          Awaiting approval from a manager or company administrator.
        </p>
      )}
      {status === "draft" && (
        <p className="sys-empty-note" style={{ margin: 0, maxWidth: 320, textAlign: "right" }}>
          Draft invoices must be approved before they can be issued.
        </p>
      )}
      {status === "approved" && (
        <p className="sys-empty-note" style={{ margin: 0, maxWidth: 320, textAlign: "right" }}>
          Approved — ready to issue. Issuing gives it its number and records it in the books.
        </p>
      )}
      {status === "sent" && (
        <p className="sys-empty-note" style={{ margin: 0, maxWidth: 320, textAlign: "right" }}>
          {invoiceNo ? `Issued as ${invoiceNo}.` : "Sent."} It is marked paid when confirmed payments cover it.
        </p>
      )}
    </div>
  );
}
